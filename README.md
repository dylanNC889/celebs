# Celebrity Heads

A party-game helper: topics (like Valorant agents or book characters), each with names you can search, filter and
randomly pick from, and a profile page per name. Live at **https://dylannc889.github.io/celebs/**.

The site opens on a home page listing the topics. Tap one to start, or tap "Celebrity Heads" at the top of any page to come back.

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
- A player's additions are saved in `users/<name>.json`. A logged-in player reads them straight from GitHub, so their own changes show at once.
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

**Adding and changing things**, once logged in:

- **Add names:** paste several, one per line. Names that are already there are skipped.
- **Edit details** on a name's page fills in any field you're allowed to change:
  - players: their own fields, and every field of names they added;
  - admins working on the shared topics, and the owner: everything.
- **Fields & filters** on each topic's list page:
  - add fields of four types: one value, several values, a list, or paragraphs;
  - turn each field's filter and "show on cards" on or off;
  - put fields under a filter tab, and rename, reorder and remove them;
  - switch a field between one value and several, which converts the existing values.
  - turn "Players can add names" off for topics with a fixed list of names, like Valorant. Players can change this only on their own topics, and admins on shared ones.
  - **Delete topic**: deletes a topic and all its names, after a confirmation. Players can delete only their own topics; admins on the shared topics and the owner can also delete shared topics. A deleted topic can still be restored from the repo's history.
  - A field in the **Questions** tab is a question, with one-tap answer buttons on each name's page.
  - **Fill in for every name** (from a field's row, or the "Fill it in" link on an empty filter) opens a page with every name and one-tap answers, for any one-value or several-values field. Adding such a field opens that page straight away. A filter shows its choices once at least one name has a value.
- **Questions with several answers** (tick "Several answers" when asking, or make it "Several values" on the fields page): each answer button toggles that answer on or off, and the filter matches names that have all the chosen answers.

**Removing names:** **Remove names** on a topic's list lets you tick several names (players: the ones they added) and remove them in one go.

**AI names (Gemini):** when a Gemini key is set up, logged-in players get two extra options:

- **Pre-load names with AI** on the New topic page, with how many and an optional "which ones";
- **Suggest with AI** in the Add names box, which fills the box with suggestions to check before adding.

It uses a free-tier key. The free tier has no web search, so names come from the model's own knowledge. `users.json` holds the key, encrypted with the players' token (`tools/ai-key.py TOKEN_FILE GEMINI_KEY_FILE`). Anyone who guesses a password could use it, but a free-tier key can only run out of its daily allowance, not cost money.

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
