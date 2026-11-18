# Celebrity Heads — notes for the next agent

A party-game helper for Celebrity Heads (guess who you are). Each **topic** (Valorant agents, book characters, players' own lists) is a list of **names** you can search, filter and randomly pick from, with a profile page per name.

- Live at **https://dylannc889.github.io/celebs/** (GitHub Pages, repo `dylanNC889/celebs`, branch `main`, root folder).
- Built and handed over on 2026-11-18. `README.md` is the user-facing description; this file is the developer handoff.
- Everything runs in the browser. There is no server: the page reads and writes files in this repo through the GitHub API.

## Files

| Path | What |
|---|---|
| `index.html` | page shell and dialogs (owner sign-in, change password). Loads `style.css?v=N` and `app.js?v=N`, currently **v=10**. |
| `app.js` | the whole app (about 1,800 lines, no build step, no dependencies) |
| `style.css` | styles (light and dark) |
| `data.json` | the **shared topics** (Valorant, Book Characters), seen by everyone |
| `users.json` | the players: per player the players' GitHub token encrypted with their password, an optional `admin` flag, and `ai` (the Gemini key, encrypted with that token) |
| `users/<name>.json` | each player's own additions (only that player sees them) |
| `img/` | pictures: originals, `thumbs/` (160px WebP), `trimmed/` (1200px WebP cropped to the figure) |
| `tools/users.py`, `tools/ai-key.py` | add or reset a player; store the Gemini key (both need the token file; neither prints secrets) |
| `tests/` | jsdom tests with a pretend GitHub and Gemini: `sh tests/run.sh` (see `tests/README.md`) |
| `archive/home-server/` | the retired first version (Python + SQLite on a home server) and the Valorant import scripts and research notes |
| `404.html`, `.nojekyll` | Pages helpers |

**Cache busting:** Pages caches files for 10 minutes. When `app.js` or `style.css` changes, bump `?v=N` in `index.html`.

## How it works

### Pages

There is a single page, chosen by the query string. `render()` builds the HTML. Links starting with `?` are handled in place (pushState); there are no reloads.

| Query | Page |
|---|---|
| *(none)* | home: topic cards and "+ New topic" (`homePage`) |
| `?c=Topic` | list: search, filters (tabs by field group), cards, Random pick, Add names, Remove names, Fields & filters (`listPage`) |
| `?c=Topic&n=Name` | profile: details, Edit details, Questions (one tap saves), sections, pager (`entryPage`) |
| `?c=Topic&ask=Field` | every name for one question or field: tap to mark, then **Save** at the bottom (`questionPage` + `initFill`, op `fillMany`) |
| `?c=Topic&fields=1` | Fields & filters: Add a field, the Names setting and Delete topic on the left; fields on the right (`fieldsPage`) |
| `?new` | new topic, with an optional AI pre-load (`newTopicPage`, `addTopicWithAi`) |
| `?admin` | admin console (`adminPage`) |

Nothing shows until someone logs in, and nothing is loaded before then. This only hides the page: the data files are public.

### Who can do what (`MODE`, `TARGET`)

| Login | Sees | Can change |
|---|---|---|
| Not logged in (`view`) | the login screen only | nothing |
| **Player** (`user`): username and password from `users.json` | shared topics plus their own additions | their own topics, names, fields and questions; their answers on shared names; their own fields' values on shared names. Not shared names, fields or topics (`mustOwn`, `mine`). |
| **Admin player** (`"admin": true`, currently Akimei) | the same, plus the **Admin console** | the console's **Work on** sets `TARGET` to their own data, `*shared*` (data.json, for everyone) or another player's file (commits are signed "Akimei for X:"). They can also reset passwords, set admin on or off, and add or remove players. |
| **Owner sign-in** (`admin`): a GitHub token pasted in | shared topics | everything in `data.json`. No admin console and no AI. |

Every player unlocks the **same** GitHub token, so "admin" is a privilege on the page only, not a security boundary.

### Data

- **`data.json`** is `{topics: [{name, note, noNewNames?, fields: [...], entries: [{name, details: {field: value}}]}], sized: {thumbs: [...], trimmed: [...]}}`.
  - Topic order is the home and tab order.
  - It's saved as `JSON.stringify(data, null, 1) + "\n"`, which is byte-identical to Python's `json.dumps(indent=1, ensure_ascii=False) + "\n"`. Keep that format so diffs stay small.
- **A field** is a plain name, or `{name, type, filter, card, group, section, blank}`.
  - `type` is one of `text` (one value), `tags` (several values), `list` (bullet items), `long` (paragraphs) or `image`.
  - `filter` adds chips: any-of for text, all-of for tags. A text filter with more than 8 values becomes a drop-down.
  - `card` shows the value on cards. `group` is the filter tab. `section` gives the field its own profile section.
  - `blank` is the word shown for names with no value. The default is "Unknown" for questions and text fields and "None" for tags. If a real answer is already called Unknown, blanks show as "Not set". Valorant's Omega fields use `"blank": "None"`.
- **A question** is a `text` or `tags` field with `group: "Questions"` (and normally `filter: true, card: false`). `tags` questions take several answers.
- **`noNewNames: true`** on a topic hides Add names and refuses adding (Valorant). It's the "Players can add names" setting.
- **A player's file** is `{topics: [own topics], extra: {"<shared topic>": {fields: [own fields], entries: [names they added], answers: {"<shared name>": {"<field>": value or null}}}}}`. `null` means a shared answer the player cleared.
  - `merge(BASE, OVER)` builds what a player sees, marking their own things with `own: true`. `split(BASE, data)` turns an edited copy back into the file.
  - The `own` flags are never saved.
- **Changes** are functions in `OPS` (`addTopic`, `removeTopic`, `addName`, `removeNames`, `renameName`, `removeName`, `answer`, `fillMany`, `editDetails`, `addField`, `updateField`, `moveField`, `removeField`, `topicSettings`, `renameQuestion`, `removeQuestion`).
  - Each takes a copy of the data and the form, changes the copy or throws `Bad` with a message for the user, and returns `{url, message, note}`.
  - `commit()` runs the change on a fresh copy and PUTs the file through the contents API with its sha. On a 409 (someone saved first) it reloads and redoes the change, up to 3 times. Nothing is sent when nothing changed.
- **Players' files are on `main`** too (the user didn't want separate branches), so every save triggers a Pages build.
  - Logged-in people read through the API, so they see changes at once.
  - GitHub's soft limit of about 10 Pages builds an hour can delay the public copy, but everyone is logged in anyway.

