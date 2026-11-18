#!/usr/bin/env python3
# Celebrity Heads: serves the game's categories from /var/lib/celebrity-heads/celebrity-heads.db as a
# phone-friendly web page. "/" shows one tab per category with search, filter chips and a card per
# entry; "/entry?c=CATEGORY&n=NAME" is that entry's profile page. Change the data with manage.py
# (same folder); pages read the database on every load. /health answers 200 while the database has a
# category, for the Homepage tile's dot.
#
# A category's fields (categories.fields, JSON) are plain names or {"name", "type", "filter", "card"}:
#   type "text" one short value      "tags" a list of short values
#        "list" a list of items, shown as bullets; "Label: text" items get a bold label
#        "long" paragraphs of text (blank line between paragraphs)
#        "image" a picture: a path under /var/lib/celebrity-heads/images (served at /img/) or a URL.
#                The first image field shows on cards and right of the profile's name (as its
#                images/thumbs/<path>.webp thumbnail when one exists); others get a profile section.
#   filter: true  gives the list page filter chips for the field (text and tags only); entries match
#                 any chosen text value, and all chosen tags. When some entries have no value for the
#                 field, a "None" option at the end picks those.
#   card:   true  shows the field's value on the entry's card (default for text fields)
#   group:  NAME  puts the field's filter under a tab of that name in the filter panel (when filters
#                 use more than one group)
#   section: NAME shows the field in its own profile section of that name (with any other fields
#                 naming it) instead of in Details or a section of its own; empty values are skipped
# A category's note (categories.note) shows under the search box on its list page.
#
# Editing on the page (topics are categories): "+ Topic" (/new) adds a category, "Add name" adds an
# entry, and each profile has a Questions section. A question is a text field in the "Questions" group
# with a filter and no card, so every question becomes a filter of its answers (and "Not answered").
# Answering a new question on a profile creates it; /question?c=&q= answers one question for every
# name, and renames or removes it. Profiles can be renamed or removed; a topic can be removed only
# while it has no names. Writes are form POSTs, refused when they come from another site.
import html
import json
import os
import sqlite3
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, unquote, urlencode, urlsplit

DB = "/var/lib/celebrity-heads/celebrity-heads.db"
ADDRESS = ("0.0.0.0", 80)
TYPES = ("text", "tags", "list", "long", "image")
IMAGES = "/var/lib/celebrity-heads/images"  # served at /img/; image field values are paths under it (or URLs)
IMAGE_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}
SELECT_OVER = 8  # a text filter with more values than this is a drop-down instead of chips
NONE = "(none)"  # filter value for entries with nothing in that field, shown as a "None" option
QUESTIONS = "Questions"  # the field group that holds questions asked on the page
YES_NO = ["Yes", "No"]  # answer buttons for a question until it has other answers
LIMITS = {"topic": 60, "note": 300, "name": 80, "question": 120, "answer": 80}  # longest text accepted
# Set by export.py to render the read-only copy for GitHub Pages: relative links to static files, no
# editing controls, the trimmed WebP in place of each big PNG, a Riot notice at the bottom, and every
# image used recorded in STATIC["files"] for copying. None on the home server.
#   {"prefix": "../", "dirs": {category: dir}, "pages": {(category, name): "page.html"}, "files": set()}
STATIC = None
RIOT_NOTICE = ("Celebrity Heads was created under Riot Games' \"Legal Jibber Jabber\" policy using assets owned by "
               "Riot Games. Riot Games does not endorse or sponsor this project.")

esc = html.escape


class Bad(Exception):
    """A write that can't be done; the message is shown to the user."""


def connect():
    return sqlite3.connect(f"file:{DB}?mode=ro", uri=True)


@contextmanager
def writing():
    """A read-write connection inside one transaction that holds the write lock from the start."""
    db = sqlite3.connect(DB, timeout=10, isolation_level=None)
    try:
        db.execute("PRAGMA foreign_keys = ON")
        db.execute("BEGIN IMMEDIATE")
        try:
            yield db
        except BaseException:
            db.execute("ROLLBACK")
            raise
        db.execute("COMMIT")
    finally:
        db.close()


def category_note(db, category_id):
    try:
        row = db.execute("SELECT note FROM categories WHERE id = ?", (category_id,)).fetchone()
    except sqlite3.OperationalError:  # database from before notes
        return ""
    return (row[0] or "").strip() if row else ""


def categories(db):
    return db.execute(
        "SELECT c.id, c.name, c.fields, COUNT(e.id) FROM categories c "
        "LEFT JOIN entries e ON e.category_id = c.id GROUP BY c.id ORDER BY c.position, c.name"
    ).fetchall()


def field_specs(raw):
    specs = []
    for f in json.loads(raw):
        if isinstance(f, str):
            f = {"name": f}
        kind = f.get("type", "text")
        kind = kind if kind in TYPES else "text"
        specs.append({
            "name": f["name"],
            "type": kind,
            "filter": bool(f.get("filter")) and kind in ("text", "tags"),
            "card": bool(f.get("card", kind == "text")) and kind in ("text", "tags"),
            "group": str(f.get("group") or ""),
            "section": str(f.get("section") or ""),
            "question": kind == "text" and f.get("group") == QUESTIONS and not f.get("section"),
        })
    return specs


def values(spec, details):
    """A field's values for one entry, as a list of non-empty strings."""
    raw = details.get(spec["name"])
    items = raw if isinstance(raw, list) else [] if raw is None else [raw]
    return [str(v).strip() for v in items if str(v).strip()]


def entry_url(category, name):
    if STATIC:
        return f'{STATIC["prefix"]}{STATIC["dirs"][category]}/{STATIC["pages"][(category, name)]}'
    return "/entry?" + urlencode({"c": category, "n": name})


def list_url(category):
    if STATIC:
        return f'{STATIC["prefix"]}{STATIC["dirs"][category]}/'
    return "/?" + urlencode({"c": category})


