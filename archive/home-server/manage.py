#!/usr/bin/env python3
"""Manages the Celebrity Heads database, /var/lib/celebrity-heads/celebrity-heads.db.

  manage.py list                                 categories, their fields and entry counts
  manage.py show CATEGORY [NAME]                 a category's entries, or one entry in full
  manage.py add-category CATEGORY [FIELD ...]    add a category, or replace its field list
  manage.py field CATEGORY FIELD                 add one field, or change an existing one
  manage.py remove-field CATEGORY NAME           drop a field (entries keep the values, unshown)
  manage.py note CATEGORY [TEXT]                 set the line shown under the list page's search box
                                                 (no TEXT clears it)
  manage.py add CATEGORY NAME [FIELD=VALUE ...]  add an entry, or update the given fields of an
                                                 existing one; FIELD= clears that field; tags and
                                                 list values are separated with " | "
  manage.py remove CATEGORY NAME                 remove an entry
  manage.py remove-category CATEGORY             remove a category and all its entries
  manage.py load FILE.json                       add or update categories and entries in bulk:
      {"Category": {"fields": [FIELD, ...],
                    "entries": [["Name", "first field", ...], {"name": "Name", "Field": value}, ...]}}
      "fields" may be left out to keep the category's current fields; "note" sets the category note. Entries update only the fields
      they give; list and tags values are JSON lists.

A FIELD is NAME[:TYPE][:filter][:card|:nocard][:@GROUP][:section=NAME], e.g. Role:text:filter, Lore:long.
  text  one short value (the default; shown on the entry's card)   tags  a list of short values
  list  a list of items; "Label: text" items get a bold label      long  paragraphs of text
  image a picture: a path under /var/lib/celebrity-heads/images, or a URL; the first one on a
        profile shows beside the name
  filter  filter chips on the list page (text and tags only)
  card / nocard  show or hide the value on the entry's card
  @GROUP  put the field's filter under the GROUP tab of the filter panel, e.g. Gender:text:filter:@Lore
  section=NAME  show the field in a profile section called NAME with the other fields naming it

Run as root in CT 108. The web page shows changes on its next load.
"""
import json
import sqlite3
import sys

DB = "/var/lib/celebrity-heads/celebrity-heads.db"
TYPES = ("text", "tags", "list", "long", "image")
SEPARATOR = " | "
SCHEMA = """
CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    fields TEXT NOT NULL DEFAULT '[]',     -- JSON list of field specs, in display order
    position INTEGER NOT NULL DEFAULT 0,   -- tab order on the page
    note TEXT NOT NULL DEFAULT ''          -- shown under the search box on the list page
);
CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY,
    category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    name TEXT NOT NULL COLLATE NOCASE,
    details TEXT NOT NULL DEFAULT '{}',    -- JSON object keyed by field name
    UNIQUE (category_id, name)
);
"""


def connect():
    db = sqlite3.connect(DB)
    db.execute("PRAGMA foreign_keys = ON")
    db.executescript(SCHEMA)
    if "note" not in [row[1] for row in db.execute("PRAGMA table_info(categories)")]:
        db.execute("ALTER TABLE categories ADD COLUMN note TEXT NOT NULL DEFAULT ''")
    return db


def normal(spec):
    """A field spec (string, "Name:type:flags" or dict) as a dict with name and type."""
    if isinstance(spec, dict):
        spec = dict(spec)
    else:
        name, *parts = spec.split(":")
        spec = {"name": name}
        for part in parts:
            if part in TYPES:
                spec["type"] = part
            elif part == "filter":
                spec["filter"] = True
            elif part in ("card", "nocard"):
                spec["card"] = part == "card"
            elif part.startswith("@") and len(part) > 1:
                spec["group"] = part[1:]
            elif part.startswith("section=") and len(part) > 8:
                spec["section"] = part[8:]
            else:
                sys.exit(f"{spec['name']!r}: unknown option {part!r}; use a type ({', '.join(TYPES)}), filter, card, nocard, @Group or section=Name")
    spec["name"] = str(spec.get("name", "")).strip()
    spec.setdefault("type", "text")
    if not spec["name"] or spec["type"] not in TYPES:
        sys.exit(f"bad field {spec!r}")
    if spec.get("filter") and spec["type"] not in ("text", "tags"):
        sys.exit(f"{spec['name']}: only text and tags fields can be filters")
    return spec


