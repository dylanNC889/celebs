# Celebrity Heads

A party-game helper: topics (like Valorant agents or book characters), each with names you can search, filter and
randomly pick from, and a profile page per name. Live at **https://dylannc889.github.io/celebs/**.

## How it works

- Everything runs in the browser from GitHub Pages: `index.html`, `app.js` and `style.css`.
- All the data is in **`data.json`**. Each topic has a `note`, its `fields` and its `entries` (`name` plus `details` keyed by field name).
- Pictures are in `img/`:
  - `img/<path>` holds the originals.
  - `img/thumbs/` holds 160px WebP copies for cards and next to names.
  - `img/trimmed/` holds 1200px WebP copies cropped to the figure, for profiles and Random pick.
  - `sized` in `data.json` lists which pictures have those copies.

## Editing

Anyone can look. To edit, tap **Sign in to edit** at the bottom of the page and paste a GitHub token that can write to this repo (a fine-grained token with Contents: read and write). The token stays in that browser only.

Once signed in you can:
- add topics (**+ Topic**) and names (**Add name**);
- rename or remove names;
- ask questions on any name's page.

Every question becomes a filter of its answers, with "Not answered" for names without one. Tap a question to answer it for every name, or to rename or remove it.

Each change is one commit to `data.json`. You see your own changes at once; everyone else sees them once GitHub Pages rebuilds, usually within a minute or two.

## Fields

A topic's `fields` are plain names, or objects of the form `{"name", "type", "filter", "card", "group", "section"}`.

`type` is one of:
- `text`: one short value;
- `tags`: a list of short values;
- `list`: bullet items, where `Label: text` gets a bold label;
- `long`: paragraphs separated by a blank line;
- `image`: a path under `img/`, or a URL.

The other keys:
- `filter` adds filter chips for that field. Text filters match any chosen value; tags filters match all of them.
- `card` shows the value on the name's card.
- `group` puts the filter under a tab with that name.
- `section` gives the field its own section on the profile.

Questions are `text` fields with `"group": "Questions"`.

## archive/

`archive/home-server/` holds the code and database from when this ran on a home server, retired on 2026-11-18.
Those are the Python server, `manage.py`, the Valorant import scripts (abilities and images from valorant-api.com) and the research notes. That database is a snapshot, and `data.json` is the live data now.

---

Celebrity Heads was created under Riot Games' "Legal Jibber Jabber" policy using assets owned by Riot Games. Riot Games does not endorse or sponsor this project.