STYLE = """
:root { --bg: #f6f7f9; --card: #ffffff; --text: #1d2330; --muted: #5f6b7a; --line: #dde2e8;
  --head: #eef1f5; --accent: #3b6fd8; --on-accent: #ffffff; }
@media (prefers-color-scheme: dark) { :root { --bg: #11151c; --card: #1a2029; --text: #e6e9ee;
  --muted: #9aa5b4; --line: #2b3340; --head: #222a35; --accent: #7aa2f7; --on-accent: #10141b; } }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 16px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
header { padding: 16px 16px 12px; border-bottom: 1px solid var(--line); }
h1 { margin: 0 0 10px; font-size: 1.4rem; }
main { padding: 12px 16px 32px; max-width: 960px; }
button, input, select { font: inherit; color: var(--text); }
.tabs { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 10px; }
.tabs a { flex: none; padding: 7px 14px; border-radius: 999px; border: 1px solid var(--line);
  background: var(--card); color: var(--text); text-decoration: none; font-weight: 500; }
.tabs a span { color: var(--muted); font-weight: 400; margin-left: 4px; }
.tabs a[aria-current=page] { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.tabs a[aria-current=page] span { color: inherit; opacity: 0.8; }
input[type=search] { width: 100%; padding: 10px 12px; font-size: 1rem; background: var(--card);
  border: 1px solid var(--line); border-radius: 8px; }
input[type=search]:focus, select:focus, .chip:focus-visible, .card:focus-visible {
  outline: 2px solid var(--accent); outline-offset: 1px; }
.filters { margin-top: 10px; }
.filters summary { cursor: pointer; font-weight: 600; padding: 4px 0; }
.filters summary span { color: var(--muted); font-weight: 400; }
.filter { display: flex; align-items: baseline; gap: 10px; margin-top: 8px; }
.filter .label { flex: none; width: 5.6rem; color: var(--muted); font-size: 0.85rem; }
.ftabs { display: flex; margin: 6px 0 2px; border-bottom: 1px solid var(--line); }
.ftab { padding: 7px 14px; margin-bottom: -1px; border: 0; border-bottom: 2px solid transparent;
  background: none; color: var(--muted); font-weight: 600; cursor: pointer; }
.ftab[aria-selected=true] { color: var(--text); border-bottom-color: var(--accent); }
.ftab:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.ftab .n { margin-left: 6px; padding: 0 6px; border-radius: 999px; font-size: 0.75rem;
  background: var(--accent); color: var(--on-accent); }
.ftab .n:empty { display: none; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { padding: 5px 11px; border-radius: 999px; border: 1px solid var(--line); background: var(--card);
  font-size: 0.9rem; cursor: pointer; }
.chip .n { color: var(--muted); margin-left: 4px; font-size: 0.8rem; }
.chip[aria-pressed=true] { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.chip[aria-pressed=true] .n { color: inherit; opacity: 0.8; }
.chip.zero { opacity: 0.45; }
span.chip { cursor: default; }
select { padding: 6px 8px; background: var(--card); border: 1px solid var(--line); border-radius: 8px;
  max-width: 100%; }
.clear { margin-top: 10px; padding: 0; border: 0; background: none; color: var(--accent); cursor: pointer; }
.count { color: var(--muted); font-size: 0.85rem; margin: 0; }
.tools { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.btn { display: inline-block; padding: 8px 14px; border-radius: 8px; border: 1px solid var(--line);
  background: var(--card); color: var(--text); text-decoration: none; font-size: 0.95rem; cursor: pointer; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
.btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
dialog.pick { width: min(92vw, 360px); padding: 22px 18px 18px; border: 1px solid var(--line); border-radius: 12px;
  background: var(--card); color: var(--text); text-align: center; }
dialog.pick::backdrop { background: rgba(0, 0, 0, 0.55); }
.pick-art { display: block; width: 100%; height: min(50vh, 420px); margin: -6px 0 12px; object-fit: contain;
  border-radius: 8px; background: radial-gradient(circle at 50% 30%, #2e3a52, #121722); }
.pick-name { margin: 2px 0 4px; font-size: 2rem; font-weight: 700; line-height: 1.15; overflow-wrap: anywhere; }
.pick-meta { margin: 0; color: var(--muted); }
.pick-left { margin: 6px 0 16px; color: var(--muted); font-size: 0.8rem; }
.pick-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 8px; }
.card { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; padding: 10px 12px; background: var(--card); border: 1px solid var(--line);
  border-radius: 8px; color: var(--text); text-decoration: none; }
.card:hover { border-color: var(--accent); }
.card .text { min-width: 0; }
.card .name { display: block; font-weight: 600; }
.thumb { width: 48px; height: 48px; flex: none; border-radius: 8px; object-fit: cover;
  background: radial-gradient(circle at 50% 30%, #2e3a52, #121722); }
.card .meta { display: block; color: var(--muted); font-size: 0.85rem; }
.note { margin: 8px 0 0; color: var(--muted); font-size: 0.85rem; }
.profile dl + p { margin-top: 10px; }
.empty { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 16px; }
.who { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
.who h1 { margin: 0; }
.avatar { width: 76px; height: 76px; flex: none; border-radius: 14px; border: 1px solid var(--line);
  background: radial-gradient(circle at 50% 30%, #2e3a52, #121722); object-fit: cover; }
.art img { display: block; width: 100%; max-height: 75vh; object-fit: contain; border-radius: 8px;
  background: radial-gradient(circle at 50% 30%, #2e3a52, #121722); }
.back { display: inline-block; margin-bottom: 8px; color: var(--accent); text-decoration: none; font-weight: 500; }
/* Profile with a side picture (the trimmed copy, cut to the figure): on phones Details left and the
   picture right, at least as tall as the old full-width picture (sides cropped if needed), the rest
   full width below; on wide screens all info left and the whole picture pinned right, up to 75vh tall
   as it was full width. */
.profile.has-art { display: grid; grid-template-columns: minmax(0, 1fr) 48%; column-gap: 12px; align-items: start; }
.profile.has-art > * { grid-column: 1 / -1; }
.profile.has-art > .details { grid-column: 1; grid-row: 1; }
.art-col { grid-column: 2 !important; grid-row: 1; align-self: stretch; margin: 0 0 12px; }
.art-col a { display: block; height: 100%; }
.art-col img { display: block; width: 100%; height: 100%; min-height: min(calc((100vw - 32px) * 0.9), 75vh);
  object-fit: cover; object-position: 50% 0;
  border: 1px solid var(--line); border-radius: 8px; background: radial-gradient(circle at 50% 30%, #2e3a52, #121722); }
@media (max-width: 759px) {
  .profile.has-art .details dl { grid-template-columns: 1fr; gap: 0; }
  .profile.has-art .details dd { margin-bottom: 6px; }
}
@media (min-width: 760px) {
  main:has(.profile.has-art) { max-width: 1240px; }
  .profile.has-art { grid-template-columns: minmax(0, 1fr) auto; column-gap: 20px; }
  .profile.has-art > * { grid-column: 1; }
  .profile.has-art > .pager { grid-column: 1 / -1; }
  .art-col { grid-row: 1 / span 40; align-self: start; position: sticky; top: 12px; }
  .art-col a { height: auto; }
  .art-col img { width: auto; height: auto; min-height: 0; max-width: min(50vw, 620px); max-height: 75vh; object-fit: contain; }
}
.profile section { background: var(--card); border: 1px solid var(--line); border-radius: 8px;
  padding: 12px 14px; margin-bottom: 12px; }
.profile h2 { margin: 0 0 8px; font-size: 1.05rem; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; }
dt { color: var(--muted); }
dd { margin: 0; }
.items { margin: 0; padding-left: 1.2rem; }
.items li + li { margin-top: 8px; }
.profile p { margin: 0; }
.profile p + p { margin-top: 10px; }
.missing { color: var(--muted); font-style: italic; }
.pager { display: flex; justify-content: space-between; gap: 8px; }
.pager a { padding: 8px 12px; background: var(--card); border: 1px solid var(--line); border-radius: 8px;
  color: var(--text); text-decoration: none; }
/* Editing: topics, names and questions */
.tabs a.add { color: var(--accent); border-style: dashed; }
.filter.wide { display: block; }
.filter.wide .label { display: block; width: auto; margin-bottom: 4px; }
.field { display: block; width: 100%; padding: 10px 12px; font-size: 1rem; background: var(--card);
  border: 1px solid var(--line); border-radius: 8px; color: var(--text); }
.field:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
.form { display: grid; gap: 10px; }
.form label { display: grid; gap: 4px; color: var(--muted); font-size: 0.9rem; }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.row .btn.primary { order: 9; margin-left: auto; }
.btn.danger { color: #d64545; border-color: #d64545; }
.qrow { padding: 10px 0; border-top: 1px solid var(--line); }
.qrow:first-of-type { border-top: 0; padding-top: 0; }
.qtext { margin: 0 0 6px !important; font-weight: 600; }
.qtext a { color: var(--text); text-decoration: none; }
.qtext a::after { content: " ›"; color: var(--muted); }
.qrow .missing { font-weight: 400; font-size: 0.85rem; margin-left: 6px; }
.chip.clear { color: var(--muted); border-style: dashed; }
.other { margin-top: 6px; }
.other summary, .edit summary { cursor: pointer; color: var(--accent); font-size: 0.9rem; }
.other form { display: flex; gap: 6px; margin-top: 6px; }
.other .field { padding: 6px 10px; }
.addq { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); }
.addq h3 { margin: 0 0 8px; font-size: 0.95rem; }
.edit { margin-bottom: 12px; }
.edit[open] { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; }
.edit form + form { margin-top: 12px; }
.tools .row { flex-wrap: nowrap; }
dialog.add { width: min(92vw, 400px); padding: 18px; border: 1px solid var(--line); border-radius: 12px;
  background: var(--card); color: var(--text); }
dialog.add::backdrop { background: rgba(0, 0, 0, 0.55); }
dialog.add h2 { margin: 0 0 10px; font-size: 1.1rem; }
.empty .form { margin-top: 12px; }
.foot { padding: 4px 16px 24px; max-width: 960px; color: var(--muted); font-size: 0.75rem; }
"""