def describe(spec):
    flags = [spec["type"]] + (["filter"] if spec.get("filter") else [])
    if "card" in spec:
        flags.append("card" if spec["card"] else "nocard")
    if spec.get("group"):
        flags.append("@" + spec["group"])
    if spec.get("section"):
        flags.append("section=" + spec["section"])
    return f"{spec['name']} ({', '.join(flags)})"


def find_category(db, name):
    row = db.execute("SELECT id, name, fields FROM categories WHERE name = ?", (name,)).fetchone()
    if not row:
        sys.exit(f"No category called {name!r}. See: manage.py list")
    return row[0], row[1], [normal(f) for f in json.loads(row[2])]


def save_fields(db, category_id, fields):
    names = [f["name"].lower() for f in fields]
    if len(names) != len(set(names)) or "name" in names:
        sys.exit("field names must be different from each other and from 'name'")
    db.execute("UPDATE categories SET fields = ? WHERE id = ?", (json.dumps(fields, ensure_ascii=False), category_id))


def add_category(db, name, fields):
    position = db.execute("SELECT COALESCE(MAX(position), 0) + 1 FROM categories").fetchone()[0]
    db.execute("INSERT INTO categories (name, position) VALUES (?, ?) ON CONFLICT(name) DO NOTHING", (name, position))
    category_id = find_category(db, name)[0]
    if fields is not None:
        save_fields(db, category_id, [normal(f) for f in fields])
    return category_id


def coerce(spec, value):
    """A value for a field: lists for tags/list (from " | " text), strings otherwise, None to clear."""
    if value is None or value == "" or value == []:
        return None
    if spec["type"] in ("tags", "list"):
        items = value if isinstance(value, list) else str(value).split(SEPARATOR)
        items = [str(v).strip() for v in items if str(v).strip()]
        return items or None
    if isinstance(value, list):
        sys.exit(f"{spec['name']} is a {spec['type']} field; give it text, not a list")
    return str(value).strip() or None


def save_entry(db, category_id, fields, name, updates):
    """Add an entry or update the given fields of an existing one."""
    name = str(name).strip()
    if not name:
        sys.exit("an entry needs a name")
    by_name = {f["name"].lower(): f for f in fields}
    row = db.execute("SELECT details FROM entries WHERE category_id = ? AND name = ?", (category_id, name)).fetchone()
    details = json.loads(row[0]) if row else {}
    for field, value in updates.items():
        spec = by_name.get(field.lower())
        if not spec:
            sys.exit(f"{name}: no field {field!r}; fields are: {', '.join(f['name'] for f in fields) or '(none)'}")
        value = coerce(spec, value)
        if value is None:
            details.pop(spec["name"], None)
        else:
            details[spec["name"]] = value
    db.execute(
        "INSERT INTO entries (category_id, name, details) VALUES (?, ?, ?) "
        "ON CONFLICT(category_id, name) DO UPDATE SET details = excluded.details",
        (category_id, name, json.dumps(details, ensure_ascii=False)),
    )


def show_value(value):
    return SEPARATOR.join(value) if isinstance(value, list) else value


