import os
import re
import json
import uuid
import base64
import sqlite3
from pathlib import Path

from flask import Flask, request, jsonify, send_from_directory, render_template
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
        CREATE TABLE IF NOT EXISTS listings (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL DEFAULT '',
            description TEXT NOT NULL DEFAULT '',
            hashtags TEXT NOT NULL DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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


def get_prompt():
    conn = get_db()
    row = conn.execute("SELECT value FROM settings WHERE key = 'prompt'").fetchone()
    conn.close()
    if row:
        return row["value"]
    return DEFAULT_PROMPT


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
    img.exif = None  # strip EXIF to save space
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
    # Still too big — scale down dimensions
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
    # Strip markdown fencing if present
    if raw.startswith("```"):
        raw = re.sub(r'^```(?:json)?\s*', '', raw)
        raw = re.sub(r'\s*```$', '', raw)
    return json.loads(raw)


# --- Routes ---

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/prompt", methods=["GET"])
def get_prompt_api():
    return jsonify({"prompt": get_prompt(), "default": DEFAULT_PROMPT})


@app.route("/api/prompt", methods=["PUT"])
def save_prompt_api():
    data = request.json
    prompt = data.get("prompt", "").strip()
    if not prompt:
        return jsonify({"error": "Prompt cannot be empty"}), 400
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
        result.append({
            "id": listing["id"],
            "name": listing["name"],
            "description": listing["description"],
            "hashtags": listing["hashtags"],
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
        })
    conn.close()
    return jsonify(result)


@app.route("/api/listings", methods=["POST"])
def create_listing():
    """Upload photos, analyze with AI, create listing."""
    files = request.files.getlist("photos")
    if not files or all(f.filename == "" for f in files):
        return jsonify({"error": "No photos uploaded"}), 400

    # Save uploaded files temporarily
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

    # Analyze with AI
    try:
        ai_result = analyze_images_with_ai([p[0] for p in temp_paths])
    except Exception as e:
        # Clean up temp files on failure
        for p, _, _ in temp_paths:
            p.unlink(missing_ok=True)
        return jsonify({"error": f"AI analysis failed: {str(e)}"}), 500

    base_filename = sanitize_filename(ai_result.get("filename", "clothing_item"))
    listing_id = uuid.uuid4().hex[:12]

    # Rename files
    conn = get_db()
    conn.execute(
        "INSERT INTO listings (id, name, description, hashtags) VALUES (?, ?, ?, ?)",
        (listing_id, ai_result["name"], ai_result["description"], ai_result["hashtags"]),
    )

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
        "name": ai_result["name"],
        "description": ai_result["description"],
        "hashtags": ai_result["hashtags"],
        "photos": photo_records,
    })


@app.route("/api/listings/<listing_id>", methods=["PUT"])
def update_listing(listing_id):
    """Update name, description, or hashtags."""
    data = request.json
    conn = get_db()
    conn.execute(
        "UPDATE listings SET name = ?, description = ?, hashtags = ? WHERE id = ?",
        (data.get("name", ""), data.get("description", ""), data.get("hashtags", ""), listing_id),
    )
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/listings/<listing_id>", methods=["DELETE"])
def delete_listing(listing_id):
    conn = get_db()
    photos = conn.execute(
        "SELECT stored_filename FROM photos WHERE listing_id = ?", (listing_id,)
    ).fetchall()
    for p in photos:
        (UPLOAD_DIR / p["stored_filename"]).unlink(missing_ok=True)
    conn.execute("DELETE FROM photos WHERE listing_id = ?", (listing_id,))
    conn.execute("DELETE FROM listings WHERE id = ?", (listing_id,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


@app.route("/api/listings/<listing_id>/photos", methods=["POST"])
def add_photos(listing_id):
    """Add more photos to an existing listing."""
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


@app.route("/uploads/<path:filename>")
def serve_upload(filename):
    return send_from_directory(UPLOAD_DIR, filename)


if __name__ == "__main__":
    app.run(debug=True, port=5000)
