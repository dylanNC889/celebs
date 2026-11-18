# Home-server version (retired 2026-11-18)

Celebrity Heads first ran in a container on a home Proxmox server. This folder keeps that version for reference:

- `server.py` — the page, as a Python stdlib web server over SQLite. It had the same features as the GitHub version, editing included.
- `export.py` — rendered the read-only static copy that was published to GitHub Pages before the move.
- `manage.py` — command-line editing of the SQLite database.
- `valorant-abilities.py` — pulled agents' abilities from valorant-api.com and tagged the ability types and info.
- `valorant-images.py` — downloaded portraits and full art from valorant-api.com, and made the `thumbs/`, `medium/` and `trimmed/` copies with Pillow.
- `valorant-lore-research.json` and `valorant-omega-research.json` — research notes behind the Lore and Omega fields, including the parts that weren't confirmed.
- `celebrity-heads.db` — the final database. It was converted to `../../data.json`, which is the live data now.

These scripts expect the old paths (`/opt/celebrity-heads`, `/var/lib/celebrity-heads`), so they won't run here as they are.