def main(args):
    if not args or args[0] in ("-h", "--help", "help"):
        print(__doc__.strip())
        return
    command, rest = args[0], args[1:]
    db = connect()
    with db:
        if command == "list" and not rest:
            for category_id, name, raw, note in db.execute("SELECT id, name, fields, note FROM categories ORDER BY position"):
                count = db.execute("SELECT COUNT(*) FROM entries WHERE category_id = ?", (category_id,)).fetchone()[0]
                fields = "; ".join(describe(normal(f)) for f in json.loads(raw))
                print(f"{name}: {count} entries" + (f"; fields: {fields}" if fields else "") + (f"\n  note: {note}" if note else ""))
        elif command == "show" and len(rest) == 1:
            category_id, _, fields = find_category(db, rest[0])
            for name, details in db.execute(
                "SELECT name, details FROM entries WHERE category_id = ? ORDER BY name", (category_id,)
            ):
                values = json.loads(details)
                cells = []
                for f in fields:
                    v = values.get(f["name"])
                    if f["type"] in ("list", "long"):
                        cells.append(f"{f['name']}: {'yes' if v else '-'}")
                    else:
                        cells.append(show_value(v) if v else "-")
                print(" | ".join([name] + cells))
        elif command == "show" and len(rest) == 2:
            category_id, category, fields = find_category(db, rest[0])
            row = db.execute("SELECT name, details FROM entries WHERE category_id = ? AND name = ?",
                             (category_id, rest[1])).fetchone()
            if not row:
                sys.exit(f"{rest[1]!r} isn't in {category}")
            values = json.loads(row[1])
            print(row[0])
            for f in fields:
                v = values.get(f["name"])
                if isinstance(v, list) and f["type"] == "list":
                    print(f"{f['name']}:")
                    for item in v:
                        print(f"  - {item}")
                else:
                    print(f"{f['name']}: {show_value(v) if v else '-'}")
            extra = sorted(set(values) - {f["name"] for f in fields})
            if extra:
                print(f"(also stored, not shown: {', '.join(extra)})")
        elif command == "add-category" and rest:
            add_category(db, rest[0], rest[1:])
            print(f"category {rest[0]!r} saved")
        elif command == "field" and len(rest) == 2:
            category_id, category, fields = find_category(db, rest[0])
            spec = normal(rest[1])
            for i, f in enumerate(fields):
                if f["name"].lower() == spec["name"].lower():
                    fields[i] = spec
                    break
            else:
                fields.append(spec)
            save_fields(db, category_id, fields)
            print(f"{category}: field {describe(spec)} saved")
        elif command == "note" and rest and len(rest) <= 2:
            category_id, category, _ = find_category(db, rest[0])
            db.execute("UPDATE categories SET note = ? WHERE id = ?", (rest[1].strip() if len(rest) == 2 else "", category_id))
            print(f"{category}: note {'saved' if len(rest) == 2 and rest[1].strip() else 'cleared'}")
        elif command == "remove-field" and len(rest) == 2:
            category_id, category, fields = find_category(db, rest[0])
            kept = [f for f in fields if f["name"].lower() != rest[1].lower()]
            if len(kept) == len(fields):
                sys.exit(f"{category} has no field {rest[1]!r}")
            save_fields(db, category_id, kept)
            print(f"{category}: field {rest[1]!r} removed")
        elif command == "add" and len(rest) >= 2:
            category_id, category, fields = find_category(db, rest[0])
            updates = {}
            for pair in rest[2:]:
                field, sep, value = pair.partition("=")
                if not sep:
                    sys.exit(f"{pair!r}: use FIELD=VALUE")
                updates[field] = value
            save_entry(db, category_id, fields, rest[1], updates)
            print(f"{rest[1]!r} saved in {category}")
        elif command == "remove" and len(rest) == 2:
            category_id, category, _ = find_category(db, rest[0])
            gone = db.execute("DELETE FROM entries WHERE category_id = ? AND name = ?", (category_id, rest[1])).rowcount
            print(f"removed {rest[1]!r} from {category}" if gone else f"{rest[1]!r} isn't in {category}")
        elif command == "remove-category" and len(rest) == 1:
            category_id, category, _ = find_category(db, rest[0])
            db.execute("DELETE FROM categories WHERE id = ?", (category_id,))
            print(f"removed category {category!r} and its entries")
        elif command == "load" and len(rest) == 1:
            with open(rest[0], encoding="utf-8") as f:
                data = json.load(f)
            for category, spec in data.items():
                category_id = add_category(db, category, spec.get("fields"))
                if "note" in spec:
                    db.execute("UPDATE categories SET note = ? WHERE id = ?", (str(spec["note"] or "").strip(), category_id))
                fields = find_category(db, category)[2]
                entries = spec.get("entries", [])
                for entry in entries:
                    if isinstance(entry, dict):
                        entry = dict(entry)
                        save_entry(db, category_id, fields, entry.pop("name", ""), entry)
                    else:
                        if len(entry) > len(fields) + 1:
                            sys.exit(f"{category}: {entry!r} has more values than fields")
                        save_entry(db, category_id, fields, entry[0],
                                   {f["name"]: v for f, v in zip(fields, entry[1:])})
                print(f"{category}: {len(entries)} entries loaded")
        else:
            sys.exit(__doc__.strip())


if __name__ == "__main__":
    main(sys.argv[1:])
