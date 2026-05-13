import os
import re
import json
import uuid
import base64
import sqlite3
import shutil
import subprocess
import platform
from datetime import date as dt_date
from pathlib import Path
from urllib.request import urlopen, Request
from urllib.parse import urlencode
import urllib.error

from flask import Flask, request, jsonify, send_from_directory, render_template, after_this_request
from dotenv import load_dotenv
import anthropic
from io import BytesIO
from PIL import Image

MAX_API_IMAGE_BYTES = 3_700_000  # ~3.7MB raw = ~4.9MB base64, under Claude's 5MB limit

# --- Pinterest API ---
_PINTEREST_AUTH_URL    = "https://www.pinterest.com/oauth/"
_PINTEREST_TOKEN_URL   = "https://api.pinterest.com/v5/oauth/token"
_PINTEREST_API_BASE    = "https://api.pinterest.com/v5"
_PINTEREST_REDIRECT    = "http://localhost:5000/api/pinterest/callback"
_PINTEREST_SCOPES      = "boards:read,pins:write"

load_dotenv(Path(__file__).parent / ".env", override=True)

app = Flask(__name__, static_folder="static", template_folder="templates")

UPLOAD_DIR = Path(__file__).parent / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)
DB_PATH = Path(__file__).parent / "listings.db"

ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "webp", "gif"}


