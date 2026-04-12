import os
import re
import json
import uuid
import base64
import sqlite3
from pathlib import Path

from flask import Flask, request, jsonify, send_from_directory, render_template, after_this_request
from dotenv import load_dotenv
import anthropic
from io import BytesIO
from PIL import Image

MAX_API_IMAGE_BYTES = 3_700_000  # ~3.7MB raw = ~4.9MB base64, under Claude's 5MB limit

load_dotenv(Path(__file__).parent / ".env", override=True)

app = Flask(__name__, static_folder="static", template_folder="templates")

UPLOAD_DIR = Path(__file__).parent / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)
DB_PATH = Path(__file__).parent / "listings.db"

ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "webp", "gif"}


@app.after_request
def add_cors_headers(response):
    """Allow the Chrome extension to access the API."""
    origin = request.headers.get("Origin", "")
    if origin.startswith("chrome-extension://") or "localhost" in origin:
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Headers"] = "Content-Type"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
    return response

DEFAULT_CATEGORIES = ["Tops", "Bottoms", "Dresses", "Shoes"]

DEFAULT_PROMPT = (
    "You are a Facebook Marketplace listing assistant for clothing items. "
    "Analyze the clothing in these photos and provide:\n\n"
    "1. **name**: A short, compelling listing title (e.g. 'Vintage Levi's 501 Jeans - Size 32'). "
    "Include brand if visible, type of clothing, notable features, and size if visible.\n\n"
    "2. **description**: A 2-4 sentence Facebook Marketplace description. "
    "Mention condition, material/fabric if identifiable, fit, color, and any standout details. "
    "Keep it casual and appealing to buyers.\n\n"
    "3. **hashtags**: 8-12 relevant hashtags for visibility (e.g. #vintage #levis #denim #jeans #mensfashion). "
    "Include brand, style, category, and trending clothing hashtags.\n\n"
    "4. **filename**: A short descriptive filename for the photos (e.g. 'vintage_levis_501_jeans'). "
    "Lowercase, underscores, no extension.\n\n"
    "Respond in JSON only, no markdown fencing:\n"
    '{"name": "...", "description": "...", "hashtags": "...", "filename": "..."}'
)


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db():
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS batches (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL DEFAULT '',
            total_cost REAL NOT NULL DEFAULT 0,
            item_count INTEGER NOT NULL DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS listings (
            id TEXT PRIMARY KEY,
            batch_id TEXT,
            name TEXT NOT NULL DEFAULT '',
            description TEXT NOT NULL DEFAULT '',
            hashtags TEXT NOT NULL DEFAULT '',
            category TEXT NOT NULL DEFAULT '',
            cost REAL NOT NULL DEFAULT 0,
            cost_locked INTEGER NOT NULL DEFAULT 0,
            list_price REAL NOT NULL DEFAULT 0,
            sale_price REAL NOT NULL DEFAULT 0,
            shipping_cost REAL NOT NULL DEFAULT 0,
            posted INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (batch_id) REFERENCES batches(id) ON DELETE SET NULL
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS photos (
            id TEXT PRIMARY KEY,
            listing_id TEXT NOT NULL,
            original_filename TEXT NOT NULL,
            stored_filename TEXT NOT NULL,
            sort_order INTEGER DEFAULT 0,
            FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE CASCADE
        );
    """)
    conn.commit()
    conn.close()


init_db()


def migrate_db():
    """Add new columns to existing databases."""
    conn = get_db()
    cursor = conn.execute("PRAGMA table_info(listings)")
    columns = [row[1] for row in cursor.fetchall()]
    migrations = {
        "batch_id": "ALTER TABLE listings ADD COLUMN batch_id TEXT",
        "cost": "ALTER TABLE listings ADD COLUMN cost REAL NOT NULL DEFAULT 0",
        "cost_locked": "ALTER TABLE listings ADD COLUMN cost_locked INTEGER NOT NULL DEFAULT 0",
        "category": "ALTER TABLE listings ADD COLUMN category TEXT NOT NULL DEFAULT ''",
        "list_price": "ALTER TABLE listings ADD COLUMN list_price REAL NOT NULL DEFAULT 0",
        "sale_price": "ALTER TABLE listings ADD COLUMN sale_price REAL NOT NULL DEFAULT 0",
        "shipping_cost": "ALTER TABLE listings ADD COLUMN shipping_cost REAL NOT NULL DEFAULT 0",
        "posted": "ALTER TABLE listings ADD COLUMN posted INTEGER NOT NULL DEFAULT 0",
    }
    for col, sql in migrations.items():
        if col not in columns:
            conn.execute(sql)
    conn.commit()
    conn.close()


migrate_db()


def rebalance_batch_costs(conn, batch_id):
    """Redistribute costs among unlocked items so they sum to batch total."""
    batch = conn.execute("SELECT * FROM batches WHERE id = ?", (batch_id,)).fetchone()
    if not batch:
        return
    total = batch["total_cost"]
    locked_sum = conn.execute(
        "SELECT COALESCE(SUM(cost), 0) FROM listings WHERE batch_id = ? AND cost_locked = 1",
        (batch_id,),
    ).fetchone()[0]
    unlocked_count = conn.execute(
        "SELECT COUNT(*) FROM listings WHERE batch_id = ? AND cost_locked = 0",
        (batch_id,),
    ).fetchone()[0]
    if unlocked_count == 0:
        return
    remaining = max(total - locked_sum, 0)
    per_item = round(remaining / unlocked_count, 2)
    conn.execute(
        "UPDATE listings SET cost = ? WHERE batch_id = ? AND cost_locked = 0",
        (per_item, batch_id),
    )


def get_prompt():
    conn = get_db()
    row = conn.execute("SELECT value FROM settings WHERE key = 'prompt'").fetchone()
    conn.close()
    if row:
        return row["value"]
    return DEFAULT_PROMPT


def get_categories():
    conn = get_db()
    row = conn.execute("SELECT value FROM settings WHERE key = 'categories'").fetchone()
    conn.close()
    if row:
        return json.loads(row["value"])
    return DEFAULT_CATEGORIES


def allowed_file(filename):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in ALLOWED_EXTENSIONS


def sanitize_filename(name):
    name = re.sub(r'[^\w\s-]', '', name).strip()
    name = re.sub(r'[\s]+', '_', name)
    return name[:80]


def shrink_image_if_needed(filepath):
    """Resize image if it exceeds the API size limit. Overwrites the file in place."""
    if filepath.stat().st_size <= MAX_API_IMAGE_BYTES:
        return
    img = Image.open(filepath)
    img.exif = None
    quality = 85
    while quality >= 30:
        buf = BytesIO()
        if img.mode in ("RGBA", "P"):
            img = img.convert("RGB")
        img.save(buf, format="JPEG", quality=quality)
        if buf.tell() <= MAX_API_IMAGE_BYTES:
            with open(filepath, "wb") as f:
                f.write(buf.getvalue())
            return
        quality -= 10
    scale = 0.7
    while scale >= 0.2:
        resized = img.resize((int(img.width * scale), int(img.height * scale)), Image.LANCZOS)
        buf = BytesIO()
        resized.save(buf, format="JPEG", quality=60)
        if buf.tell() <= MAX_API_IMAGE_BYTES:
            with open(filepath, "wb") as f:
                f.write(buf.getvalue())
            return
        scale -= 0.1


def encode_image_base64(filepath):
    with open(filepath, "rb") as f:
        return base64.standard_b64encode(f.read()).decode("utf-8")


def get_media_type(filename):
    ext = filename.rsplit(".", 1)[1].lower()
    return {
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "png": "image/png",
        "webp": "image/webp",
        "gif": "image/gif",
    }.get(ext, "image/jpeg")


def analyze_images_with_ai(image_paths):
    """Send images to Claude to get name, description, and hashtags."""
    client = anthropic.Anthropic()

    content = []
    for path in image_paths:
        shrink_image_if_needed(path)
        media_type = get_media_type(str(path))
        data = encode_image_base64(path)
        content.append({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": media_type,
                "data": data,
            }
        })

    content.append({
        "type": "text",
        "text": get_prompt(),
    })

    message = client.messages.create(
        model="claude-sonnet-4-6",
        max_tokens=1024,
        messages=[{"role": "user", "content": content}],
    )

    raw = message.content[0].text.strip()
    if raw.startswith("```"):
        raw = re.sub(r'^```(?:json)?\s*', '', raw)
        raw = re.sub(r'\s*```$', '', raw)
    return json.loads(raw)


# --- Routes ---

@app.route("/")
def index():
    return render_template("index.html")


# --- Prompt Routes ---

@app.route("/api/prompt", methods=["GET"])
def get_prompt_api():
    return jsonify({"prompt": get_prompt(), "default": DEFAULT_PROMPT})


@app.route("/api/prompt", methods=["PUT"])
def save_prompt_api():
    data = request.json
    prompt = data.get("prompt", "").strip()
    if not prompt:
        return jsonify({"error": "Prompt cannot be empty"}), 400
    if len(prompt) > 1000:
        return jsonify({"error": "Prompt cannot exceed 1000 characters"}), 400
    conn = get_db()
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('prompt', ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (prompt,),
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/prompt", methods=["DELETE"])
def reset_prompt_api():
    conn = get_db()
    conn.execute("DELETE FROM settings WHERE key = 'prompt'")
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "prompt": DEFAULT_PROMPT})


# --- Theme Routes ---

@app.route("/api/theme", methods=["GET"])
def get_theme_api():
    conn = get_db()
    row = conn.execute("SELECT value FROM settings WHERE key = 'theme'").fetchone()
    conn.close()
    if row:
        return jsonify(json.loads(row["value"]))
    return jsonify({"theme": "dark", "font": "Inter"})


@app.route("/api/theme", methods=["PUT"])
def save_theme_api():
    data = request.json
    conn = get_db()
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('theme', ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (json.dumps(data),),
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# --- Category Routes ---

@app.route("/api/categories", methods=["GET"])
def get_categories_api():
    return jsonify({"categories": get_categories(), "default": DEFAULT_CATEGORIES})


@app.route("/api/categories", methods=["PUT"])
def save_categories_api():
    data = request.json
    categories = data.get("categories", [])
    if not categories:
        return jsonify({"error": "Must have at least one category"}), 400
    conn = get_db()
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('categories', ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (json.dumps(categories),),
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/categories", methods=["DELETE"])
def reset_categories_api():
    conn = get_db()
    conn.execute("DELETE FROM settings WHERE key = 'categories'")
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "categories": DEFAULT_CATEGORIES})


# --- Batch Routes ---

@app.route("/api/batches", methods=["GET"])
def get_batches():
    conn = get_db()
    batches = conn.execute("SELECT * FROM batches ORDER BY created_at DESC").fetchall()
    result = []
    for b in batches:
        listings = conn.execute(
            "SELECT * FROM listings WHERE batch_id = ?", (b["id"],)
        ).fetchall()
        assigned_cost = sum(l["cost"] for l in listings)
        result.append({
            "id": b["id"],
            "name": b["name"],
            "total_cost": b["total_cost"],
            "item_count": b["item_count"],
            "listing_count": len(listings),
            "assigned_cost": round(assigned_cost, 2),
            "created_at": b["created_at"],
        })
    conn.close()
    return jsonify(result)


@app.route("/api/batches", methods=["POST"])
def create_batch():
    data = request.json
    batch_id = uuid.uuid4().hex[:12]
    name = data.get("name", "").strip() or f"Haul {batch_id[:6]}"
    total_cost = float(data.get("total_cost", 0))
    item_count = int(data.get("item_count", 1))
    if item_count < 1:
        item_count = 1
    conn = get_db()
    conn.execute(
        "INSERT INTO batches (id, name, total_cost, item_count) VALUES (?, ?, ?, ?)",
        (batch_id, name, total_cost, item_count),
    )
    conn.commit()
    conn.close()
    return jsonify({"id": batch_id, "name": name, "total_cost": total_cost, "item_count": item_count})


@app.route("/api/batches/<batch_id>", methods=["PUT"])
def update_batch(batch_id):
    data = request.json
    conn = get_db()
    conn.execute(
        "UPDATE batches SET name = ?, total_cost = ?, item_count = ? WHERE id = ?",
        (data.get("name", ""), float(data.get("total_cost", 0)), int(data.get("item_count", 1)), batch_id),
    )
    rebalance_batch_costs(conn, batch_id)
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/batches/<batch_id>", methods=["DELETE"])
def delete_batch(batch_id):
    conn = get_db()
    conn.execute("UPDATE listings SET batch_id = NULL WHERE batch_id = ?", (batch_id,))
    conn.execute("DELETE FROM batches WHERE id = ?", (batch_id,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# --- Listing Routes ---

def listing_to_dict(listing, photos):
    return {
        "id": listing["id"],
        "batch_id": listing["batch_id"],
        "name": listing["name"],
        "description": listing["description"],
        "hashtags": listing["hashtags"],
        "category": listing["category"],
        "cost": listing["cost"],
        "cost_locked": bool(listing["cost_locked"]),
        "list_price": listing["list_price"],
        "sale_price": listing["sale_price"],
        "shipping_cost": listing["shipping_cost"],
        "posted": bool(listing["posted"]),
        "created_at": listing["created_at"],
        "photos": [
            {
                "id": p["id"],
                "original_filename": p["original_filename"],
                "stored_filename": p["stored_filename"],
                "url": f"/uploads/{p['stored_filename']}",
            }
            for p in photos
        ],
    }


@app.route("/api/listings", methods=["GET"])
def get_listings():
    conn = get_db()
    listings = conn.execute(
        "SELECT * FROM listings ORDER BY created_at DESC"
    ).fetchall()

    result = []
    for listing in listings:
        photos = conn.execute(
            "SELECT * FROM photos WHERE listing_id = ? ORDER BY sort_order",
            (listing["id"],)
        ).fetchall()
        result.append(listing_to_dict(listing, photos))
    conn.close()
    return jsonify(result)


@app.route("/api/listings", methods=["POST"])
def create_listing():
    """Upload photos, analyze with AI, create listing."""
    files = request.files.getlist("photos")
    if not files or all(f.filename == "" for f in files):
        return jsonify({"error": "No photos uploaded"}), 400

    temp_paths = []
    original_names = []
    for f in files:
        if f and allowed_file(f.filename):
            ext = f.filename.rsplit(".", 1)[1].lower()
            temp_name = f"{uuid.uuid4().hex}.{ext}"
            temp_path = UPLOAD_DIR / temp_name
            f.save(temp_path)
            temp_paths.append((temp_path, ext, temp_name))
            original_names.append(f.filename)

    if not temp_paths:
        return jsonify({"error": "No valid image files"}), 400

    try:
        ai_result = analyze_images_with_ai([p[0] for p in temp_paths])
    except Exception as e:
        for p, _, _ in temp_paths:
            p.unlink(missing_ok=True)
        return jsonify({"error": f"AI analysis failed: {str(e)}"}), 500

    base_filename = sanitize_filename(ai_result.get("filename", "clothing_item"))
    listing_id = uuid.uuid4().hex[:12]
    batch_id = request.form.get("batch_id") or None
    category = request.form.get("category") or ""

    default_cost = 0
    if batch_id:
        conn = get_db()
        batch = conn.execute("SELECT * FROM batches WHERE id = ?", (batch_id,)).fetchone()
        if batch and batch["item_count"] > 0:
            default_cost = round(batch["total_cost"] / batch["item_count"], 2)
        conn.close()

    conn = get_db()
    conn.execute(
        "INSERT INTO listings (id, batch_id, name, description, hashtags, category, cost) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (listing_id, batch_id, ai_result["name"], ai_result["description"], ai_result["hashtags"], category, default_cost),
    )
    if batch_id:
        rebalance_batch_costs(conn, batch_id)

    photo_records = []
    for i, (temp_path, ext, temp_name) in enumerate(temp_paths):
        suffix = f"_{i + 1}" if len(temp_paths) > 1 else ""
        new_filename = f"{base_filename}{suffix}_{listing_id}.{ext}"
        new_path = UPLOAD_DIR / new_filename

        temp_path.rename(new_path)

        photo_id = uuid.uuid4().hex[:12]
        conn.execute(
            "INSERT INTO photos (id, listing_id, original_filename, stored_filename, sort_order) VALUES (?, ?, ?, ?, ?)",
            (photo_id, listing_id, original_names[i], new_filename, i),
        )
        photo_records.append({
            "id": photo_id,
            "original_filename": original_names[i],
            "stored_filename": new_filename,
            "url": f"/uploads/{new_filename}",
        })

    conn.commit()
    conn.close()

    return jsonify({
        "id": listing_id,
        "batch_id": batch_id,
        "name": ai_result["name"],
        "description": ai_result["description"],
        "hashtags": ai_result["hashtags"],
        "category": category,
        "cost": default_cost,
        "cost_locked": False,
        "list_price": 0,
        "sale_price": 0,
        "shipping_cost": 0,
        "photos": photo_records,
    })


@app.route("/api/listings/<listing_id>", methods=["PUT"])
def update_listing(listing_id):
    data = request.json
    conn = get_db()

    listing = conn.execute("SELECT * FROM listings WHERE id = ?", (listing_id,)).fetchone()
    if not listing:
        conn.close()
        return jsonify({"error": "Listing not found"}), 404

    name = data.get("name", listing["name"])
    desc = data.get("description", listing["description"])
    tags = data.get("hashtags", listing["hashtags"])
    category = data.get("category", listing["category"])
    cost = float(data.get("cost", listing["cost"]))
    cost_locked = int(data.get("cost_locked", listing["cost_locked"]))
    list_price = float(data.get("list_price", listing["list_price"]))
    sale_price = float(data.get("sale_price", listing["sale_price"]))
    shipping_cost = float(data.get("shipping_cost", listing["shipping_cost"]))
    posted = int(data.get("posted", listing["posted"]))

    conn.execute(
        """UPDATE listings SET name=?, description=?, hashtags=?, category=?,
           cost=?, cost_locked=?, list_price=?, sale_price=?, shipping_cost=?, posted=?
           WHERE id=?""",
        (name, desc, tags, category, cost, cost_locked, list_price, sale_price, shipping_cost, posted, listing_id),
    )

    if listing["batch_id"] and (cost != listing["cost"] or cost_locked != listing["cost_locked"]):
        rebalance_batch_costs(conn, listing["batch_id"])

    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/listings/<listing_id>", methods=["DELETE"])
def delete_listing(listing_id):
    conn = get_db()
    listing = conn.execute("SELECT * FROM listings WHERE id = ?", (listing_id,)).fetchone()
    photos = conn.execute(
        "SELECT stored_filename FROM photos WHERE listing_id = ?", (listing_id,)
    ).fetchall()
    for p in photos:
        (UPLOAD_DIR / p["stored_filename"]).unlink(missing_ok=True)
    conn.execute("DELETE FROM photos WHERE listing_id = ?", (listing_id,))
    conn.execute("DELETE FROM listings WHERE id = ?", (listing_id,))
    if listing and listing["batch_id"]:
        rebalance_batch_costs(conn, listing["batch_id"])
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/listings/<listing_id>/photos", methods=["POST"])
def add_photos(listing_id):
    files = request.files.getlist("photos")
    conn = get_db()

    listing = conn.execute("SELECT * FROM listings WHERE id = ?", (listing_id,)).fetchone()
    if not listing:
        conn.close()
        return jsonify({"error": "Listing not found"}), 404

    max_order = conn.execute(
        "SELECT COALESCE(MAX(sort_order), -1) FROM photos WHERE listing_id = ?", (listing_id,)
    ).fetchone()[0]

    base_filename = sanitize_filename(listing["name"])
    photo_records = []

    for i, f in enumerate(files):
        if f and allowed_file(f.filename):
            ext = f.filename.rsplit(".", 1)[1].lower()
            order = max_order + 1 + i
            new_filename = f"{base_filename}_{order + 1}_{listing_id}.{ext}"
            new_path = UPLOAD_DIR / new_filename
            f.save(new_path)

            photo_id = uuid.uuid4().hex[:12]
            conn.execute(
                "INSERT INTO photos (id, listing_id, original_filename, stored_filename, sort_order) VALUES (?, ?, ?, ?, ?)",
                (photo_id, listing_id, f.filename, new_filename, order),
            )
            photo_records.append({
                "id": photo_id,
                "original_filename": f.filename,
                "stored_filename": new_filename,
                "url": f"/uploads/{new_filename}",
            })

    conn.commit()
    conn.close()
    return jsonify({"photos": photo_records})


@app.route("/api/photos/<photo_id>", methods=["DELETE"])
def delete_photo(photo_id):
    conn = get_db()
    photo = conn.execute("SELECT * FROM photos WHERE id = ?", (photo_id,)).fetchone()
    if photo:
        (UPLOAD_DIR / photo["stored_filename"]).unlink(missing_ok=True)
        conn.execute("DELETE FROM photos WHERE id = ?", (photo_id,))
        conn.commit()
    conn.close()
    return jsonify({"ok": True})


# --- Dashboard Routes ---

@app.route("/api/dashboard", methods=["GET"])
def get_dashboard():
    conn = get_db()
    listings = conn.execute("SELECT * FROM listings").fetchall()
    batches = conn.execute("SELECT * FROM batches").fetchall()

    total_cost = sum(l["cost"] for l in listings)
    total_list = sum(l["list_price"] for l in listings)
    total_sale = sum(l["sale_price"] for l in listings)
    total_shipping = sum(l["shipping_cost"] for l in listings)
    total_revenue = total_sale - total_shipping
    total_profit = total_revenue - total_cost
    total_items = len(listings)
    sold_items = sum(1 for l in listings if l["sale_price"] > 0)

    # By batch
    batch_map = {b["id"]: b["name"] for b in batches}
    by_batch = {}
    for l in listings:
        bid = l["batch_id"] or "__none__"
        bname = batch_map.get(bid, "Unassigned")
        if bid not in by_batch:
            by_batch[bid] = {"name": bname, "cost": 0, "list_price": 0, "sale_price": 0, "shipping_cost": 0, "items": 0, "sold": 0}
        by_batch[bid]["cost"] += l["cost"]
        by_batch[bid]["list_price"] += l["list_price"]
        by_batch[bid]["sale_price"] += l["sale_price"]
        by_batch[bid]["shipping_cost"] += l["shipping_cost"]
        by_batch[bid]["items"] += 1
        if l["sale_price"] > 0:
            by_batch[bid]["sold"] += 1

    batch_list = []
    for bid, data in by_batch.items():
        rev = data["sale_price"] - data["shipping_cost"]
        batch_list.append({
            "id": bid,
            "name": data["name"],
            "cost": round(data["cost"], 2),
            "list_price": round(data["list_price"], 2),
            "revenue": round(rev, 2),
            "profit": round(rev - data["cost"], 2),
            "items": data["items"],
            "sold": data["sold"],
        })

    # By category
    by_category = {}
    for l in listings:
        cat = l["category"] or "Uncategorized"
        if cat not in by_category:
            by_category[cat] = {"cost": 0, "list_price": 0, "sale_price": 0, "shipping_cost": 0, "items": 0, "sold": 0}
        by_category[cat]["cost"] += l["cost"]
        by_category[cat]["list_price"] += l["list_price"]
        by_category[cat]["sale_price"] += l["sale_price"]
        by_category[cat]["shipping_cost"] += l["shipping_cost"]
        by_category[cat]["items"] += 1
        if l["sale_price"] > 0:
            by_category[cat]["sold"] += 1

    category_list = []
    for cat, data in by_category.items():
        rev = data["sale_price"] - data["shipping_cost"]
        category_list.append({
            "name": cat,
            "cost": round(data["cost"], 2),
            "list_price": round(data["list_price"], 2),
            "revenue": round(rev, 2),
            "profit": round(rev - data["cost"], 2),
            "items": data["items"],
            "sold": data["sold"],
        })

    # Individual items for drill-down
    item_list = []
    for l in listings:
        rev = l["sale_price"] - l["shipping_cost"]
        item_list.append({
            "id": l["id"],
            "name": l["name"],
            "batch_id": l["batch_id"],
            "batch_name": batch_map.get(l["batch_id"], "Unassigned") if l["batch_id"] else "Unassigned",
            "category": l["category"] or "Uncategorized",
            "cost": round(l["cost"], 2),
            "list_price": round(l["list_price"], 2),
            "sale_price": round(l["sale_price"], 2),
            "shipping_cost": round(l["shipping_cost"], 2),
            "revenue": round(rev, 2),
            "profit": round(rev - l["cost"], 2),
        })

    conn.close()
    return jsonify({
        "summary": {
            "total_cost": round(total_cost, 2),
            "total_list_price": round(total_list, 2),
            "total_revenue": round(total_revenue, 2),
            "total_profit": round(total_profit, 2),
            "total_items": total_items,
            "sold_items": sold_items,
        },
        "by_batch": batch_list,
        "by_category": category_list,
        "items": item_list,
    })


@app.route("/uploads/<path:filename>")
def serve_upload(filename):
    return send_from_directory(UPLOAD_DIR, filename)


if __name__ == "__main__":
    app.run(debug=True, port=5000)
