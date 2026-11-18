#!/usr/bin/env python3
# Downloads each Valorant agent's portrait (square headshot) and full art from valorant-api.com into
# /var/lib/celebrity-heads/images/valorant/, makes 160px WebP thumbnails of the portraits in
# images/thumbs/valorant/ (used on cards and beside profile names) and 720px WebP copies of the full
# art in images/medium/valorant/ (used in the random pick popup) and 1200px copies of the full art
# cropped to the agent, with the empty see-through sides cut off, in images/trimmed/valorant/ (used
# on profile pages), with python3-pil, then prints a manage.py load file that points the Portrait and Full art fields at them. Existing files are kept
# unless --force is given.
#   python3 -I valorant-images.py > /root/images.json && python3 -I manage.py load /root/images.json
import json
import os
import re
import sys
import urllib.request

API = "https://valorant-api.com/v1/agents?isPlayableCharacter=true&language=en-US"
DIR = "/var/lib/celebrity-heads/images/valorant"
SIZES = {"thumbs": 160, "medium": 720, "trimmed": 1200}  # folder under images/ -> longest side in pixels
TRIM = {"trimmed"}  # folders whose copies are cropped to the picture's visible part
FORCE = "--force" in sys.argv[1:]


def fetch(url):
    with urllib.request.urlopen(url, timeout=60) as reply:
        return reply.read()


def save(url, path):
    if os.path.exists(path) and not FORCE:
        return "kept"
    data = fetch(url)
    if not data.startswith(b"\x89PNG"):
        sys.exit(f"{url}: not a PNG")
    with open(path + ".tmp", "wb") as f:
        f.write(data)
    os.chmod(path + ".tmp", 0o644)
    os.replace(path + ".tmp", path)
    return f"{len(data) // 1024} KB"


def trim_box(im):
    """The box around the visible part of an RGBA image (faint glow below ~10% ignored), plus a 2% margin."""
    box = im.getchannel("A").point(lambda v: 255 if v > 24 else 0).getbbox()
    if not box:
        return (0, 0, im.width, im.height)
    m = round(0.02 * max(box[2] - box[0], box[3] - box[1]))
    return (max(0, box[0] - m), max(0, box[1] - m), min(im.width, box[2] + m), min(im.height, box[3] + m))


def resized(path, folder):
    """Writes images/<folder>/valorant/<name>.webp for an image unless it exists (or --force)."""
    from PIL import Image
    out = os.path.join(os.path.dirname(DIR), folder, "valorant", os.path.splitext(os.path.basename(path))[0] + ".webp")
    os.makedirs(os.path.dirname(out), mode=0o755, exist_ok=True)
    os.chmod(os.path.dirname(os.path.dirname(out)), 0o755)
    if os.path.exists(out) and not FORCE:
        return "kept"
    with Image.open(path) as im:
        im = im.convert("RGBA")
        if folder in TRIM:
            im = im.crop(trim_box(im))
        im.thumbnail((SIZES[folder], SIZES[folder]), Image.LANCZOS)
        im.save(out + ".tmp", "WEBP", quality=85, method=6)
    os.chmod(out + ".tmp", 0o644)
    os.replace(out + ".tmp", out)
    return f"{os.path.getsize(out) // 1024} KB"


os.makedirs(DIR, mode=0o755, exist_ok=True)
agents = json.loads(fetch(API))["data"]
entries = []
for agent in sorted(agents, key=lambda a: a["displayName"].lower()):
    name = agent["displayName"]
    slug = re.sub(r"[^a-z0-9]+", "", name.lower())
    entry = {"name": name}
    for field, key, suffix in (("Portrait", "displayIcon", "portrait"), ("Full art", "fullPortrait", "full")):
        if agent.get(key):
            result = save(agent[key], f"{DIR}/{slug}-{suffix}.png")
            entry[field] = f"valorant/{slug}-{suffix}.png"
            for folder in ("thumbs",) if field == "Portrait" else ("medium", "trimmed"):
                result += f", {folder} {resized(f'{DIR}/{slug}-{suffix}.png', folder)}"
            print(f"{name:10} {field:9} {result}", file=sys.stderr)
    entries.append(entry)
json.dump({"Valorant": {"entries": entries}}, sys.stdout, ensure_ascii=False, indent=1)