LIST_SCRIPT = """
const box = document.getElementById("q");
const groups = [...document.querySelectorAll(".filter")];
const count = document.getElementById("count");
const active = document.getElementById("active");
const clear = document.getElementById("clear");
const tabs = [...document.querySelectorAll(".ftab")];
const panes = [...document.querySelectorAll(".fgroup")];
const tabOf = groups.map(g => { const pane = g.closest(".fgroup"); return pane ? pane.dataset.tab : null; });
let tab = "0";
function showTab(t) {
  tab = t;
  for (const b of tabs) b.setAttribute("aria-selected", b.dataset.tab === t);
  for (const p of panes) p.hidden = p.dataset.tab !== t;
}
const cards = [...document.querySelectorAll(".card")].map(el => ({
  el, f: JSON.parse(el.dataset.f), s: el.dataset.s }));

function chosen(g) {
  if (g.dataset.kind === "select") {
    const v = g.querySelector("select").value;
    return v ? [v] : [];
  }
  return [...g.querySelectorAll(".chip[aria-pressed=true]")].map(b => b.dataset.value);
}
function passes(card, g, values) {
  if (!values.length) return true;
  const has = card.f[g.dataset.field] || [];
  return g.dataset.mode === "all" ? values.every(v => has.includes(v)) : values.some(v => has.includes(v));
}
function update() {
  const q = box.value.trim().toLowerCase();
  const state = groups.map(g => [g, chosen(g)]);
  const searched = cards.filter(c => !q || c.s.includes(q));
  let shown = 0;
  for (const c of cards) {
    const hit = searched.includes(c) && state.every(([g, v]) => passes(c, g, v));
    c.el.hidden = !hit;
    if (hit) shown++;
  }
  // Each chip counts the entries it would leave, given the search and the other filters.
  for (const [g, values] of state) {
    if (g.dataset.kind === "select") continue;
    const base = searched.filter(c => state.every(([h, v]) => h === g || passes(c, h, v)));
    for (const chip of g.querySelectorAll(".chip")) {
      const v = chip.dataset.value;
      const want = g.dataset.mode === "all" ? [...new Set([...values, v])] : [v];
      const n = base.filter(c => passes(c, g, want)).length;
      chip.querySelector(".n").textContent = n;
      chip.classList.toggle("zero", n === 0);
    }
  }
  const picked = state.reduce((n, [, v]) => n + v.length, 0);
  for (const b of tabs) {
    const n = state.reduce((n, [, v], i) => n + (tabOf[i] === b.dataset.tab ? v.length : 0), 0);
    b.querySelector(".n").textContent = n || "";
  }
  if (active) active.textContent = picked ? `(${picked} on)` : "";
  if (clear) clear.hidden = !picked;
  count.textContent = q || picked ? `${shown} of ${cards.length} match` : `${cards.length} in this category`;

  const params = new URLSearchParams({ c: document.body.dataset.category });
  if (q) params.set("q", box.value.trim());
  if (tabs.length && tab !== "0") params.set("ft", tab);
  for (const [g, values] of state) for (const v of values) params.append("f:" + g.dataset.field, v);
  history.replaceState(null, "", "?" + params);
  try { sessionStorage.setItem("ch-list", location.search); } catch (e) {}
}

const start = new URLSearchParams(location.search);
box.value = start.get("q") || "";
if (tabs.length) showTab(tabs.some(b => b.dataset.tab === start.get("ft")) ? start.get("ft") : "0");
for (const b of tabs) b.addEventListener("click", () => { showTab(b.dataset.tab); update(); });
for (const g of groups) {
  const wanted = start.getAll("f:" + g.dataset.field);
  if (g.dataset.kind === "select") {
    const select = g.querySelector("select");
    select.value = wanted.find(v => [...select.options].some(o => o.value === v)) || "";
    select.addEventListener("change", update);
  } else {
    for (const chip of g.querySelectorAll(".chip")) {
      chip.setAttribute("aria-pressed", wanted.includes(chip.dataset.value));
      chip.addEventListener("click", () => {
        chip.setAttribute("aria-pressed", chip.getAttribute("aria-pressed") !== "true");
        update();
      });
    }
  }
}
box.addEventListener("input", update);
// Random pick from the cards currently shown; no repeats until every shown card has come up.
const pickBox = document.getElementById("pick");
const picked = new Set();
function pick() {
  const pool = cards.filter(c => !c.el.hidden);
  if (!pool.length) return;
  let fresh = pool.filter(c => !picked.has(c.el));
  if (!fresh.length) { picked.clear(); fresh = pool; }
  const c = fresh[Math.floor(Math.random() * fresh.length)];
  picked.add(c.el);
  const meta = c.el.querySelector(".meta");
  const name = c.el.querySelector(".name").textContent;
  const art = pickBox.querySelector(".pick-art");
  art.hidden = !c.el.dataset.art;
  if (c.el.dataset.art && art.getAttribute("src") !== c.el.dataset.art) {
    // Blank until the new picture has loaded, so the last agent's art never shows under this name.
    art.style.visibility = "hidden";
    art.onload = art.onerror = () => { art.style.visibility = ""; };
    art.src = c.el.dataset.art;
  }
  art.alt = name;
  pickBox.querySelector(".pick-name").textContent = name;
  pickBox.querySelector(".pick-meta").textContent = meta ? meta.textContent : "";
  const left = fresh.length - 1;
  pickBox.querySelector(".pick-left").textContent = pool.length < 2 ? "Only one to pick from"
    : left ? `${left} of ${pool.length} not picked yet` : `All ${pool.length} picked; starting over next time`;
  document.getElementById("open").href = c.el.getAttribute("href");
  if (!pickBox.open) pickBox.showModal();
}
document.getElementById("random").addEventListener("click", pick);
document.getElementById("again").addEventListener("click", pick);
document.getElementById("close").addEventListener("click", () => pickBox.close());
pickBox.addEventListener("click", e => { if (e.target === pickBox) pickBox.close(); });
if (clear) clear.addEventListener("click", () => {
  for (const g of groups) {
    if (g.dataset.kind === "select") g.querySelector("select").value = "";
    else for (const chip of g.querySelectorAll(".chip")) chip.setAttribute("aria-pressed", "false");
  }
  update();
});
update();
"""