### Logins and keys (simple, deliberately not secure — the owner chose this over a Cloudflare backend)

- **Players:** `users.json` `users[]` = `{name, salt, iter: 250000, iv, key, admin?}`. The player's password goes through PBKDF2-SHA256 to give an AES-256-GCM key (associated data: the lowercased name), which decrypts the **players' token**.
  - The players' token is a fine-grained token, only for this repo, with Contents read and write and no Administration. It expires 2027-02-16.
- **AI:** `users.json` `ai` = `{iv, key}` holds the Gemini key, encrypted with AES-GCM using SHA-256 of the players' token as the key (associated data `"celebs-ai"`).
- **In the browser:** both are decrypted and kept in localStorage (`ch-token`, `ch-user`, `ch-mode`, `ch-admin`) until logout. users.json is re-read on every load, which updates admin rights and logs out removed players.
- **Never commit a token or key in plain text.**
- **Never** encrypt the owner's own GitHub token into `users.json`. It has Administration rights (it could delete the repo), and the passwords are guessable.
- **To rotate the players' token:**
  1. Make a new fine-grained token.
  2. Run `tools/users.py TOKEN_FILE Name Password` for every player. This resets their passwords, so tell them.
  3. Run `tools/ai-key.py TOKEN_FILE GEMINI_KEY_FILE`.
  4. Commit `users.json`. The owner keeps the token files outside the repo.

### AI names (Gemini, free tier)

- `suggestNames()` POSTs to `https://generativelanguage.googleapis.com/v1beta/models/<model>:generateContent` from the browser. CORS allows this site. The header is `x-goog-api-key`, and the request uses `generationConfig: {responseMimeType: "application/json", responseJsonSchema: {names: [string]}}`.
- **Models:** `gemini-3.5-flash-lite` first (about 2.5 s for 30 names); after a retry on 5xx, `gemini-3.8-flash` as backup (it was often overloaded in November 2026). A 429 means the free daily allowance is used up; it resets at midnight US Pacific time.
- **No web search:** the free tier doesn't include Google Search grounding, so names come from the model's knowledge. Grounding needs billing (5,000 free searches a month, then $14 per 1,000).
- The owner prefers Gemini or OpenAI over Claude for app features.

## Working on it

- **Test:** `sh tests/run.sh`. All 10 files, 135 checks, pass as of 2026-11-18. Add or adjust checks with every change. No one has run automated checks in a real browser; the owner uses it on a phone.
- **Deploy:** commit to `main` (git push, or the GitHub API: blobs, then tree with `base_tree`, then commit, then update the ref). Pages rebuilds in about 1–5 minutes.
  - Confirm it's live by fetching `https://dylannc889.github.io/celebs/` and checking for the new `?v=`. Then compare the live `app.js` with yours.
- **Before editing `data.json` or `users.json` from outside the page,** fetch the current copy first. Players and admins change them from the page.
- **Style:** keep app.js dependency-free and readable; plain functions, short comments where something isn't obvious. Escape everything shown in HTML with `esc()`.

## What the owner decided (2026-11-18), in order

1. Moved off the home server to GitHub Pages. The home copy was retired and a backup kept on the server.
2. Valorant's art is included, with Riot's "Legal Jibber Jabber" notice in the footer. The repo is public.
3. Logins: GitHub-only and not secure (chosen over Cloudflare). Shared topics plus each player's own additions. Players: Akimei, SidewaysAsian, RyanCarins, Cheezie, Kyndemoo. Their starting passwords were given to them directly.
4. A login is needed to see anything.
5. Akimei is an admin, with an admin console; the account menu is top right.
6. Bulk names, Edit details, Fields & filters, several-answer questions.
7. Valorant has a fixed list of names. Fields & filters puts Add a field on the left and the fields on the right.
8. No separate branches: everything is committed to `main`.
9. AI pre-load with a new free Gemini key; Remove names with ticks; Delete topic.
10. Home page with a topic list instead of opening Valorant.
11. Fields can be filled in for every name; empty filters say so; one Save button on that page.
12. Blank values show as "Unknown", not "None".

## Open items and ideas

- Both GitHub tokens expire on 2027-02-16 (the owner's and the players'). After that, saving stops until they're replaced; see rotation above.
- A player's single-name Questions section still saves on each tap. Only the every-name page has the Save bar; the user asked only for that page.
- The `blank` word can only be set in `data.json` or a player's file, not from Fields & filters.
- New topics can't have pictures; only Valorant has images.
- Ideas not started: export a topic as CSV, add a real backend if the security trade-off ever matters.
