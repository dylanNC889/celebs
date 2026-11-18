#!/usr/bin/env python3
# Renders Celebrity Heads as a read-only static site (for GitHub Pages) and writes it to stdout as a
# tar file: <topic>/index.html (the list), <topic>/<name>.html (profiles), img/ (only the WebP copies
# the pages use), index.html (goes to the first topic), 404.html, README.md and .nojekyll.
# Uses server.py's own page code in its STATIC mode, so both copies look the same. Reads the database
# read-only. Run by /usr/local/bin/celebrity-heads-pages.py on the Proxmox host:
#   pct exec 108 -- python3 -I /opt/celebrity-heads/export.py > site.tar
import io
import os
import re
import sys
import tarfile
import unicodedata
from urllib.parse import urlencode

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import server  # noqa: E402

SITE = "/celebs/"  # where GitHub Pages serves it (used only by 404.html)


def slug(text, taken):
    """A file-name-safe version of text, unique among taken (which it's added to)."""
    base = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()
    base = re.sub(r"[^a-z0-9]+", "-", base).strip("-") or "page"
    out, n = base, 2
    while out in taken:
        out, n = f"{base}-{n}", n + 1
    taken.add(out)
    return out


def main():
    db = server.connect()
    cats = server.categories(db)
    dirs, pages, taken = {}, {}, {"img"}
    for category_id, category, _, _ in cats:
        dirs[category] = slug(category, taken)
        used = {"index"}
        for (name,) in db.execute("SELECT name FROM entries WHERE category_id = ? ORDER BY name", (category_id,)):
            pages[(category, name)] = slug(name, used) + ".html"
    db.close()
    server.STATIC = {"prefix": "../", "dirs": dirs, "pages": pages, "files": set()}

    files = {}
    for _, category, _, _ in cats:
        code, page = server.list_page(urlencode({"c": category}))
        if code != 200:
            sys.exit(f"{category}: list page answered {code}")
        files[f"{dirs[category]}/index.html"] = page.encode()
    for (category, name), page_file in pages.items():
        code, page = server.entry_page(urlencode({"c": category, "n": name}))
        if code != 200:
            sys.exit(f"{category} / {name}: profile answered {code}")
        files[f"{dirs[category]}/{page_file}"] = page.encode()
    for path in sorted(server.STATIC["files"]):
        with open(os.path.join(server.IMAGES, path), "rb") as f:
            files["img/" + path] = f.read()

    first = dirs[cats[0][1]] + "/" if cats else ""
    files["index.html"] = (
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Celebrity Heads</title>'
        f'<meta http-equiv="refresh" content="0; url={first}"></head>'
        f'<body><a href="{first}">Celebrity Heads</a></body></html>').encode()
    files["404.html"] = (
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Not found · Celebrity Heads</title>'
        '<meta name="viewport" content="width=device-width, initial-scale=1"></head>'
        f'<body style="font-family:system-ui,sans-serif;padding:16px">That page isn\'t here. '
        f'<a href="{SITE}">Back to Celebrity Heads</a></body></html>').encode()
    files[".nojekyll"] = b""
    files["README.md"] = (
        "# Celebrity Heads\n\nA read-only copy of a home Celebrity Heads party-game page: topics, filters, "
        "random pick and profiles. It is generated and published automatically; changes made here are overwritten.\n\n"
        + server.RIOT_NOTICE + "\n").encode()

    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w") as tar:
        for path in sorted(files):
            info = tarfile.TarInfo(path)
            info.size, info.mode, info.mtime = len(files[path]), 0o644, 0
            tar.addfile(info, io.BytesIO(files[path]))
    sys.stdout.buffer.write(out.getvalue())


if __name__ == "__main__":
    main()
