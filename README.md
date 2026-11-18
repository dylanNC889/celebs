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

## Logins and editing

The page shows nothing until you log in. That only hides the page: GitHub Pages files such as `data.json` stay public. There are two ways in.

**Players log in** on the login screen that opens first.

- Each player has their own additions on top of the shared topics, and only they see them:
  - their own topics;
  - names added to shared topics;
  - their own questions, with answers for any name.
- Players can't rename or remove shared names, topics or questions.
- A player's additions are saved in `users/<name>.json` on the **`userdata`** branch, which GitHub Pages doesn't build, so saving is instant.
- Players can change their password or log out from their account menu (top right).
- To add a player or reset a password, run `python3 tools/users.py TOKEN_FILE Name Password` in the repo folder. It needs the Python `cryptography` package. Then commit `users.json`.

**Admins** are players with `"admin": true` in `users.json`; Akimei is one. Their account menu, top right, has an **Admin console** where they can:

- work on the shared topics, their own additions, or any player's additions (a bar at the top shows whose data the pages are showing);
- reset any player's password;
- make players admins, or remove their admin rights;
- add players, or remove them together with their additions.

Because every player unlocks the same token, admin is a privilege on the page only, not a security boundary.

**The owner signs in** with **Owner sign-in** (at the bottom of the login screen) and a GitHub token. This edits the shared topics in `data.json`, for everyone.

How a player's login works, and why it isn't secure:

- `users.json` holds one shared GitHub token (fine-grained, this repo only, Contents: read and write), encrypted separately with each player's password (PBKDF2-SHA256 and AES-GCM).
- Logging in decrypts it in the browser, which keeps it until logging out. Each change is then one commit through the GitHub API.
- This keeps players' additions apart, but it is not real security:
  - the repo is public, so anyone can read everyone's `users/*.json`;
  - anyone who guesses a password gets the token, which can change anything in this repo.
- If that happens, revoke the token on GitHub, make a new one, and re-run `tools/users.py` for each player.

Every question becomes a filter of its answers, with "Not answered" for names without one. Tap a question to answer it for every name, or to rename or remove it.

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