ENTRY_SCRIPT = """
// Back to the list with the search and filters it had, if this tab came from that category's list.
try {
  const saved = sessionStorage.getItem("ch-list");
  const back = document.querySelector(".back");
  if (saved && new URLSearchParams(saved).get("c") === document.body.dataset.category)
    back.href = back.getAttribute("href").split("?")[0] + saved;
} catch (e) {}
"""

COMMON_SCRIPT = """
// Forms that remove things ask first.
for (const f of document.querySelectorAll("form[data-confirm]"))
  f.addEventListener("submit", e => { if (!confirm(f.dataset.confirm)) e.preventDefault(); });
// "Add name" opens its dialog.
const addBox = document.getElementById("add");
if (addBox) {
  document.getElementById("addbtn").addEventListener("click", () => { addBox.showModal(); addBox.querySelector("input[name=n]").focus(); });
  document.getElementById("addclose").addEventListener("click", () => addBox.close());
  addBox.addEventListener("click", e => { if (e.target === addBox) addBox.close(); });
}
"""


def shell(title, category, header, content, script=""):
    script = (script or "") + COMMON_SCRIPT
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        f"<title>{esc(title)}</title><style>{STYLE}</style></head>"
        f'<body data-category="{esc(category)}"><header>{header}</header>'
        f"<main>{content}</main>"
        + (f'<footer class="foot">Read-only copy. {esc(RIOT_NOTICE)}</footer>' if STATIC else "")
        + f"<script>{script}</script></body></html>"
    )


def tabs(cats, current):
    links = []
    for _, name, _, count in cats:
        mark = ' aria-current="page"' if current and name == current else ""
        links.append(f'<a href="{esc(list_url(name))}"{mark}>{esc(name)}<span>{count}</span></a>')
    if not STATIC:
        links.append('<a class="add" href="/new">+ Topic</a>')
    return f'<nav class="tabs">{"".join(links)}</nav>'


def hidden(**fields):
    return "".join(f'<input type="hidden" name="{k}" value="{esc(v)}">' for k, v in fields.items())


def question_url(category, question):
    return "/question?" + urlencode({"c": category, "q": question})


def name_form(category, cancel=""):
    return (f'<form method="post" action="/entry/add" class="form">{hidden(c=category)}'
            f'<label>Name<input class="field" name="n" required maxlength="{LIMITS["name"]}" autocomplete="off" '
            f'placeholder="e.g. Harry Potter"></label><div class="row">'
            f'<button class="btn primary">Add</button>{cancel}</div></form>')


def answer_order(value):
    """Sort key for answers: Yes, then No, then the rest A to Z."""
    return (YES_NO.index(value) if value in YES_NO else len(YES_NO), value.lower())


def answer_options(spec, all_details):
    """The answer buttons for a question: Yes/No while it has no other answers, else the answers used."""
    used = sorted({v for d in all_details for v in values(spec, d)}, key=answer_order)
    return YES_NO if all(v in YES_NO for v in used) else used


def answer_controls(category, name, spec, current, options, back):
    """One-tap answer buttons (plus Clear), and an "Other…" box for any other answer."""
    keep = hidden(c=category, n=name, q=spec["name"], back=back)
    shown = options + ([current] if current and current not in options else [])
    chips = "".join(f'<button class="chip" name="pick" value="{esc(o)}" aria-pressed="{"true" if o == current else "false"}">'
                    f"{esc(o)}</button>" for o in shown)
    if current:
        chips += '<button class="chip clear" name="clear" value="1">Clear</button>'
    return (f'<form method="post" action="/answer" class="chips">{keep}{chips}</form>'
            f'<details class="other"><summary>Other answer…</summary><form method="post" action="/answer">{keep}'
            f'<input class="field" name="a" maxlength="{LIMITS["answer"]}" required placeholder="Type an answer" '
            f'aria-label="Other answer"><button class="btn">Save</button></form></details>')


def find_category(cats, wanted):
    return next((c for c in cats if c[1].lower() == wanted.lower()), None)


def label(value, spec=None):
    if value != NONE:
        return value
    return "Not answered" if spec and spec["question"] else "None"


def filters(specs, entries):
    groups = {}  # tab name -> filter rows, in field order
    for spec in specs:
        if not spec["filter"]:
            continue
        counts, empty = {}, 0
        for _, details in entries:
            got = values(spec, details)
            empty += not got
            for v in got:
                counts[v] = counts.get(v, 0) + 1
        if not counts:
            continue  # field defined but nothing filled in yet
        name = esc(spec["name"])
        mode = "all" if spec["type"] == "tags" else "any"
        ordered = sorted(counts, key=answer_order if spec["question"] else str.lower)
        if empty:
            counts[NONE] = empty
            ordered.append(NONE)
        if spec["type"] == "text" and len(counts) > SELECT_OVER:
            options = "".join(f'<option value="{esc(v)}">{esc(label(v, spec))} ({counts[v]})</option>' for v in ordered)
            anything = "Any answer" if spec["question"] else f'Any {spec["name"].lower()}'
            control = (f'<select aria-label="{name}"><option value="">{esc(anything)}'
                       f"</option>{options}</select>")
            kind = "select"
        else:
            control = '<div class="chips">' + "".join(
                f'<button type="button" class="chip" data-value="{esc(v)}" aria-pressed="false">'
                f'{esc(label(v, spec))}<span class="n">{counts[v]}</span></button>' for v in ordered) + "</div>"
            kind = "chips"
        wide = " wide" if spec["question"] else ""  # questions are long: label above the chips
        groups.setdefault(spec["group"], []).append(
            f'<div class="filter{wide}" data-field="{name}" data-mode="{mode}" data-kind="{kind}">'
            f'<span class="label">{name}</span>{control}</div>')
    if not groups:
        return ""
    names = list(groups)
    if len(names) == 1:
        body = "".join(groups[names[0]])
    else:
        body = '<div class="ftabs" role="tablist">' + "".join(
            f'<button type="button" class="ftab" role="tab" data-tab="{i}" aria-selected="{"true" if i == 0 else "false"}">'
            f'{esc(n or "More")}<span class="n"></span></button>' for i, n in enumerate(names)) + "</div>"
        body += "".join(f'<div class="fgroup" data-tab="{i}"{"" if i == 0 else " hidden"}>' + "".join(groups[n]) + "</div>"
                        for i, n in enumerate(names))
    return ('<details class="filters" open><summary>Filters <span id="active"></span></summary>'
            + body + '<button type="button" class="clear" id="clear" hidden>Clear filters</button></details>')