@app.after_request
def add_cors_headers(response):
    """Allow the Chrome extension and its content scripts to access the API."""
    origin = request.headers.get("Origin", "")
    if (origin.startswith("chrome-extension://")
            or "localhost" in origin
            or "facebook.com" in origin
            or "depop.com" in origin
            or "ebay.com" in origin):
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
            brand TEXT NOT NULL DEFAULT '',
            size TEXT NOT NULL DEFAULT '',
            cost REAL NOT NULL DEFAULT 0,
            cost_locked INTEGER NOT NULL DEFAULT 0,
            list_price REAL NOT NULL DEFAULT 0,
            sale_price REAL NOT NULL DEFAULT 0,
            processing_cost REAL NOT NULL DEFAULT 0,
            other_fees REAL NOT NULL DEFAULT 0,
            posted INTEGER NOT NULL DEFAULT 0,
            date_listed TEXT,
            date_sold TEXT,
            item_number INTEGER,
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
        CREATE TABLE IF NOT EXISTS brands (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE
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

    # One-time rename: shipping_cost → processing_cost
    if "shipping_cost" in columns and "processing_cost" not in columns:
        conn.execute("ALTER TABLE listings RENAME COLUMN shipping_cost TO processing_cost")
        columns = ["processing_cost" if c == "shipping_cost" else c for c in columns]

    migrations = {
        "batch_id":        "ALTER TABLE listings ADD COLUMN batch_id TEXT",
        "cost":            "ALTER TABLE listings ADD COLUMN cost REAL NOT NULL DEFAULT 0",
        "cost_locked":     "ALTER TABLE listings ADD COLUMN cost_locked INTEGER NOT NULL DEFAULT 0",
        "category":        "ALTER TABLE listings ADD COLUMN category TEXT NOT NULL DEFAULT ''",
        "list_price":      "ALTER TABLE listings ADD COLUMN list_price REAL NOT NULL DEFAULT 0",
        "sale_price":      "ALTER TABLE listings ADD COLUMN sale_price REAL NOT NULL DEFAULT 0",
        "processing_cost": "ALTER TABLE listings ADD COLUMN processing_cost REAL NOT NULL DEFAULT 0",
        "other_fees":      "ALTER TABLE listings ADD COLUMN other_fees REAL NOT NULL DEFAULT 0",
        "posted":          "ALTER TABLE listings ADD COLUMN posted INTEGER NOT NULL DEFAULT 0",
        "brand":           "ALTER TABLE listings ADD COLUMN brand TEXT NOT NULL DEFAULT ''",
        "size":            "ALTER TABLE listings ADD COLUMN size TEXT NOT NULL DEFAULT ''",
        "date_listed":     "ALTER TABLE listings ADD COLUMN date_listed TEXT",
        "date_sold":       "ALTER TABLE listings ADD COLUMN date_sold TEXT",
        "item_number":     "ALTER TABLE listings ADD COLUMN item_number INTEGER",
    }
    for col, sql in migrations.items():
        if col not in columns:
            conn.execute(sql)
    # Ensure brands table exists for older installs
    conn.execute(
        "CREATE TABLE IF NOT EXISTS brands "
        "(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE)"
    )
    conn.commit()
    conn.close()


migrate_db()


# --- Item-number sequence (never reused even after deletion) ---

def next_item_number(conn):
    """Atomically increment and return the next global item number (starts at 0)."""
    row = conn.execute("SELECT value FROM settings WHERE key = 'item_number_seq'").fetchone()
    current = int(row["value"]) if row else -1
    next_num = current + 1
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('item_number_seq', ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (str(next_num),),
    )
    return next_num


def save_brand(conn, brand):
    """Upsert a brand name so it appears in autocomplete suggestions."""
    if brand and brand.strip():
        conn.execute("INSERT OR IGNORE INTO brands (name) VALUES (?)", (brand.strip(),))


def get_aging_days():
    """Return the number of days after which a listed item is considered 'aging'."""
    conn = get_db()
    row = conn.execute("SELECT value FROM settings WHERE key = 'aging_days'").fetchone()
    conn.close()
    return int(row["value"]) if row else 30


def compute_status(listing, aging_days):
    """Derive listing status from its data fields."""
    if listing["sale_price"] > 0:
        return "sold"
    if not listing["date_listed"]:
        return "unlisted"
    try:
        listed = dt_date.fromisoformat(listing["date_listed"])
        if (dt_date.today() - listed).days > aging_days:
            return "aging"
    except Exception:
        pass
    return "listed"


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


# --- Pending Post (extension communication) ---

@app.route("/api/pending-post", methods=["GET"])
def get_pending_post():
    conn = get_db()
    row = conn.execute("SELECT value FROM settings WHERE key = 'pending_post'").fetchone()
    conn.close()
    if row:
        return jsonify(json.loads(row["value"]))
    return jsonify({"listing_id": None})


@app.route("/api/pending-post", methods=["POST"])
def set_pending_post():
    data = request.json
    listing_id = data.get("listing_id")
    conn = get_db()
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('pending_post', ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (json.dumps({"listing_id": listing_id}),),
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/pending-post", methods=["DELETE"])
def clear_pending_post():
    conn = get_db()
    conn.execute("DELETE FROM settings WHERE key = 'pending_post'")
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


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

def listing_to_dict(listing, photos, aging_days=30):
    return {
        "id": listing["id"],
        "item_number": listing["item_number"],
        "batch_id": listing["batch_id"],
        "name": listing["name"],
        "description": listing["description"],
        "hashtags": listing["hashtags"],
        "category": listing["category"],
        "brand": listing["brand"] or "",
        "size": listing["size"] or "",
        "cost": listing["cost"],
        "cost_locked": bool(listing["cost_locked"]),
        "list_price": listing["list_price"],
        "sale_price": listing["sale_price"],
        "processing_cost": listing["processing_cost"],
        "other_fees": listing["other_fees"],
        "posted": bool(listing["posted"]),
        "date_listed": listing["date_listed"] or "",
        "date_sold": listing["date_sold"] or "",
        "status": compute_status(listing, aging_days),
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
    aging_days = get_aging_days()
    listings = conn.execute(
        "SELECT * FROM listings ORDER BY created_at DESC"
    ).fetchall()

    result = []
    for listing in listings:
        photos = conn.execute(
            "SELECT * FROM photos WHERE listing_id = ? ORDER BY sort_order",
            (listing["id"],)
        ).fetchall()
        result.append(listing_to_dict(listing, photos, aging_days))
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
    brand = request.form.get("brand", "").strip()
    size = request.form.get("size", "").strip()

    default_cost = 0
    if batch_id:
        conn = get_db()
        batch = conn.execute("SELECT * FROM batches WHERE id = ?", (batch_id,)).fetchone()
        if batch and batch["item_count"] > 0:
            default_cost = round(batch["total_cost"] / batch["item_count"], 2)
        conn.close()

    conn = get_db()
    item_num = next_item_number(conn)
    conn.execute(
        "INSERT INTO listings (id, batch_id, name, description, hashtags, category, brand, size, cost, item_number) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (listing_id, batch_id, ai_result["name"], ai_result["description"],
         ai_result["hashtags"], category, brand, size, default_cost, item_num),
    )
    if brand:
        save_brand(conn, brand)
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
        "item_number": item_num,
        "batch_id": batch_id,
        "name": ai_result["name"],
        "description": ai_result["description"],
        "hashtags": ai_result["hashtags"],
        "category": category,
        "brand": brand,
        "size": size,
        "cost": default_cost,
        "cost_locked": False,
        "list_price": 0,
        "sale_price": 0,
        "processing_cost": 0,
        "other_fees": 0,
        "posted": False,
        "date_listed": "",
        "date_sold": "",
        "status": "unlisted",
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
    brand = data.get("brand", listing["brand"] or "").strip()
    size = data.get("size", listing["size"] or "").strip()
    cost = float(data.get("cost", listing["cost"]))
    cost_locked = int(data.get("cost_locked", listing["cost_locked"]))
    list_price = float(data.get("list_price", listing["list_price"]))
    sale_price = float(data.get("sale_price", listing["sale_price"]))
    processing_cost = float(data.get("processing_cost", listing["processing_cost"]))
    other_fees = float(data.get("other_fees", listing["other_fees"]))
    posted = int(data.get("posted", listing["posted"]))
    # Empty string → NULL so status logic works correctly
    date_listed = data.get("date_listed", listing["date_listed"] or "") or None
    date_sold = data.get("date_sold", listing["date_sold"] or "") or None
    # Callers can set skip_rebalance=true to save values as-is without redistribution
    skip_rebalance = bool(data.get("skip_rebalance", False))

    # batch_id: only update when the key is explicitly present in the request body
    old_batch_id = listing["batch_id"]
    if "batch_id" in data:
        new_batch_id = data["batch_id"] or None
    else:
        new_batch_id = old_batch_id

    conn.execute(
        """UPDATE listings SET name=?, description=?, hashtags=?, category=?,
           brand=?, size=?, date_listed=?, date_sold=?,
           cost=?, cost_locked=?, list_price=?, sale_price=?,
           processing_cost=?, other_fees=?, posted=?, batch_id=?
           WHERE id=?""",
        (name, desc, tags, category, brand, size, date_listed, date_sold,
         cost, cost_locked, list_price, sale_price,
         processing_cost, other_fees, posted, new_batch_id, listing_id),
    )
    if brand:
        save_brand(conn, brand)

    batch_changed = new_batch_id != old_batch_id
    if batch_changed:
        # Rebalance both the old batch (item left) and the new batch (item joined)
        if old_batch_id:
            rebalance_batch_costs(conn, old_batch_id)
        if new_batch_id:
            rebalance_batch_costs(conn, new_batch_id)
    elif (not skip_rebalance
            and new_batch_id
            and (cost != listing["cost"] or cost_locked != listing["cost_locked"])):
        rebalance_batch_costs(conn, new_batch_id)

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


@app.route("/api/listings/<listing_id>/export-photos", methods=["POST"])
def export_photos(listing_id):
    """Copy listing photos to a named folder in the user's Downloads directory and open it."""
    conn = get_db()
    listing = conn.execute("SELECT * FROM listings WHERE id = ?", (listing_id,)).fetchone()
    if not listing:
        conn.close()
        return jsonify({"error": "Listing not found"}), 404

    photos = conn.execute(
        "SELECT * FROM photos WHERE listing_id = ? ORDER BY sort_order", (listing_id,)
    ).fetchall()

    if not photos:
        conn.close()
        return jsonify({"error": "No photos to export"}), 400

    # Get batch name if applicable
    batch_name = ""
    if listing["batch_id"]:
        batch = conn.execute("SELECT name FROM batches WHERE id = ?", (listing["batch_id"],)).fetchone()
        if batch:
            batch_name = batch["name"]
    conn.close()

    # Build folder name: "Batch Name - Listing Title" or just "Listing Title"
    listing_name = listing["name"] or "Untitled"
    if batch_name:
        folder_name = f"{batch_name} - {listing_name}"
    else:
        folder_name = listing_name

    # Sanitize folder name for filesystem
    folder_name = re.sub(r'[<>:"/\\|?*]', '', folder_name).strip()
    folder_name = folder_name[:100]  # limit length

    # Create folder in user's Downloads directory
    downloads_dir = Path.home() / "Downloads" / "FlipStack Exports" / folder_name
    downloads_dir.mkdir(parents=True, exist_ok=True)

    # Copy each photo
    for photo in photos:
        src = UPLOAD_DIR / photo["stored_filename"]
        if src.exists():
            # Use original filename if available, otherwise stored name
            dest_name = photo["original_filename"] or photo["stored_filename"]
            dest = downloads_dir / dest_name
            # Handle duplicate filenames
            counter = 1
            while dest.exists():
                stem = dest.stem
                suffix = dest.suffix
                dest = downloads_dir / f"{stem}_{counter}{suffix}"
                counter += 1
            shutil.copy2(src, dest)

    # Open the folder in file explorer
    try:
        system = platform.system()
        if system == "Windows":
            os.startfile(str(downloads_dir))
        elif system == "Darwin":
            subprocess.Popen(["open", str(downloads_dir)])
        else:
            subprocess.Popen(["xdg-open", str(downloads_dir)])
    except Exception:
        pass  # non-critical if explorer doesn't open

    return jsonify({
        "ok": True,
        "folder": str(downloads_dir),
        "count": len(photos),
    })


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


# --- Brands Routes ---

@app.route("/api/brands", methods=["GET"])
def get_brands():
    conn = get_db()
    rows = conn.execute("SELECT name FROM brands ORDER BY name COLLATE NOCASE").fetchall()
    conn.close()
    return jsonify([r["name"] for r in rows])


# --- Aging-Days Setting ---

@app.route("/api/settings/aging-days", methods=["GET"])
def get_aging_days_api():
    return jsonify({"aging_days": get_aging_days()})


@app.route("/api/settings/aging-days", methods=["PUT"])
def save_aging_days_api():
    data = request.json
    try:
        days = int(data.get("days", 30))
    except (TypeError, ValueError):
        days = 30
    days = max(1, days)
    conn = get_db()
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('aging_days', ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (str(days),),
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True, "aging_days": days})


# --- Dashboard Routes ---

@app.route("/api/dashboard", methods=["GET"])
def get_dashboard():
    conn = get_db()
    listings = conn.execute("SELECT * FROM listings").fetchall()
    batches = conn.execute("SELECT * FROM batches").fetchall()

    total_cost = sum(l["cost"] for l in listings)
    total_list = sum(l["list_price"] for l in listings)
    total_sale = sum(l["sale_price"] for l in listings)
    total_processing = sum(l["processing_cost"] for l in listings)
    total_other = sum(l["other_fees"] for l in listings)
    total_revenue = total_sale
    total_profit  = total_sale - total_cost - total_processing - total_other
    total_items = len(listings)
    sold_items = sum(1 for l in listings if l["sale_price"] > 0)

    # By batch
    batch_map = {b["id"]: b["name"] for b in batches}
    by_batch = {}
    for l in listings:
        bid = l["batch_id"] or "__none__"
        bname = batch_map.get(bid, "Unassigned")
        if bid not in by_batch:
            by_batch[bid] = {"name": bname, "cost": 0, "list_price": 0, "sale_price": 0, "processing_cost": 0, "other_fees": 0, "items": 0, "sold": 0}
        by_batch[bid]["cost"] += l["cost"]
        by_batch[bid]["list_price"] += l["list_price"]
        by_batch[bid]["sale_price"] += l["sale_price"]
        by_batch[bid]["processing_cost"] += l["processing_cost"]
        by_batch[bid]["other_fees"] += l["other_fees"]
        by_batch[bid]["items"] += 1
        if l["sale_price"] > 0:
            by_batch[bid]["sold"] += 1

    batch_list = []
    for bid, data in by_batch.items():
        rev    = data["sale_price"]
        profit = data["sale_price"] - data["cost"] - data["processing_cost"] - data["other_fees"]
        batch_list.append({
            "id": bid,
            "name": data["name"],
            "cost": round(data["cost"], 2),
            "list_price": round(data["list_price"], 2),
            "revenue": round(rev, 2),
            "profit": round(profit, 2),
            "items": data["items"],
            "sold": data["sold"],
        })

    # By category
    by_category = {}
    for l in listings:
        cat = l["category"] or "Uncategorized"
        if cat not in by_category:
            by_category[cat] = {"cost": 0, "list_price": 0, "sale_price": 0, "processing_cost": 0, "other_fees": 0, "items": 0, "sold": 0}
        by_category[cat]["cost"] += l["cost"]
        by_category[cat]["list_price"] += l["list_price"]
        by_category[cat]["sale_price"] += l["sale_price"]
        by_category[cat]["processing_cost"] += l["processing_cost"]
        by_category[cat]["other_fees"] += l["other_fees"]
        by_category[cat]["items"] += 1
        if l["sale_price"] > 0:
            by_category[cat]["sold"] += 1

    category_list = []
    for cat, data in by_category.items():
        rev    = data["sale_price"]
        profit = data["sale_price"] - data["cost"] - data["processing_cost"] - data["other_fees"]
        category_list.append({
            "name": cat,
            "cost": round(data["cost"], 2),
            "list_price": round(data["list_price"], 2),
            "revenue": round(rev, 2),
            "profit": round(profit, 2),
            "items": data["items"],
            "sold": data["sold"],
        })

    # Individual items for drill-down
    item_list = []
    for l in listings:
        rev    = l["sale_price"]
        profit = l["sale_price"] - l["cost"] - l["processing_cost"] - l["other_fees"]
        item_list.append({
            "id": l["id"],
            "name": l["name"],
            "batch_id": l["batch_id"],
            "batch_name": batch_map.get(l["batch_id"], "Unassigned") if l["batch_id"] else "Unassigned",
            "category": l["category"] or "Uncategorized",
            "cost": round(l["cost"], 2),
            "list_price": round(l["list_price"], 2),
            "sale_price": round(l["sale_price"], 2),
            "processing_cost": round(l["processing_cost"], 2),
            "other_fees": round(l["other_fees"], 2),
            "revenue": round(rev, 2),
            "profit": round(profit, 2),
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


@app.route("/api/dashboard/timeline", methods=["GET"])
def dashboard_timeline():
    """Return profit grouped by day/month/year, filtered by date_sold range."""
    date_from = request.args.get("date_from", "").strip()
    date_to   = request.args.get("date_to",   "").strip()
    gran      = request.args.get("granularity", "month")  # day | month | year

    conn = get_db()
    query  = "SELECT * FROM listings WHERE date_sold IS NOT NULL AND date_sold != ''"
    params = []
    if date_from:
        query += " AND date_sold >= ?"
        params.append(date_from)
    if date_to:
        query += " AND date_sold <= ?"
        params.append(date_to)

    rows = conn.execute(query, params).fetchall()
    conn.close()

    buckets = {}
    for l in rows:
        ds = l["date_sold"]
        if gran == "year":
            key = ds[:4]
        elif gran == "month":
            key = ds[:7]
        else:
            key = ds[:10]

        if key not in buckets:
            buckets[key] = {"revenue": 0.0, "cost": 0.0, "profit": 0.0, "items_sold": 0}

        buckets[key]["revenue"]    += l["sale_price"]
        buckets[key]["cost"]       += l["cost"]
        buckets[key]["profit"]     += l["sale_price"] - l["cost"] - l["processing_cost"] - l["other_fees"]
        buckets[key]["items_sold"] += 1

    points = [
        {
            "period":     k,
            "revenue":    round(v["revenue"],    2),
            "cost":       round(v["cost"],       2),
            "profit":     round(v["profit"],     2),
            "items_sold": v["items_sold"],
        }
        for k, v in sorted(buckets.items())
    ]
    return jsonify({"points": points})


@app.route("/api/dashboard/operational", methods=["GET"])
def dashboard_operational():
    """Operational dashboard: aging, sell-through, unsold value by batch/category."""
    aging_days = get_aging_days()
    conn    = get_db()
    listings = conn.execute("SELECT * FROM listings").fetchall()
    batches  = conn.execute("SELECT * FROM batches").fetchall()
    conn.close()

    batch_map = {b["id"]: b["name"] for b in batches}
    today     = dt_date.today()

    # Enrich each listing with computed status + days_listed
    items = []
    for l in listings:
        status = compute_status(l, aging_days)
        days_listed = None
        if l["date_listed"]:
            try:
                days_listed = (today - dt_date.fromisoformat(l["date_listed"])).days
            except Exception:
                pass
        items.append({
            "id":         l["id"],
            "name":       l["name"],
            "batch_id":   l["batch_id"],
            "batch_name": batch_map.get(l["batch_id"], "Unassigned") if l["batch_id"] else "Unassigned",
            "category":   l["category"] or "Uncategorized",
            "status":     status,
            "days_listed": days_listed,
            "list_price": round(l["list_price"], 2),
            "cost":       round(l["cost"], 2),
            "date_listed": l["date_listed"] or "",
        })

    # Summary
    by_status = {"unlisted": 0, "listed": 0, "aging": 0, "sold": 0}
    for i in items:
        by_status[i["status"]] = by_status.get(i["status"], 0) + 1

    active_days = [i["days_listed"] for i in items
                   if i["days_listed"] is not None and i["status"] != "sold"]
    avg_days    = round(sum(active_days) / len(active_days), 1) if active_days else 0
    unsold_val  = round(sum(i["list_price"] for i in items if i["status"] != "sold"), 2)

    aging_items = sorted(
        [i for i in items if i["status"] == "aging"],
        key=lambda x: x["days_listed"] or 0, reverse=True
    )

    def make_bucket():
        return {"total": 0, "unlisted": 0, "listed": 0, "aging": 0, "sold": 0, "unsold_value": 0.0}

    # By-batch breakdown
    by_batch = {}
    for i in items:
        key = i["batch_id"] or "__none__"
        if key not in by_batch:
            by_batch[key] = {**make_bucket(), "name": i["batch_name"]}
        by_batch[key]["total"] += 1
        by_batch[key][i["status"]] += 1
        if i["status"] != "sold":
            by_batch[key]["unsold_value"] += i["list_price"]

    batch_rows = sorted(
        [{**v, "pct_sold": round(v["sold"] / v["total"] * 100) if v["total"] else 0,
           "unsold_value": round(v["unsold_value"], 2)}
         for v in by_batch.values()],
        key=lambda x: x["aging"], reverse=True
    )

    # By-category breakdown
    by_cat = {}
    for i in items:
        cat = i["category"]
        if cat not in by_cat:
            by_cat[cat] = {**make_bucket(), "name": cat}
        by_cat[cat]["total"] += 1
        by_cat[cat][i["status"]] += 1
        if i["status"] != "sold":
            by_cat[cat]["unsold_value"] += i["list_price"]

    cat_rows = sorted(
        [{**v, "pct_sold": round(v["sold"] / v["total"] * 100) if v["total"] else 0,
           "unsold_value": round(v["unsold_value"], 2)}
         for v in by_cat.values()],
        key=lambda x: x["aging"], reverse=True
    )

    return jsonify({
        "aging_days": aging_days,
        "summary": {
            "total":           len(items),
            "unlisted":        by_status.get("unlisted", 0),
            "listed":          by_status.get("listed",   0),
            "aging":           by_status.get("aging",    0),
            "sold":            by_status.get("sold",     0),
            "avg_days_listed": avg_days,
            "unsold_value":    unsold_val,
        },
        "aging_items": aging_items,
        "by_batch":    batch_rows,
        "by_category": cat_rows,
    })


@app.route("/api/listings/no-photo", methods=["POST"])
def create_listing_no_photo():
    """Create a listing with just a name — no photos, no AI analysis."""
    data = request.json or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "Name is required"}), 400

    batch_id = data.get("batch_id") or None
    category = data.get("category") or ""

    default_cost = 0
    if batch_id:
        conn_tmp = get_db()
        batch = conn_tmp.execute("SELECT * FROM batches WHERE id = ?", (batch_id,)).fetchone()
        if batch and batch["item_count"] > 0:
            default_cost = round(batch["total_cost"] / batch["item_count"], 2)
        conn_tmp.close()

    conn = get_db()
    listing_id = uuid.uuid4().hex[:12]
    item_num = next_item_number(conn)
    conn.execute(
        "INSERT INTO listings "
        "(id, batch_id, name, description, hashtags, category, cost, item_number) "
        "VALUES (?, ?, ?, '', '', ?, ?, ?)",
        (listing_id, batch_id, name, category, default_cost, item_num),
    )
    if batch_id:
        rebalance_batch_costs(conn, batch_id)
    conn.commit()
    conn.close()

    return jsonify({
        "id": listing_id,
        "item_number": item_num,
        "batch_id": batch_id,
        "name": name,
        "description": "",
        "hashtags": "",
        "category": category,
        "brand": "",
        "size": "",
        "cost": default_cost,
        "cost_locked": False,
        "list_price": 0,
        "sale_price": 0,
        "processing_cost": 0,
        "other_fees": 0,
        "posted": False,
        "date_listed": "",
        "date_sold": "",
        "status": "unlisted",
        "photos": [],
    })


# --- Pinterest helpers ---

def _pinterest_token():
    conn = get_db()
    row = conn.execute("SELECT value FROM settings WHERE key='pinterest_token'").fetchone()
    conn.close()
    return json.loads(row["value"]) if row else None


def _save_pinterest_token(token_data):
    conn = get_db()
    conn.execute(
        "INSERT INTO settings (key,value) VALUES ('pinterest_token',?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (json.dumps(token_data),),
    )
    conn.commit()
    conn.close()


def _pinterest_get(path, token):
    """GET from Pinterest API; returns (dict, status_code)."""
    req = Request(
        f"{_PINTEREST_API_BASE}{path}",
        headers={"Authorization": f"Bearer {token['access_token']}"},
    )
    try:
        with urlopen(req) as r:
            return json.loads(r.read()), r.status
    except urllib.error.HTTPError as e:
        return json.loads(e.read() or b"{}"), e.code


def _pinterest_post(path, token, payload):
    """POST JSON to Pinterest API; returns (dict, status_code)."""
    body = json.dumps(payload).encode()
    req = Request(
        f"{_PINTEREST_API_BASE}{path}",
        data=body,
        headers={
            "Authorization": f"Bearer {token['access_token']}",
            "Content-Type": "application/json",
        },
    )
    try:
        with urlopen(req) as r:
            return json.loads(r.read()), r.status
    except urllib.error.HTTPError as e:
        return json.loads(e.read() or b"{}"), e.code


# --- Pinterest routes ---

@app.route("/api/pinterest/status", methods=["GET"])
def pinterest_status():
    client_id = os.getenv("PINTEREST_CLIENT_ID", "")
    token = _pinterest_token()
    return jsonify({
        "connected": bool(token),
        "configured": bool(client_id),
    })


@app.route("/api/pinterest/auth", methods=["GET"])
def pinterest_auth():
    client_id = os.getenv("PINTEREST_CLIENT_ID", "")
    if not client_id:
        return jsonify({"error": "Add PINTEREST_CLIENT_ID and PINTEREST_CLIENT_SECRET to your .env file first."}), 400
    params = urlencode({
        "client_id":    client_id,
        "redirect_uri": _PINTEREST_REDIRECT,
        "response_type": "code",
        "scope":        _PINTEREST_SCOPES,
    })
    return jsonify({"url": f"{_PINTEREST_AUTH_URL}?{params}"})


@app.route("/api/pinterest/callback", methods=["GET"])
def pinterest_callback():
    code  = request.args.get("code", "")
    error = request.args.get("error", "")
    if error:
        return f"<p>Pinterest error: {error}. Close this window.</p>"
    if not code:
        return "<p>No code returned by Pinterest.</p>", 400

    client_id     = os.getenv("PINTEREST_CLIENT_ID", "")
    client_secret = os.getenv("PINTEREST_CLIENT_SECRET", "")
    creds_b64 = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()

    body = urlencode({
        "grant_type":   "authorization_code",
        "code":         code,
        "redirect_uri": _PINTEREST_REDIRECT,
    }).encode()
    req = Request(
        _PINTEREST_TOKEN_URL,
        data=body,
        headers={
            "Authorization":  f"Basic {creds_b64}",
            "Content-Type":   "application/x-www-form-urlencoded",
        },
    )
    try:
        with urlopen(req) as r:
            token_data = json.loads(r.read())
    except urllib.error.HTTPError as e:
        return f"<p>Token exchange failed: {e.read().decode()}</p>", 400

    _save_pinterest_token(token_data)
    return """<!DOCTYPE html><html><body>
    <script>
        if (window.opener) { window.opener.postMessage('pinterest_connected','*'); }
        window.close();
    </script>
    <p>Pinterest connected! You can close this window.</p>
    </body></html>"""


@app.route("/api/pinterest/disconnect", methods=["DELETE"])
def pinterest_disconnect():
    conn = get_db()
    conn.execute(
        "DELETE FROM settings WHERE key IN "
        "('pinterest_token','pinterest_board_id','pinterest_board_name')"
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/pinterest/boards", methods=["GET"])
def pinterest_boards():
    token = _pinterest_token()
    if not token:
        return jsonify({"error": "Not connected to Pinterest"}), 401
    data, status = _pinterest_get("/boards?page_size=100", token)
    if status == 401:
        return jsonify({"error": "Pinterest session expired — please reconnect"}), 401
    if status >= 400:
        return jsonify({"error": data.get("message", "Failed to fetch boards")}), status

    conn = get_db()
    row = conn.execute("SELECT value FROM settings WHERE key='pinterest_board_id'").fetchone()
    saved_board_id = row["value"] if row else None
    conn.close()
    return jsonify({
        "boards": [{"id": b["id"], "name": b["name"]} for b in data.get("items", [])],
        "selected_board_id": saved_board_id,
    })


@app.route("/api/pinterest/boards/select", methods=["PUT"])
def pinterest_select_board():
    data      = request.json or {}
    board_id  = data.get("board_id", "")
    board_name = data.get("board_name", "")
    conn = get_db()
    for key, val in [("pinterest_board_id", board_id), ("pinterest_board_name", board_name)]:
        conn.execute(
            "INSERT INTO settings (key,value) VALUES (?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, val),
        )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/listings/<listing_id>/post-pinterest", methods=["POST"])
def post_to_pinterest(listing_id):
    token = _pinterest_token()
    if not token:
        return jsonify({"error": "Not connected to Pinterest — connect in Settings first."}), 401

    conn = get_db()
    listing = conn.execute("SELECT * FROM listings WHERE id=?", (listing_id,)).fetchone()
    if not listing:
        conn.close()
        return jsonify({"error": "Listing not found"}), 404

    photos = conn.execute(
        "SELECT * FROM photos WHERE listing_id=? ORDER BY sort_order LIMIT 1",
        (listing_id,),
    ).fetchall()
    board_row = conn.execute(
        "SELECT value FROM settings WHERE key='pinterest_board_id'"
    ).fetchone()
    conn.close()

    if not board_row or not board_row["value"]:
        return jsonify({"error": "No Pinterest board selected — choose one in Settings first."}), 400

    # Build the pin
    description = f"{listing['description']}\n\n{listing['hashtags']}".strip()
    pin = {
        "board_id":    board_row["value"],
        "title":       (listing["name"] or "")[:100],
        "description": description[:500],
    }

    if photos:
        photo_path = UPLOAD_DIR / photos[0]["stored_filename"]
        if photo_path.exists():
            shrink_image_if_needed(photo_path)
            pin["media_source"] = {
                "source_type":  "image_base64",
                "content_type": get_media_type(photos[0]["stored_filename"]),
                "data":         encode_image_base64(photo_path),
            }

    result, status = _pinterest_post("/pins", token, pin)
    if status == 401:
        return jsonify({"error": "Pinterest session expired — please reconnect in Settings."}), 401
    if status >= 400:
        msg = result.get("message") or result.get("error_description") or "Pinterest API error"
        return jsonify({"error": msg}), status

    pin_id = result.get("id", "")
    return jsonify({
        "ok": True,
        "pin_id":  pin_id,
        "pin_url": f"https://pinterest.com/pin/{pin_id}" if pin_id else "",
    })


@app.route("/uploads/<path:filename>")
def serve_upload(filename):
    return send_from_directory(UPLOAD_DIR, filename)


if __name__ == "__main__":
    app.run(debug=True, port=5000)