def list_page(query):
    params = parse_qs(query)
    try:
        db = connect()
    except sqlite3.Error as e:
        return 500, shell("Celebrity Heads", "", "<h1>Celebrity Heads</h1>",
                          f'<p class="empty">Couldn\'t open the database: {esc(str(e))}</p>')
    with db:
        cats = categories(db)
        if not cats:
            return 200, shell("Celebrity Heads", "", "<h1>Celebrity Heads</h1>",
                              '<p class="empty">No topics yet. <a href="/new">Add a topic</a></p>')
        wanted = (params.get("c") or [cats[0][1]])[0]
        chosen = find_category(cats, wanted)
        title = "<h1>Celebrity Heads</h1>" + tabs(cats, chosen and chosen[1])
        if not chosen:
            return 404, shell("Celebrity Heads", "", title, f'<p class="empty">No category called {esc(wanted)}.</p>')
        category_id, category, raw, _ = chosen
        specs = field_specs(raw)
        entries = [(name, json.loads(details)) for name, details in db.execute(
            "SELECT name, details FROM entries WHERE category_id = ? ORDER BY name", (category_id,))]
        note = category_note(db, category_id)
    db.close()

    if not entries and STATIC:
        return 200, shell("Celebrity Heads", category, title, f'<p class="empty">Nothing in {esc(category)} yet.</p>')
    if not entries:
        content = (f'<div class="empty">Nothing in {esc(category)} yet. Add the first name, then ask questions on its page.'
                   + name_form(category) + "</div>"
                   f'<details class="edit" style="margin-top:12px"><summary>Remove this topic</summary>'
                   f'<form method="post" action="/topic/remove" data-confirm="Remove the topic {esc(category)}?">'
                   f'{hidden(c=category)}<button class="btn danger">Remove {esc(category)}</button></form></details>')
        return 200, shell("Celebrity Heads", category, title, content)
    header = (title + '<input type="search" id="q" placeholder="Search" autocomplete="off">'
              + (f'<p class="note">{esc(note)}</p>' if note else "") + filters(specs, entries))
    cards = []
    pictures = [s for s in specs if s["type"] == "image"]
    picture = pictures[0] if pictures else None  # on the card
    big = pictures[-1] if pictures else None  # in the random pick popup, e.g. full art
    for name, details in entries:
        pic = values(picture, details) if picture else []
        thumb = f'<img class="thumb" src="{esc(thumb_src(pic[0]))}" alt="" loading="lazy">' if pic else ""
        art = values(big, details) if big else []
        art = f' data-art="{esc(sized_src(art[0], "trimmed"))}"' if art else ""
        tags = {s["name"]: values(s, details) or [NONE] for s in specs if s["filter"]}
        meta = " · ".join(", ".join(values(s, details)) for s in specs if s["card"] and values(s, details))
        text = " ".join([name] + [" ".join(values(s, details)) for s in specs
                                  if s["type"] != "image" and not s["question"]]).lower()  # not "yes"/"no"
        cards.append(
            f'<a class="card" href="{esc(entry_url(category, name))}" '
            f"data-f=\"{esc(json.dumps(tags, ensure_ascii=False))}\" data-s=\"{esc(text)}\"{art}>"
            f'<span class="text"><span class="name">{esc(name)}</span>' + (f'<span class="meta">{esc(meta)}</span>' if meta else "")
            + f"</span>{thumb}</a>")
    adding = "" if STATIC else (
        f'<dialog class="add" id="add" aria-label="Add a name"><h2>Add to {esc(category)}</h2>'
        + name_form(category, '<button type="button" class="btn" id="addclose">Cancel</button>') + "</dialog>")
    content = ('<div class="tools"><p class="count" id="count"></p><div class="row">'
               + ("" if STATIC else '<button type="button" class="btn" id="addbtn">Add name</button>')
               + '<button type="button" class="btn primary" id="random">Random pick</button></div></div>'
               '<div class="grid">' + "".join(cards) + "</div>" + adding +
               '<dialog class="pick" id="pick" aria-label="Random pick"><img class="pick-art" alt="" hidden>'
               '<p class="pick-name"></p>'
               '<p class="pick-meta"></p><p class="pick-left"></p><div class="pick-actions">'
               '<button type="button" class="btn primary" id="again">Pick again</button>'
               '<a class="btn" id="open" href="#">Open profile</a>'
               '<button type="button" class="btn" id="close">Close</button></div></dialog>')
    return 200, shell(f"{category} · Celebrity Heads", category, header, content, LIST_SCRIPT)


def image_src(value):
    if value.startswith(("http://", "https://")):
        return value
    if STATIC:  # the trimmed WebP stands in for a big original when there is one
        trimmed = "trimmed/" + os.path.splitext(value)[0] + ".webp"
        return static_img(trimmed if os.path.isfile(os.path.join(IMAGES, trimmed)) else value)
    return "/img/" + quote(value)


def static_img(path):
    STATIC["files"].add(path)
    return STATIC["prefix"] + "img/" + quote(path)


def sized_src(value, folder):
    """A resized copy of an image, images/<folder>/<path>.webp, if one exists; else the image itself.
    thumbs/ (160px) is used on cards and avatars, trimmed/ (1200px, cut to the figure) beside profile
    info and in the random pick popup. medium/ (720px, the whole picture) is no longer used."""
    if value.startswith(("http://", "https://")):
        return value
    copy = folder + "/" + os.path.splitext(value)[0] + ".webp"
    if not os.path.isfile(os.path.join(IMAGES, copy)):
        return image_src(value)
    return static_img(copy) if STATIC else "/img/" + quote(copy)


def thumb_src(value):
    return sized_src(value, "thumbs")


def image_file(path):
    """The file for an /img/ URL path, or None if it isn't an image inside IMAGES."""
    full = os.path.realpath(os.path.join(IMAGES, unquote(path[len("/img/"):])))
    if not full.startswith(IMAGES + os.sep) or os.path.splitext(full)[1].lower() not in IMAGE_TYPES:
        return None
    return full if os.path.isfile(full) else None


def paragraphs(text):
    return "".join(f"<p>{esc(p.strip()).replace(chr(10), '<br>')}</p>" for p in text.split("\n\n") if p.strip())


def item(text):
    label, sep, rest = text.partition(": ")
    if sep and len(label) <= 60:
        return f"<li><strong>{esc(label)}</strong>: {esc(rest)}</li>"
    return f"<li>{esc(text)}</li>"


def entry_page(query):
    params = parse_qs(query)
    wanted_cat = (params.get("c") or [""])[0]
    wanted = (params.get("n") or [""])[0]
    try:
        db = connect()
    except sqlite3.Error as e:
        return 500, shell("Celebrity Heads", "", "<h1>Celebrity Heads</h1>",
                          f'<p class="empty">Couldn\'t open the database: {esc(str(e))}</p>')
    with db:
        cats = categories(db)
        chosen = find_category(cats, wanted_cat)
        row = names = None
        if chosen:
            row = db.execute("SELECT name, details FROM entries WHERE category_id = ? AND name = ?",
                             (chosen[0], wanted)).fetchone()
            everyone = [json.loads(d) for (d,) in db.execute(
                "SELECT details FROM entries WHERE category_id = ?", (chosen[0],))]
            names = [n for (n,) in db.execute(
                "SELECT name FROM entries WHERE category_id = ? ORDER BY name", (chosen[0],))]
    db.close()
    if not row:
        what = f"There's no {esc(wanted)} in {esc(chosen[1])}." if chosen else f"No category called {esc(wanted_cat)}."
        return 404, shell("Celebrity Heads", "", "<h1>Celebrity Heads</h1>" + tabs(cats, chosen and chosen[1]),
                          f'<p class="empty">{what}</p>')

    _, category, raw, _ = chosen
    name, details = row[0], json.loads(row[1])
    specs = field_specs(raw)
    back = f'<a class="back" href="{esc(list_url(category))}">‹ {esc(category)}</a>'
    pictures = [s for s in specs if s["type"] == "image" and values(s, details)]
    avatar = pictures[0] if pictures else None
    if avatar:
        header = back + (f'<div class="who"><h1>{esc(name)}</h1><img class="avatar" '
                         f'src="{esc(thumb_src(values(avatar, details)[0]))}" alt="{esc(name)} {esc(avatar["name"].lower())}"></div>')
    else:
        header = back + f"<h1>{esc(name)}</h1>"

    missing = '<span class="missing">Not added yet</span>'
    sections = []
    facts = [s for s in specs if s["type"] == "text" and not s["section"] and not s["question"]]
    if facts:
        rows = "".join(f"<dt>{esc(s['name'])}</dt><dd>{esc(', '.join(values(s, details))) or missing}</dd>"
                       for s in facts)
        sections.append(f'<section class="details"><h2>Details</h2><dl>{rows}</dl></section>')
    sections.append(questions_section(category, name, specs, details, everyone))
    side = None  # the first non-avatar picture (e.g. full art): shown right of the info
    done = set()
    for s in specs:
        got = values(s, details)
        if s["question"]:
            continue
        if s["section"]:
            if s["section"] in done:
                continue
            done.add(s["section"])
            members = [m for m in specs if m["section"] == s["section"]]
            rows = "".join(f"<dt>{esc(m['name'])}</dt><dd>{esc(', '.join(values(m, details)))}</dd>"
                           for m in members if m["type"] in ("text", "tags") and values(m, details))
            body = f"<dl>{rows}</dl>" if rows else ""
            for m in members:
                if m["type"] == "list" and values(m, details):
                    body += '<ul class="items">' + "".join(item(v) for v in values(m, details)) + "</ul>"
                elif m["type"] == "long" and values(m, details):
                    body += paragraphs("\n\n".join(values(m, details)))
            sections.append(f"<section><h2>{esc(s['section'])}</h2>{body or missing}</section>")
            continue
        if s["type"] == "image":
            if s is avatar or not got:
                continue
            if side is None:
                side = (s, got[0])
                continue
            sections.append(f'<section class="art"><h2>{esc(s["name"])}</h2><img src="{esc(image_src(got[0]))}" '
                            f'alt="{esc(name)} {esc(s["name"].lower())}" loading="lazy"></section>')
            continue
        if s["type"] == "tags":
            body = ('<div class="chips">' + "".join(f'<span class="chip">{esc(v)}</span>' for v in got)
                    + "</div>") if got else '<span class="missing">None</span>'
        elif s["type"] == "list":
            body = '<ul class="items">' + "".join(item(v) for v in got) + "</ul>" if got else missing
        elif s["type"] == "long":
            body = paragraphs("\n\n".join(got)) if got else missing
        else:
            continue
        sections.append(f"<section><h2>{esc(s['name'])}</h2>{body}</section>")

    i = names.index(name)
    prev_link = f'<a href="{esc(entry_url(category, names[i - 1]))}">‹ {esc(names[i - 1])}</a>' if i > 0 else "<span></span>"
    next_link = f'<a href="{esc(entry_url(category, names[i + 1]))}">{esc(names[i + 1])} ›</a>' if i + 1 < len(names) else ""
    layout = "profile"
    if side:
        s, value = side
        sections.insert(1 if facts else 0,
                        f'<figure class="art-col"><a href="{esc(image_src(value))}" title="Open the full picture">'
                        f'<img src="{esc(sized_src(value, "trimmed"))}" alt="{esc(name)} {esc(s["name"].lower())}"></a></figure>')
        layout = "profile has-art"
    sections.append("" if STATIC else
        f'<details class="edit"><summary>Rename or remove {esc(name)}</summary>'
        f'<form method="post" action="/entry/rename" class="form">{hidden(c=category, n=name)}'
        f'<label>New name<input class="field" name="to" value="{esc(name)}" required maxlength="{LIMITS["name"]}" '
        f'autocomplete="off"></label><div class="row"><button class="btn primary">Rename</button></div></form>'
        f'<form method="post" action="/entry/remove" data-confirm="Remove {esc(name)} and its answers from {esc(category)}?">'
        f'{hidden(c=category, n=name)}<button class="btn danger">Remove {esc(name)}</button></form></details>')
    content = f'<div class="{layout}">' + "".join(sections) + f'<nav class="pager">{prev_link}{next_link}</nav></div>'
    return 200, shell(f"{name} · {category}", category, header, content, ENTRY_SCRIPT)


def questions_section(category, name, specs, details, everyone):
    """The profile's questions with one-tap answers, then a box to ask a new one."""
    asked = [s for s in specs if s["question"]]
    if STATIC:  # read-only copy: just the answered questions
        rows = "".join(f"<dt>{esc(s['name'])}</dt><dd>{esc(values(s, details)[0])}</dd>" for s in asked if values(s, details))
        return f'<section class="questions"><h2>Questions</h2><dl>{rows}</dl></section>' if rows else ""
    rows = []
    for i, s in enumerate(asked):
        got = values(s, details)
        current = got[0] if got else ""
        state = "" if current else '<span class="missing">Not answered</span>'
        rows.append(f'<div class="qrow" id="q{i}"><p class="qtext"><a href="{esc(question_url(category, s["name"]))}" '
                    f'title="Answer for every name">{esc(s["name"])}</a>{state}</p>'
                    + answer_controls(category, name, s, current, answer_options(s, everyone), "entry") + "</div>")
    known = "".join(f'<option value="{esc(s["name"])}">' for s in asked)
    add = (f'<div class="addq"><h3>Ask a new question</h3>'
           f'<form method="post" action="/answer" class="form">{hidden(c=category, n=name, back="entry")}'
           f'<input class="field" name="q" list="asked" required maxlength="{LIMITS["question"]}" autocomplete="off" '
           f'placeholder="Question, e.g. Can they fly?" aria-label="Question"><datalist id="asked">{known}</datalist>'
           f'<input class="field" name="a" maxlength="{LIMITS["answer"]}" autocomplete="off" '
           f'placeholder="Answer: type one, or tap Yes or No" aria-label="Answer">'
           # Save comes first so Enter in a box saves what was typed rather than pressing Yes.
           '<div class="row"><button class="btn primary">Save</button>'
           + "".join(f'<button class="chip" name="pick" value="{v}">{v}</button>' for v in YES_NO)
           + "</div></form></div>")
    body = "".join(rows) if rows else '<p class="missing">No questions yet. Ask one below; it becomes a filter.</p>'
    return f'<section class="questions" id="questions"><h2>Questions</h2>{body}{add}</section>'


def question_page(query):
    """One question with every name in the topic, to answer it down the list; rename or remove it."""
    params = parse_qs(query)
    wanted_cat = (params.get("c") or [""])[0]
    wanted = (params.get("q") or [""])[0]
    db = connect()
    with db:
        cats = categories(db)
        chosen = find_category(cats, wanted_cat)
        everyone = [(n, json.loads(d)) for n, d in db.execute(
            "SELECT name, details FROM entries WHERE category_id = ? ORDER BY name", (chosen[0],))] if chosen else []
    db.close()
    spec = next((s for s in field_specs(chosen[2]) if s["question"] and s["name"] == wanted), None) if chosen else None
    if not spec:
        what = f"There's no question {esc(wanted)} in {esc(chosen[1])}." if chosen else f"No topic called {esc(wanted_cat)}."
        return 404, shell("Celebrity Heads", "", "<h1>Celebrity Heads</h1>" + tabs(cats, chosen and chosen[1]),
                          f'<p class="empty">{what}</p>')
    category = chosen[1]
    options = answer_options(spec, [d for _, d in everyone])
    rows = []
    for j, (name, details) in enumerate(everyone):
        got = values(spec, details)
        current = got[0] if got else ""
        state = "" if current else '<span class="missing">Not answered</span>'
        rows.append(f'<div class="qrow" id="n{j}"><p class="qtext"><a href="{esc(entry_url(category, name))}">'
                    f'{esc(name)}</a>{state}</p>' + answer_controls(category, name, spec, current, options, "question") + "</div>")
    answered = sum(1 for _, d in everyone if values(spec, d))
    header = (f'<a class="back" href="{esc(list_url(category))}">‹ {esc(category)}</a>'
              f'<h1>{esc(spec["name"])}</h1><p class="note">Answered for {answered} of {len(everyone)}. '
              "Tap an answer for each name; it saves straight away.</p>")
    content = (f'<details class="edit"><summary>Rename or remove this question</summary>'
               f'<form method="post" action="/question/rename" class="form">{hidden(c=category, q=spec["name"])}'
               f'<label>Question<input class="field" name="to" value="{esc(spec["name"])}" required '
               f'maxlength="{LIMITS["question"]}" autocomplete="off"></label>'
               '<div class="row"><button class="btn primary">Rename</button></div></form>'
               f'<form method="post" action="/question/remove" data-confirm="Remove this question and its answers from every name?">'
               f'{hidden(c=category, q=spec["name"])}<button class="btn danger">Remove this question</button></form></details>'
               '<div class="profile"><section class="questions">' + ("".join(rows) or '<p class="missing">No names yet.</p>')
               + "</section></div>")
    return 200, shell(f"{spec['name']} · {category}", category, header, content, ENTRY_SCRIPT)


def new_topic_page():
    db = connect()
    with db:
        cats = categories(db)
    db.close()
    content = ('<form method="post" action="/topic" class="form">'
               f'<label>Topic<input class="field" name="name" required maxlength="{LIMITS["topic"]}" autocomplete="off" '
               'placeholder="e.g. Harry Potter characters" autofocus></label>'
               f'<label>Note (optional, shown under the search box)<input class="field" name="note" '
               f'maxlength="{LIMITS["note"]}" autocomplete="off"></label>'
               '<div class="row"><button class="btn primary">Add topic</button></div></form>'
               '<p class="note">Next, add names to it. On each name\'s page you can ask questions; every question '
               "becomes a filter of its answers.</p>")
    return 200, shell("New topic · Celebrity Heads", "", "<h1>Celebrity Heads</h1>" + tabs(cats, None) + "<h2>New topic</h2>", content)


# ---- Writes. Each takes the form's fields and returns where to go next. ----

def tidy(text, kind):
    """Form text with spaces tidied; refuses it when it's longer than LIMITS[kind]."""
    text = " ".join((text or "").split())
    if len(text) > LIMITS[kind]:
        raise Bad(f"That {kind} is too long (at most {LIMITS[kind]} characters).")
    return text


def upper_first(text):
    return text[:1].upper() + text[1:]


def question_key(text):
    return text.lower().rstrip("? ").strip()


def field_name(f):
    return f if isinstance(f, str) else str(f.get("name", ""))


def topic(db, wanted):
    row = db.execute("SELECT id, name, fields FROM categories WHERE name = ?", (wanted or "",)).fetchone()
    if not row:
        raise Bad(f"There's no topic called {wanted}.")
    return row[0], row[1], json.loads(row[2])


def entry(db, category_id, wanted):
    row = db.execute("SELECT id, name, details FROM entries WHERE category_id = ? AND name = ?",
                     (category_id, wanted or "")).fetchone()
    if not row:
        raise Bad(f"There's no {wanted} in that topic.")
    return row[0], row[1], json.loads(row[2])


def save_fields(db, category_id, fields):
    db.execute("UPDATE categories SET fields = ? WHERE id = ?", (json.dumps(fields, ensure_ascii=False), category_id))


def save_details(db, entry_id, details):
    db.execute("UPDATE entries SET details = ? WHERE id = ?", (json.dumps(details, ensure_ascii=False), entry_id))


def add_topic(form):
    name, note = tidy(form.get("name"), "topic"), tidy(form.get("note"), "note")
    if not name:
        raise Bad("The topic needs a name.")
    with writing() as db:
        row = db.execute("SELECT name FROM categories WHERE name = ?", (name,)).fetchone()
        if row:
            return "/?" + urlencode({"c": row[0]})  # already there
        position = db.execute("SELECT COALESCE(MAX(position), 0) + 1 FROM categories").fetchone()[0]
        db.execute("INSERT INTO categories (name, fields, position, note) VALUES (?, '[]', ?, ?)", (name, position, note))
    return "/?" + urlencode({"c": name})


def remove_topic(form):
    with writing() as db:
        category_id, category, _ = topic(db, form.get("c"))
        if db.execute("SELECT COUNT(*) FROM entries WHERE category_id = ?", (category_id,)).fetchone()[0]:
            raise Bad(f"{category} still has names. Only an empty topic can be removed here.")
        db.execute("DELETE FROM categories WHERE id = ?", (category_id,))
    return "/"


def add_name(form):
    name = tidy(form.get("n"), "name")
    if not name:
        raise Bad("The name can't be empty.")
    with writing() as db:
        category_id, category, _ = topic(db, form.get("c"))
        row = db.execute("SELECT name FROM entries WHERE category_id = ? AND name = ?", (category_id, name)).fetchone()
        if row:
            return entry_url(category, row[0])  # already there
        db.execute("INSERT INTO entries (category_id, name, details) VALUES (?, ?, '{}')", (category_id, name))
    return entry_url(category, name)


def rename_name(form):
    to = tidy(form.get("to"), "name")
    if not to:
        raise Bad("The name can't be empty.")
    with writing() as db:
        category_id, category, _ = topic(db, form.get("c"))
        entry_id, _, _ = entry(db, category_id, form.get("n"))
        clash = db.execute("SELECT id FROM entries WHERE category_id = ? AND name = ? AND id != ?",
                           (category_id, to, entry_id)).fetchone()
        if clash:
            raise Bad(f"{category} already has {to}.")
        db.execute("UPDATE entries SET name = ? WHERE id = ?", (to, entry_id))
    return entry_url(category, to)


def remove_name(form):
    with writing() as db:
        category_id, category, _ = topic(db, form.get("c"))
        entry_id, _, _ = entry(db, category_id, form.get("n"))
        db.execute("DELETE FROM entries WHERE id = ?", (entry_id,))
    return "/?" + urlencode({"c": category})


def answer(form):
    """Sets (or with clear=1 clears) one name's answer to a question, adding the question if it's new."""
    question = upper_first(tidy(form.get("q"), "question"))
    typed = tidy(form.get("a"), "answer")
    given = typed or tidy(form.get("pick"), "answer")  # a typed answer wins over the button Enter presses
    clearing = form.get("clear") == "1"
    if not question_key(question):
        raise Bad("The question can't be empty.")
    with writing() as db:
        category_id, category, fields = topic(db, form.get("c"))
        entry_id, name, details = entry(db, category_id, form.get("n"))
        match = next((f for f in fields if question_key(field_name(f)) == question_key(question)), None)
        if question_key(question) == "name":
            raise Bad("A question can't be called Name.")
        if match is not None and not field_specs(json.dumps([match]))[0]["question"]:
            raise Bad(f"{category} already has a field called {field_name(match)}, which isn't a question.")
        if match is None and not clearing:
            fields.append({"name": question, "type": "text", "filter": True, "card": False, "group": QUESTIONS})
            save_fields(db, category_id, fields)
        question = field_name(match) if match is not None else question
        if clearing:
            details.pop(question, None)
        elif given:
            used = {v.lower(): v for (raw,) in db.execute("SELECT details FROM entries WHERE category_id = ?", (category_id,))
                    for v in [json.loads(raw).get(question)] if isinstance(v, str)}
            used.update({v.lower(): v for v in YES_NO})
            details[question] = used.get(given.lower(), upper_first(given))
        save_details(db, entry_id, details)
        asked = [field_name(f) for f in fields if field_specs(json.dumps([f]))[0]["question"]]
        if form.get("back") == "question":
            names = [n for (n,) in db.execute("SELECT name FROM entries WHERE category_id = ? ORDER BY name", (category_id,))]
            return question_url(category, question) + f"#n{names.index(name)}"
    return entry_url(category, name) + (f"#q{asked.index(question)}" if question in asked else "#questions")


def rename_question(form):
    to = upper_first(tidy(form.get("to"), "question"))
    if not question_key(to) or question_key(to) == "name":
        raise Bad("That can't be a question's name.")
    with writing() as db:
        category_id, category, fields = topic(db, form.get("c"))
        old = form.get("q") or ""
        i = next((i for i, f in enumerate(fields) if field_name(f) == old and field_specs(json.dumps([f]))[0]["question"]), None)
        if i is None:
            raise Bad(f"There's no question {old} in {category}.")
        if any(j != i and question_key(field_name(f)) == question_key(to) for j, f in enumerate(fields)):
            raise Bad(f"{category} already has {to}.")
        fields[i] = dict(fields[i], name=to)
        save_fields(db, category_id, fields)
        for entry_id, raw in db.execute("SELECT id, details FROM entries WHERE category_id = ?", (category_id,)).fetchall():
            details = json.loads(raw)
            if old in details:
                details[to] = details.pop(old)
                save_details(db, entry_id, details)
    return question_url(category, to)


def remove_question(form):
    with writing() as db:
        category_id, category, fields = topic(db, form.get("c"))
        old = form.get("q") or ""
        kept = [f for f in fields if not (field_name(f) == old and field_specs(json.dumps([f]))[0]["question"])]
        if len(kept) == len(fields):
            raise Bad(f"There's no question {old} in {category}.")
        save_fields(db, category_id, kept)
        for entry_id, raw in db.execute("SELECT id, details FROM entries WHERE category_id = ?", (category_id,)).fetchall():
            details = json.loads(raw)
            if details.pop(old, None) is not None:
                save_details(db, entry_id, details)
    return "/?" + urlencode({"c": category})


WRITES = {"/topic": add_topic, "/topic/remove": remove_topic, "/entry/add": add_name, "/entry/rename": rename_name,
          "/entry/remove": remove_name, "/answer": answer, "/question/rename": rename_question,
          "/question/remove": remove_question}


def healthy():
    try:
        db = connect()
        with db:
            count = db.execute("SELECT COUNT(*) FROM categories").fetchone()[0]
        db.close()
    except sqlite3.Error as e:
        return 503, {"ok": False, "error": str(e)}
    if not count:
        return 503, {"ok": False, "error": "no categories"}
    return 200, {"ok": True, "categories": count}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        url = urlsplit(self.path)
        if url.path in ("/", "/entry", "/question"):
            code, text = {"/": list_page, "/entry": entry_page, "/question": question_page}[url.path](url.query)
            self.reply(code, text.encode(), "text/html; charset=utf-8")
        elif url.path == "/new":
            code, text = new_topic_page()
            self.reply(code, text.encode(), "text/html; charset=utf-8")
        elif url.path == "/health":
            code, body = healthy()
            self.reply(code, json.dumps(body).encode(), "application/json")
        elif url.path.startswith("/img/") and (path := image_file(url.path)):
            with open(path, "rb") as f:
                self.reply(200, f.read(), IMAGE_TYPES[os.path.splitext(path)[1].lower()], "public, max-age=604800")
        else:
            self.reply(404, b"Not found", "text/plain")

    def do_POST(self):
        write = WRITES.get(urlsplit(self.path).path)
        if not write:
            return self.reply(404, b"Not found", "text/plain")
        if not self.same_site():
            return self.reply(403, b"Changes are only accepted from this page.", "text/plain")
        size = int(self.headers.get("Content-Length") or 0)
        if size > 16384:
            return self.reply(413, b"Too much data.", "text/plain")
        fields = parse_qs(self.rfile.read(size).decode("utf-8", "replace"), keep_blank_values=True)
        form = {k: v[-1] for k, v in fields.items()}
        try:
            where = write(form)
        except Bad as e:
            page = shell("Couldn't save · Celebrity Heads", "", "<h1>Couldn't save that</h1>",
                         f'<p class="empty">{esc(str(e))}</p><p><a class="btn" href="javascript:history.back()">Go back</a></p>')
            return self.reply(400, page.encode(), "text/html; charset=utf-8")
        except sqlite3.Error as e:
            page = shell("Couldn't save · Celebrity Heads", "", "<h1>Couldn't save that</h1>",
                         f'<p class="empty">The database said: {esc(str(e))}</p>')
            return self.reply(500, page.encode(), "text/html; charset=utf-8")
        self.send_response(303)
        self.send_header("Location", where)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def same_site(self):
        """A browser posting from another site sends its Origin (or Sec-Fetch-Site), so those are refused."""
        origin = self.headers.get("Origin")
        if origin:
            return urlsplit(origin).netloc == self.headers.get("Host", "")
        return self.headers.get("Sec-Fetch-Site") in (None, "same-origin", "none")

    def reply(self, code, body, kind, cache="no-store"):
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(ADDRESS, Handler).serve_forever()
