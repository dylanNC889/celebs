// Celebrity Heads: runs entirely in the browser on GitHub Pages (repo dylanNC889/celebs).
//
// All data is data.json in the repo: {topics: [{name, note, fields, entries: [{name, details}]}],
// sized: {thumbs: [...], trimmed: [...]}}. A topic's fields are plain names or
// {name, type: text|tags|list|long|image, filter, card, group, section} (see README.md); entries' details
// are keyed by field name. "sized" lists the image paths (without extension) that have a small WebP copy
// in img/thumbs/ (cards, avatars) or img/trimmed/ (profile art, random pick).
//
// Nothing shows until someone logs in (the page asks first; the files themselves are still public on
// GitHub Pages). There are two ways in, and either way each change is one commit through the GitHub API:
//  - Log in (users.json): each player has a username and password and their own additions on top of the
//    shared topics: their own topics, names added to shared topics, and questions with answers. They're
//    kept in users/<name>.json on the "userdata" branch (not built by Pages), and only that player sees
//    them. The password unlocks, in this browser, a shared GitHub token stored in users.json encrypted
//    with it (PBKDF2-SHA256 + AES-GCM). This is simple, not secure: the repo is public, so anyone can
//    read users' files, and anyone who guesses a password gets the token, which can change the repo.
//  - Owner sign-in: a GitHub token typed in; changes the shared topics (data.json on main) for everyone.
// Players with "admin": true in users.json get the admin console (?admin): work on the shared topics or any
// player's additions, reset passwords, make or remove admins, add or remove players. (Every player holds the
// same token, so admin is a page-level privilege, not a security boundary.)
// Tokens stay in this browser (localStorage) until logging out. A question is a text field in the
// "Questions" group with a filter and no card, so each one becomes a filter of its answers.
//
// One page, chosen by the query string:  ?c=Topic (list)  ?c=Topic&n=Name (profile)
//   ?c=Topic&ask=Question (answer one question for every name)  ?new (add a topic)
"use strict";

const OWNER = "dylanNC889", REPO = "celebs", BRANCH = "main", FILE = "data.json";
const USERS_FILE = "users.json", USER_BRANCH = "userdata", ITERATIONS = 250000;
const userFile = name => `users/${name.toLowerCase()}.json`;
const API = "https://api.github.com";
const TYPES = ["text", "tags", "list", "long", "image"];
const SELECT_OVER = 8;      // a text filter with more values than this is a drop-down instead of chips
const NONE = "(none)";      // filter value for entries with nothing in that field
const QUESTIONS = "Questions";
const YES_NO = ["Yes", "No"];
const LIMITS = { topic: 60, note: 300, name: 80, question: 120, answer: 80, answers: 240, detail: 200, item: 600, long: 10000 };
const TYPE_LABELS = { text: "One value", tags: "Several values", list: "List", long: "Paragraphs", image: "Picture" };
const RIOT_NOTICE = "Celebrity Heads was created under Riot Games' \"Legal Jibber Jabber\" policy using assets " +
  "owned by Riot Games. Riot Games does not endorse or sponsor this project.";

let MODE = "view";  // "view" (looking only), "user" (logged in player) or "admin" (owner, GitHub token)
let USER = null;    // the logged-in player's name
let TOKEN = null;   // GitHub token: typed in by the owner, or unlocked by a player's password
let BASE = null;    // data.json: the shared topics
let SHA = null;     // its blob sha on GitHub (when read through the API), needed to save it
let OVER = null;    // the player's own additions (users/<name>.json on the userdata branch)
let OVER_SHA = null;
let DATA = null;    // what the pages show: BASE, or BASE with the player's additions merged in

const SHARED = "*shared*";  // TARGET value: an admin player working on the shared topics
let ADMIN = false;         // the logged-in player is an admin
let TARGET = null;         // admins: whose data the pages show and change (null = their own, SHARED, or a name)
const editingBase = () => MODE === "admin" || (MODE === "user" && TARGET === SHARED);
const whose = () => (TARGET && TARGET !== SHARED ? TARGET : USER);  // the player whose additions are shown
const canEdit = () => MODE !== "view";
const mine = x => editingBase() || (MODE === "user" && !!x && !!x.own);  // may rename or remove it
const ownFlag = () => (editingBase() ? {} : { own: true });

class Bad extends Error {}  // a change that can't be made; the message is shown as is

const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" }[c]));
const byLower = (a, b) => { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; };
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

function store(key, value) {  // localStorage that never throws; value undefined reads, null removes
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
  } catch (e) { return null; }
  return null;
}

// ---- Fields and values ----

function fieldSpecs(raw) {
  return raw.map(f => {
    if (typeof f === "string") f = { name: f };
    const kind = TYPES.includes(f.type || "text") ? (f.type || "text") : "text";
    const shortish = kind === "text" || kind === "tags";
    return {
      name: f.name, type: kind,
      filter: !!f.filter && shortish,
      card: ("card" in f ? !!f.card : kind === "text") && shortish,
      group: String(f.group || ""),
      section: String(f.section || ""),
      question: (kind === "text" || kind === "tags") && f.group === QUESTIONS && !f.section,
      multi: kind === "tags",  // several values (for a question: several answers)
      own: !!f.own,
    };
  });
}

function values(spec, details) {
  const raw = details[spec.name];
  const items = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  return items.map(v => String(v).trim()).filter(v => v);
}

const sortedEntries = topic => topic.entries.slice().sort((a, b) => byLower(a.name, b.name));
const findTopic = (data, wanted) => data.topics.find(t => same(t.name, wanted || ""));
const findEntry = (topic, wanted) => topic.entries.find(e => same(e.name, wanted || ""));

function label(value, spec) {
  if (value !== NONE) return value;
  return spec && spec.question ? "Not answered" : "None";
}

function answerOrder(a, b) {  // Yes, then No, then the rest A to Z
  const rank = v => (YES_NO.includes(v) ? YES_NO.indexOf(v) : YES_NO.length);
  return rank(a) - rank(b) || byLower(a, b);
}

function answerOptions(spec, allDetails) {  // Yes/No until a question has other answers, then the answers used
  const used = [...new Set(allDetails.flatMap(d => values(spec, d)))].sort(answerOrder);
  if (spec.multi) return used;  // several answers: just the ones used so far
  return used.every(v => YES_NO.includes(v)) ? YES_NO.slice() : used;
}

// ---- Links and pictures ----

const link = params => "?" + new URLSearchParams(params).toString();
const listUrl = c => link({ c });
const entryUrl = (c, n) => link({ c, n });
const questionUrl = (c, ask) => link({ c, ask });
const fieldsUrl = c => link({ c, fields: "1" });
const isUrl = v => /^https?:\/\//.test(v);
const pathUrl = p => p.split("/").map(encodeURIComponent).join("/");

function imageSrc(value) {
  return isUrl(value) ? value : "img/" + pathUrl(value);
}

function sizedSrc(value, folder) {  // the small WebP copy (thumbs/ or trimmed/) when there is one
  if (isUrl(value)) return value;
  const stem = value.replace(/\.[^./]*$/, "");
  return ((DATA.sized || {})[folder] || []).includes(stem) ? `img/${folder}/${pathUrl(stem)}.webp` : imageSrc(value);
}

// ---- Pieces of pages ----

function tabs(current) {
  const links = DATA.topics.map(t =>
    `<a href="${esc(listUrl(t.name))}"${current && t.name === current ? ' aria-current="page"' : ""}>` +
    `${esc(t.name)}<span>${t.entries.length}</span></a>`);
  if (canEdit()) links.push('<a class="add" href="?new">+ Topic</a>');
  return `<nav class="tabs">${links.join("")}</nav>`;
}

function hidden(fields) {
  return Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join("");
}

function nameForm(category, cancel = "") {
  return `<form data-op="addName" class="form">${hidden({ c: category })}` +
    '<label>Names, one per line<textarea class="field" name="n" rows="4" required autocomplete="off" ' +
    'placeholder="e.g. Harry Potter&#10;Hermione Granger"></textarea></label><div class="row">' +
    `<button class="btn primary">Add</button>${cancel}</div></form>`;
}

function answerControls(category, name, spec, got, options, back) {  // one-tap answers, Clear, Other…
  // got: the name's answers (one, or several for a several-answers question, where buttons toggle)
  const keep = hidden({ c: category, n: name, q: spec.name, back });
  const shown = options.concat(got.filter(v => !options.includes(v)));
  let chips = shown.map(o => `<button class="chip" name="pick" value="${esc(o)}" aria-pressed="${got.includes(o)}">` +
    `${esc(o)}</button>`).join("");
  if (got.length) chips += '<button class="chip clear" name="clear" value="1">Clear</button>';
  const other = spec.multi ? "Add answers…" : "Other answer…";
  return (chips ? `<form data-op="answer" class="chips">${keep}${chips}</form>` : "") +
    `<details class="other"${chips ? "" : " open"}><summary>${other}</summary><form data-op="answer">${keep}` +
    `<input class="field" name="a" maxlength="${spec.multi ? LIMITS.answers : LIMITS.answer}" required ` +
    `placeholder="${spec.multi ? "Type answers, commas between" : "Type an answer"}" aria-label="${spec.multi ? "Add answers" : "Other answer"}">` +
    '<button class="btn">Save</button></form></details>';
}

function filters(specs, entries) {
  const groups = new Map();  // tab name -> filter rows, in field order
  for (const spec of specs) {
    if (!spec.filter) continue;
    const counts = new Map();
    let empty = 0;
    for (const e of entries) {
      const got = values(spec, e.details);
      if (!got.length) empty++;
      for (const v of got) counts.set(v, (counts.get(v) || 0) + 1);
    }
    if (!counts.size) continue;  // nothing filled in yet
    const name = esc(spec.name);
    const mode = spec.type === "tags" ? "all" : "any";
    const ordered = [...counts.keys()].sort(spec.question ? answerOrder : byLower);
    if (empty) { counts.set(NONE, empty); ordered.push(NONE); }
    let control, kind;
    if (spec.type === "text" && counts.size > SELECT_OVER) {
      const options = ordered.map(v => `<option value="${esc(v)}">${esc(label(v, spec))} (${counts.get(v)})</option>`).join("");
      const anything = spec.question ? "Any answer" : `Any ${spec.name.toLowerCase()}`;
      control = `<select aria-label="${name}"><option value="">${esc(anything)}</option>${options}</select>`;
      kind = "select";
    } else {
      control = '<div class="chips">' + ordered.map(v =>
        `<button type="button" class="chip" data-value="${esc(v)}" aria-pressed="false">` +
        `${esc(label(v, spec))}<span class="n">${counts.get(v)}</span></button>`).join("") + "</div>";
      kind = "chips";
    }
    const wide = spec.question ? " wide" : "";  // questions are long: label above the chips
    if (!groups.has(spec.group)) groups.set(spec.group, []);
    groups.get(spec.group).push(`<div class="filter${wide}" data-field="${name}" data-mode="${mode}" data-kind="${kind}">` +
      `<span class="label">${name}</span>${control}</div>`);
  }
  if (!groups.size) return "";
  const names = [...groups.keys()];
  let body;
  if (names.length === 1) {
    body = groups.get(names[0]).join("");
  } else {
    body = '<div class="ftabs" role="tablist">' + names.map((n, i) =>
      `<button type="button" class="ftab" role="tab" data-tab="${i}" aria-selected="${i === 0}">` +
      `${esc(n || "More")}<span class="n"></span></button>`).join("") + "</div>";
    body += names.map((n, i) => `<div class="fgroup" data-tab="${i}"${i === 0 ? "" : " hidden"}>` +
      groups.get(n).join("") + "</div>").join("");
  }
  return '<details class="filters" open><summary>Filters <span id="active"></span></summary>' + body +
    '<button type="button" class="clear" id="clear" hidden>Clear filters</button></details>';
}

const paragraphs = text => text.split("\n\n").filter(p => p.trim())
  .map(p => `<p>${esc(p.trim()).replace(/\n/g, "<br>")}</p>`).join("");

function item(text) {
  const at = text.indexOf(": ");
  if (at >= 0 && at <= 60) return `<li><strong>${esc(text.slice(0, at))}</strong>: ${esc(text.slice(at + 2))}</li>`;
  return `<li>${esc(text)}</li>`;
}

const notFound = (title, message) => ({
  title: "Celebrity Heads", category: "", header: "<h1>Celebrity Heads</h1>" + tabs(title),
  content: `<p class="empty">${message}</p>` });

// ---- Pages: each returns {title, category, header, content, init} ----

function listPage(params) {
  if (!DATA.topics.length) {
    return { title: "Celebrity Heads", category: "", header: "<h1>Celebrity Heads</h1>" + tabs(null),
      content: `<p class="empty">No topics yet.${canEdit() ? ' <a href="?new">Add a topic</a>' : ""}</p>` };
  }
  const wanted = params.get("c") || DATA.topics[0].name;
  const topic = findTopic(DATA, wanted);
  const title = "<h1>Celebrity Heads</h1>" + tabs(topic && topic.name);
  if (!topic) return notFound(null, `No topic called ${esc(wanted)}.`);
  const category = topic.name;
  const specs = fieldSpecs(topic.fields);
  const entries = sortedEntries(topic);
  if (!entries.length) {
    if (!canEdit()) return { title: "Celebrity Heads", category, header: title, content: `<p class="empty">Nothing in ${esc(category)} yet.</p>` };
    return { title: "Celebrity Heads", category, header: title,
      content: `<div class="empty">Nothing in ${esc(category)} yet. Add names, then ask questions on their pages ` +
        `or set up the topic's <a href="${esc(fieldsUrl(category))}">fields &amp; filters</a>.` +
        nameForm(category) + "</div>" + (mine(topic) ?
        '<details class="edit" style="margin-top:12px"><summary>Remove this topic</summary>' +
        `<form data-op="removeTopic" data-confirm="Remove the topic ${esc(category)}?">${hidden({ c: category })}` +
        `<button class="btn danger">Remove ${esc(category)}</button></form></details>` : "") };
  }
  const header = title + '<input type="search" id="q" placeholder="Search" autocomplete="off">' +
    (topic.note ? `<p class="note">${esc(topic.note)}</p>` : "") + filters(specs, entries);
  const pictures = specs.filter(s => s.type === "image");
  const picture = pictures[0], big = pictures[pictures.length - 1];  // on the card; in the random pick popup
  const cards = entries.map(({ name, details }) => {
    const pic = picture ? values(picture, details) : [];
    const thumb = pic.length ? `<img class="thumb" src="${esc(sizedSrc(pic[0], "thumbs"))}" alt="" loading="lazy">` : "";
    const art = big ? values(big, details) : [];
    const artAttr = art.length ? ` data-art="${esc(sizedSrc(art[0], "trimmed"))}"` : "";
    const tags = {};
    for (const s of specs) if (s.filter) tags[s.name] = values(s, details).length ? values(s, details) : [NONE];
    const meta = specs.filter(s => s.card && values(s, details).length).map(s => values(s, details).join(", ")).join(" · ");
    const text = [name].concat(specs.filter(s => s.type !== "image" && !s.question)  // not "yes"/"no"
      .map(s => values(s, details).join(" "))).join(" ").toLowerCase();
    return `<a class="card" href="${esc(entryUrl(category, name))}" data-f="${esc(JSON.stringify(tags))}" ` +
      `data-s="${esc(text)}"${artAttr}><span class="text"><span class="name">${esc(name)}</span>` +
      (meta ? `<span class="meta">${esc(meta)}</span>` : "") + `</span>${thumb}</a>`;
  });
  const adding = canEdit() ? `<dialog class="add" id="add" aria-label="Add names"><h2>Add to ${esc(category)}</h2>` +
    nameForm(category, '<button type="button" class="btn" id="addclose">Cancel</button>') + "</dialog>" : "";
  const content = '<div class="tools"><p class="count" id="count"></p><div class="row">' +
    (canEdit() ? '<button type="button" class="btn" id="addbtn">Add names</button>' +
      `<a class="btn" href="${esc(fieldsUrl(category))}">Fields &amp; filters</a>` : "") +
    '<button type="button" class="btn primary" id="random">Random pick</button></div></div>' +
    '<div class="grid">' + cards.join("") + "</div>" + adding +
    '<dialog class="pick" id="pick" aria-label="Random pick"><img class="pick-art" alt="" hidden>' +
    '<p class="pick-name"></p><p class="pick-meta"></p><p class="pick-left"></p><div class="pick-actions">' +
    '<button type="button" class="btn primary" id="again">Pick again</button>' +
    '<a class="btn" id="open" href="#">Open profile</a>' +
    '<button type="button" class="btn" id="close">Close</button></div></dialog>';
  return { title: `${category} · Celebrity Heads`, category, header, content, init: initList };
}

function entryPage(params) {
  const topic = findTopic(DATA, params.get("c"));
  const entry = topic && findEntry(topic, params.get("n"));
  if (!entry) {
    return notFound(topic && topic.name, topic ? `There's no ${esc(params.get("n"))} in ${esc(topic.name)}.`
      : `No topic called ${esc(params.get("c") || "")}.`);
  }
  const category = topic.name, name = entry.name, details = entry.details;
  const specs = fieldSpecs(topic.fields);
  const back = `<a class="back" href="${esc(listUrl(category))}">‹ ${esc(category)}</a>`;
  const pictures = specs.filter(s => s.type === "image" && values(s, details).length);
  const avatar = pictures[0];
  const header = back + (avatar
    ? `<div class="who"><h1>${esc(name)}</h1><img class="avatar" src="${esc(sizedSrc(values(avatar, details)[0], "thumbs"))}" ` +
      `alt="${esc(name)} ${esc(avatar.name.toLowerCase())}"></div>`
    : `<h1>${esc(name)}</h1>`);

  const missing = '<span class="missing">Not added yet</span>';
  const sections = [];
  const facts = specs.filter(s => s.type === "text" && !s.section && !s.question);
  if (facts.length) {
    const rows = facts.map(s => `<dt>${esc(s.name)}</dt><dd>${esc(values(s, details).join(", ")) || missing}</dd>`).join("");
    sections.push(`<section class="details"><h2>Details</h2><dl>${rows}</dl></section>`);
  }
  if (canEdit()) sections.push(detailsEditor(topic, entry, specs));
  sections.push(questionsSection(category, name, specs, details, topic.entries.map(e => e.details)));
  let side = null;  // the first non-avatar picture (e.g. full art): shown right of the info
  const done = new Set();
  for (const s of specs) {
    const got = values(s, details);
    if (s.question) continue;
    if (s.section) {
      if (done.has(s.section)) continue;
      done.add(s.section);
      const members = specs.filter(m => m.section === s.section);
      const rows = members.filter(m => (m.type === "text" || m.type === "tags") && values(m, details).length)
        .map(m => `<dt>${esc(m.name)}</dt><dd>${esc(values(m, details).join(", "))}</dd>`).join("");
      let body = rows ? `<dl>${rows}</dl>` : "";
      for (const m of members) {
        if (m.type === "list" && values(m, details).length) body += '<ul class="items">' + values(m, details).map(item).join("") + "</ul>";
        else if (m.type === "long" && values(m, details).length) body += paragraphs(values(m, details).join("\n\n"));
      }
      sections.push(`<section><h2>${esc(s.section)}</h2>${body || missing}</section>`);
      continue;
    }
    if (s.type === "image") {
      if (s === avatar || !got.length) continue;
      if (!side) { side = [s, got[0]]; continue; }
      sections.push(`<section class="art"><h2>${esc(s.name)}</h2><img src="${esc(imageSrc(got[0]))}" ` +
        `alt="${esc(name)} ${esc(s.name.toLowerCase())}" loading="lazy"></section>`);
      continue;
    }
    let body;
    if (s.type === "tags") {
      body = got.length ? '<div class="chips">' + got.map(v => `<span class="chip">${esc(v)}</span>`).join("") + "</div>"
        : '<span class="missing">None</span>';
    } else if (s.type === "list") {
      body = got.length ? '<ul class="items">' + got.map(item).join("") + "</ul>" : missing;
    } else if (s.type === "long") {
      body = got.length ? paragraphs(got.join("\n\n")) : missing;
    } else continue;
    sections.push(`<section><h2>${esc(s.name)}</h2>${body}</section>`);
  }

  const names = sortedEntries(topic).map(e => e.name);
  const i = names.indexOf(name);
  const prev = i > 0 ? `<a href="${esc(entryUrl(category, names[i - 1]))}">‹ ${esc(names[i - 1])}</a>` : "<span></span>";
  const next = i + 1 < names.length ? `<a href="${esc(entryUrl(category, names[i + 1]))}">${esc(names[i + 1])} ›</a>` : "";
  let layout = "profile";
  if (side) {
    const [s, value] = side;
    sections.splice(facts.length ? 1 : 0, 0,
      `<figure class="art-col"><a href="${esc(imageSrc(value))}" title="Open the full picture">` +
      `<img src="${esc(sizedSrc(value, "trimmed"))}" alt="${esc(name)} ${esc(s.name.toLowerCase())}"></a></figure>`);
    layout = "profile has-art";
  }
  if (mine(entry)) {
    sections.push(`<details class="edit"><summary>Rename or remove ${esc(name)}</summary>` +
      `<form data-op="renameName" class="form">${hidden({ c: category, n: name })}` +
      `<label>New name<input class="field" name="to" value="${esc(name)}" required maxlength="${LIMITS.name}" ` +
      `autocomplete="off"></label><div class="row"><button class="btn primary">Rename</button></div></form>` +
      `<form data-op="removeName" data-confirm="Remove ${esc(name)} and its answers from ${esc(category)}?">` +
      `${hidden({ c: category, n: name })}<button class="btn danger">Remove ${esc(name)}</button></form></details>`);
  }
  const content = `<div class="${layout}">` + sections.join("") + `<nav class="pager">${prev}${next}</nav></div>`;
  return { title: `${name} · ${category}`, category, header, content, init: initEntry };
}

function detailsEditor(topic, entry, specs) {  // the "Edit details" form: every field this login may change
  const category = topic.name;
  const link = `<a href="${esc(fieldsUrl(category))}">Fields &amp; filters</a>`;
  const fields = specs.filter(s => s.type !== "image" && !s.question);
  const editable = fields.filter(s => editingBase() || entry.own || s.own);
  if (!editable.length) {
    return '<details class="edit" id="edit-details"><summary>Edit details</summary><p class="note">' +
      (fields.length ? "These details are shared, so only an admin working on the shared topics can change them. " : "") +
      `Add your own fields on the topic's ${link} page.</p></details>`;
  }
  const everyone = topic.entries.map(e => e.details);
  const inputs = editable.map((s, i) => {
    const got = values(s, entry.details), key = esc("f:" + s.name);
    if (s.type === "list") {
      return `<label>${esc(s.name)} <span class="missing">one per line</span>` +
        `<textarea class="field" name="${key}" rows="4">${esc(got.join("\n"))}</textarea></label>`;
    }
    if (s.type === "long") return `<label>${esc(s.name)}<textarea class="field" name="${key}" rows="6">${esc(got.join("\n\n"))}</textarea></label>`;
    const known = [...new Set(everyone.flatMap(d => values(s, d)))].sort(byLower).slice(0, 200);
    return `<label>${esc(s.name)}${s.multi ? ' <span class="missing">commas between</span>' : ""}` +
      `<input class="field" name="${key}" value="${esc(got.join(", "))}" autocomplete="off"` +
      (known.length ? ` list="dl${i}"` : "") + `></label>` +
      (known.length ? `<datalist id="dl${i}">${known.map(v => `<option value="${esc(v)}">`).join("")}</datalist>` : "");
  }).join("");
  const shared = fields.length > editable.length ? '<p class="note">Shared details can only be changed by an admin working on the shared topics.</p>' : "";
  return '<details class="edit" id="edit-details"><summary>Edit details</summary>' +
    `<form data-op="editDetails" class="form">${hidden({ c: category, n: entry.name })}${inputs}${shared}` +
    `<div class="row"><button class="btn primary">Save</button></div></form>` +
    `<p class="note">Add or change fields on the ${link} page.</p></details>`;
}

function fieldsPage(params) {  // a topic's fields: add, rename, type, filter, card, filter tab, order, remove
  const topic = findTopic(DATA, params.get("c"));
  if (!topic) return notFound(null, `No topic called ${esc(params.get("c") || "")}.`);
  const category = topic.name;
  const specs = fieldSpecs(topic.fields);
  const header = `<a class="back" href="${esc(listUrl(category))}">‹ ${esc(category)}</a><h1>Fields &amp; filters</h1>` +
    '<p class="note">Fields are the details each name can have. Ones with <b>Filter</b> on appear in the filter panel, ' +
    'under their filter tab. A field in the <b>Questions</b> tab gets one-tap answer buttons on each name\'s page.</p>';
  if (!canEdit()) return { title: `Fields · ${category}`, category, header, content: '<p class="empty">Log in to change fields.</p>' };
  const groups = [...new Set(specs.map(s => s.group).filter(Boolean).concat([QUESTIONS]))];
  const rows = specs.map((s, i) => {
    const flags = [TYPE_LABELS[s.type], s.filter ? "filter" : "", s.card ? "on cards" : "",
      s.group ? `tab: ${s.group}` : "", s.section ? `section: ${s.section}` : ""].filter(Boolean).join(" · ");
    if (!mine(topic.fields[i])) {
      return `<div class="frow" id="f${i}"><p class="qtext">${esc(s.name)}<br><span class="missing">${esc(flags)} · shared</span></p></div>`;
    }
    const keep = hidden({ c: category, field: s.name });
    const short = s.type === "text" || s.type === "tags";
    const type = short
      ? '<select name="type" class="field">' + ["text", "tags"].map(t =>
        `<option value="${t}"${t === s.type ? " selected" : ""}>${TYPE_LABELS[t]}</option>`).join("") + "</select>"
      : `<input type="hidden" name="type" value="${esc(s.type)}"> <span class="missing">${TYPE_LABELS[s.type]}</span>`;
    return `<div class="frow" id="f${i}"><form data-op="updateField" class="form">${keep}` +
      `<label>Name<input class="field" name="to" value="${esc(s.name)}" required maxlength="${LIMITS.question}" autocomplete="off"></label>` +
      `<label>Type${type}</label>` +
      (short ? `<label class="check"><input type="checkbox" name="filter" value="1"${s.filter ? " checked" : ""}> Filter</label>` +
        `<label class="check"><input type="checkbox" name="card" value="1"${s.card ? " checked" : ""}> Show on cards</label>` +
        `<label>Filter tab<input class="field" name="group" value="${esc(s.group)}" list="groups" maxlength="${LIMITS.topic}" ` +
        'autocomplete="off" placeholder="(none)"></label>' : `<input type="hidden" name="group" value="${esc(s.group)}">`) +
      '<div class="row"><button class="btn primary">Save</button></div></form><div class="row">' +
      `<form data-op="moveField">${keep}${hidden({ dir: "up" })}<button class="btn" aria-label="Move ${esc(s.name)} up">↑</button></form>` +
      `<form data-op="moveField">${keep}${hidden({ dir: "down" })}<button class="btn" aria-label="Move ${esc(s.name)} down">↓</button></form>` +
      (s.question ? `<a class="btn" href="${esc(questionUrl(category, s.name))}">Answer for every name</a>` : "") +
      `<form data-op="removeField" data-confirm="Remove ${esc(s.name)} and its values from every name?">${keep}` +
      '<button class="btn danger">Remove</button></form></div></div>';
  }).join("");
  const add = `<section class="adminsec"><h3>Add a field</h3><form data-op="addField" class="form">${hidden({ c: category })}` +
    `<label>Name<input class="field" name="name" required maxlength="${LIMITS.question}" autocomplete="off" placeholder="e.g. House, Powers, Can they fly?"></label>` +
    '<label>Type<select name="type" class="field">' + ["text", "tags", "list", "long"].map(t => `<option value="${t}">${TYPE_LABELS[t]}</option>`).join("") + "</select></label>" +
    '<label class="check"><input type="checkbox" name="filter" value="1" checked> Filter (for one value or several values)</label>' +
    '<label class="check"><input type="checkbox" name="card" value="1"> Show on cards</label>' +
    `<label>Filter tab<input class="field" name="group" list="groups" maxlength="${LIMITS.topic}" autocomplete="off" placeholder="e.g. Questions"></label>` +
    '<div class="row"><button class="btn primary">Add field</button></div></form></section>';
  const content = `<section class="adminsec"><h3>Fields of ${esc(category)}</h3>${rows || '<p class="missing">No fields yet.</p>'}</section>` +
    add + `<datalist id="groups">${groups.map(g => `<option value="${esc(g)}">`).join("")}</datalist>`;
  return { title: `Fields · ${category}`, category, header, content, init: initEntry };
}

function questionsSection(category, name, specs, details, everyone) {
  const asked = specs.filter(s => s.question);
  if (!canEdit()) {  // looking only: the answered questions
    const rows = asked.filter(s => values(s, details).length)
      .map(s => `<dt>${esc(s.name)}</dt><dd>${esc(values(s, details).join(", "))}</dd>`).join("");
    return rows ? `<section class="questions" id="questions"><h2>Questions</h2><dl>${rows}</dl></section>` : "";
  }
  const rows = asked.map((s, i) => {
    const got = values(s, details);
    const state = got.length ? "" : '<span class="missing">Not answered</span>';
    return `<div class="qrow" id="q${i}"><p class="qtext"><a href="${esc(questionUrl(category, s.name))}" ` +
      `title="Answer for every name">${esc(s.name)}</a>${state}</p>` +
      answerControls(category, name, s, got, answerOptions(s, everyone), "entry") + "</div>";
  });
  const known = asked.map(s => `<option value="${esc(s.name)}">`).join("");
  const add = '<div class="addq"><h3>Ask a new question</h3>' +
    `<form data-op="answer" class="form">${hidden({ c: category, n: name, back: "entry" })}` +
    `<input class="field" name="q" list="asked" required maxlength="${LIMITS.question}" autocomplete="off" ` +
    `placeholder="Question, e.g. Can they fly?" aria-label="Question"><datalist id="asked">${known}</datalist>` +
    `<input class="field" name="a" maxlength="${LIMITS.answers}" autocomplete="off" ` +
    'placeholder="Answer: type one, or tap Yes or No" aria-label="Answer">' +
    '<label class="check"><input type="checkbox" name="multi" value="1"> Several answers (e.g. powers): type them with commas between</label>' +
    // Save comes first so Enter in a box saves what was typed rather than pressing Yes.
    '<div class="row"><button class="btn primary">Save</button>' +
    YES_NO.map(v => `<button class="chip" name="pick" value="${v}">${v}</button>`).join("") + "</div></form></div>";
  const body = rows.length ? rows.join("") : '<p class="missing">No questions yet. Ask one below; it becomes a filter.</p>';
  return `<section class="questions" id="questions"><h2>Questions</h2>${body}${add}</section>`;
}

function questionPage(params) {
  const topic = findTopic(DATA, params.get("c"));
  const spec = topic && fieldSpecs(topic.fields).find(s => s.question && s.name === params.get("ask"));
  if (!spec) {
    return notFound(topic && topic.name, topic ? `There's no question ${esc(params.get("ask"))} in ${esc(topic.name)}.`
      : `No topic called ${esc(params.get("c") || "")}.`);
  }
  const category = topic.name;
  const everyone = sortedEntries(topic);
  const options = answerOptions(spec, everyone.map(e => e.details));
  const answered = everyone.filter(e => values(spec, e.details).length).length;
  const rows = everyone.map(({ name, details }, j) => {
    const got = values(spec, details);
    const state = got.length ? "" : '<span class="missing">Not answered</span>';
    return `<div class="qrow" id="n${j}"><p class="qtext"><a href="${esc(entryUrl(category, name))}">${esc(name)}</a>${state}</p>` +
      (canEdit() ? answerControls(category, name, spec, got, options, "question") : `<p>${esc(got.join(", "))}</p>`) + "</div>";
  });
  const header = `<a class="back" href="${esc(listUrl(category))}">‹ ${esc(category)}</a><h1>${esc(spec.name)}</h1>` +
    `<p class="note">Answered for ${answered} of ${everyone.length}.` +
    (canEdit() ? " Tap an answer for each name; it saves straight away." : "") + "</p>";
  const edit = mine(spec) ? '<details class="edit"><summary>Rename or remove this question</summary>' +
    `<form data-op="renameQuestion" class="form">${hidden({ c: category, q: spec.name })}` +
    `<label>Question<input class="field" name="to" value="${esc(spec.name)}" required maxlength="${LIMITS.question}" ` +
    'autocomplete="off"></label><div class="row"><button class="btn primary">Rename</button></div></form>' +
    '<form data-op="removeQuestion" data-confirm="Remove this question and its answers from every name?">' +
    `${hidden({ c: category, q: spec.name })}<button class="btn danger">Remove this question</button></form></details>` : "";
  const content = edit + '<div class="profile"><section class="questions">' +
    (rows.join("") || '<p class="missing">No names yet.</p>') + "</section></div>";
  return { title: `${spec.name} · ${category}`, category, header, content, init: initEntry };
}

function newTopicPage() {
  const header = "<h1>Celebrity Heads</h1>" + tabs(null) + "<h2>New topic</h2>";
  if (!canEdit()) return { title: "New topic · Celebrity Heads", category: "", header, content: '<p class="empty">Log in (at the bottom of the page) to add a topic.</p>' };
  const content = '<form data-op="addTopic" class="form">' +
    `<label>Topic<input class="field" name="name" required maxlength="${LIMITS.topic}" autocomplete="off" ` +
    'placeholder="e.g. Harry Potter characters"></label>' +
    `<label>Note (optional, shown under the search box)<input class="field" name="note" maxlength="${LIMITS.note}" ` +
    'autocomplete="off"></label><div class="row"><button class="btn primary">Add topic</button></div></form>' +
    "<p class=\"note\">Next, add names to it. On each name's page you can ask questions; every question becomes a filter of its answers.</p>";
  return { title: "New topic · Celebrity Heads", category: "", header, content };
}

// ---- Changes: each takes a copy of the data and the form, changes the copy, and returns where to go ----

function tidy(text, kind) {
  text = String(text || "").split(/\s+/).filter(Boolean).join(" ");
  if (text.length > LIMITS[kind]) throw new Bad(`That ${kind} is too long (at most ${LIMITS[kind]} characters).`);
  return text;
}
const upperFirst = t => t.slice(0, 1).toUpperCase() + t.slice(1);
const questionKey = t => t.toLowerCase().replace(/[?\s]+$/, "").trim();
const fieldName = f => (typeof f === "string" ? f : String(f.name || ""));
const isQuestion = f => fieldSpecs([f])[0].question;

function topicOf(data, wanted) {
  const t = findTopic(data, wanted);
  if (!t) throw new Bad(`There's no topic called ${wanted}.`);
  return t;
}
function entryOf(topic, wanted) {
  const e = findEntry(topic, wanted);
  if (!e) throw new Bad(`There's no ${wanted} in ${topic.name}.`);
  return e;
}
const sortEntries = topic => topic.entries.sort((a, b) => byLower(a.name, b.name));
function fieldNameOk(topic, name, except) {  // a new or changed field name must be usable and different
  if (!questionKey(name) || questionKey(name) === "name") throw new Bad("That can't be a field's name.");
  if (topic.fields.some((x, j) => j !== except && questionKey(fieldName(x)) === questionKey(name))) throw new Bad(`${topic.name} already has ${name}.`);
}
function mustOwn(thing, what) {
  if (!editingBase() && !thing.own) throw new Bad(`${what} is shared with everyone, so it can't be changed here. You can add your own names, topics and questions.`);
}

const OPS = {
  addTopic(d, f) {
    const name = tidy(f.name, "topic"), note = tidy(f.note, "note");
    if (!name) throw new Bad("The topic needs a name.");
    const there = findTopic(d, name);
    if (there) return { url: listUrl(there.name) };
    d.topics.push(Object.assign({ name, note, fields: [], entries: [] }, ownFlag()));
    return { url: listUrl(name), message: `Add topic ${name}` };
  },
  removeTopic(d, f) {
    const t = topicOf(d, f.c);
    mustOwn(t, t.name);
    if (t.entries.length) throw new Bad(`${t.name} still has names. Remove them first.`);
    d.topics.splice(d.topics.indexOf(t), 1);
    return { url: "?", message: `Remove topic ${t.name}` };
  },
  addName(d, f) {  // one name per line; ones already there are skipped
    const t = topicOf(d, f.c);
    const names = String(f.n || "").split(/\r?\n/).map(line => tidy(line, "name")).filter(Boolean);
    if (!names.length) throw new Bad("Type at least one name.");
    if (names.length > 300) throw new Bad("That's more than 300 names. Add them in smaller batches.");
    const added = [], there = [];
    for (const name of names) {
      const old = findEntry(t, name);
      if (old) { if (!there.includes(old.name)) there.push(old.name); continue; }
      t.entries.push(Object.assign({ name, details: {} }, ownFlag()));
      added.push(name);
    }
    sortEntries(t);
    if (names.length === 1) {
      const e = findEntry(t, names[0]);
      return { url: entryUrl(t.name, e.name), message: `Add ${e.name} to ${t.name}` };
    }
    const note = `Added ${added.length} name${added.length === 1 ? "" : "s"}` + (there.length ? ` (${there.length} already there)` : "");
    return { url: listUrl(t.name), message: `Add ${added.length} names to ${t.name}`, note };
  },
  renameName(d, f) {
    const to = tidy(f.to, "name");
    if (!to) throw new Bad("The name can't be empty.");
    const t = topicOf(d, f.c), e = entryOf(t, f.n);
    mustOwn(e, e.name);
    if (t.entries.some(x => x !== e && same(x.name, to))) throw new Bad(`${t.name} already has ${to}.`);
    const old = e.name;
    e.name = to;
    sortEntries(t);
    return { url: entryUrl(t.name, to), message: `Rename ${old} to ${to} in ${t.name}` };
  },
  removeName(d, f) {
    const t = topicOf(d, f.c), e = entryOf(t, f.n);
    mustOwn(e, e.name);
    t.entries.splice(t.entries.indexOf(e), 1);
    return { url: listUrl(t.name), message: `Remove ${e.name} from ${t.name}` };
  },
  answer(d, f) {  // sets (or with clear=1 clears) one name's answer, adding the question if it's new
    let question = upperFirst(tidy(f.q, "question"));
    const typed = tidy(f.a, "answers");
    const picked = tidy(f.pick, "answer");
    const given = typed || picked;  // a typed answer wins over the button Enter presses
    const clearing = f.clear === "1";
    if (!questionKey(question)) throw new Bad("The question can't be empty.");
    const t = topicOf(d, f.c), e = entryOf(t, f.n);
    if (questionKey(question) === "name") throw new Bad("A question can't be called Name.");
    let match = t.fields.find(x => questionKey(fieldName(x)) === questionKey(question));
    if (match && !isQuestion(match)) throw new Bad(`${t.name} already has a field called ${fieldName(match)}, which isn't a question.`);
    if (!match && !clearing) {
      match = Object.assign({ name: question, type: f.multi === "1" ? "tags" : "text", filter: true, card: false, group: QUESTIONS }, ownFlag());
      t.fields.push(match);
    }
    if (match) question = fieldName(match);
    let message;
    if (clearing) {
      delete e.details[question];
      message = `Clear "${question}" for ${e.name}`;
    } else if (given) {
      const used = new Map();  // answers already given, so "yes" becomes "Yes"
      for (const x of t.entries) for (const v of [].concat(x.details[question] || [])) if (typeof v === "string") used.set(v.toLowerCase(), v);
      for (const v of YES_NO) used.set(v.toLowerCase(), v);
      const spell = v => {
        if (v.length > LIMITS.answer) throw new Bad(`That answer is too long (at most ${LIMITS.answer} characters).`);
        return used.get(v.toLowerCase()) || upperFirst(v);
      };
      if (fieldSpecs([match])[0].multi) {  // several answers: typed ones are added, a button toggles its answer
        let list = values({ name: question }, e.details);
        if (typed) {
          for (const v of typed.split(",").map(x => x.trim()).filter(Boolean)) { const a = spell(v); if (!list.some(x => same(x, a))) list.push(a); }
        } else {
          const a = spell(picked);
          list = list.includes(a) ? list.filter(x => x !== a) : list.concat(a);
        }
        if (list.length) e.details[question] = list; else delete e.details[question];
        message = `Answer "${question}" for ${e.name}: ${list.join(", ") || "none"}`;
      } else {
        e.details[question] = spell(given);
        message = `Answer "${question}" for ${e.name}: ${e.details[question]}`;
      }
    } else {
      message = `Ask "${question}" in ${t.name}`;
    }
    if (f.back === "question") {
      const names = sortedEntries(t).map(x => x.name);
      return { url: questionUrl(t.name, question) + `#n${names.indexOf(e.name)}`, message };
    }
    const asked = t.fields.filter(isQuestion).map(fieldName);
    return { url: entryUrl(t.name, e.name) + (asked.includes(question) ? `#q${asked.indexOf(question)}` : "#questions"), message };
  },
  editDetails(d, f) {  // the "Edit details" form: f["f:<field>"] for each field it showed
    const t = topicOf(d, f.c), e = entryOf(t, f.n);
    const specs = fieldSpecs(t.fields);
    let changed = 0;
    for (const s of specs) {
      const key = "f:" + s.name;
      if (!(key in f) || s.type === "image" || s.question) continue;
      if (!(editingBase() || e.own || s.own)) continue;  // shared details stay as they are
      const text = String(f[key]).replace(/\r/g, "");
      const long = (v, max) => { if (v.length > max) throw new Bad(`${s.name} is too long (at most ${max} characters).`); return v; };
      let value;
      if (s.type === "tags") value = [...new Set(text.split(",").map(v => long(v.split(/\s+/).filter(Boolean).join(" "), LIMITS.detail)).filter(Boolean))];
      else if (s.type === "list") value = text.split("\n").map(v => long(v.trim(), LIMITS.item)).filter(Boolean);
      else if (s.type === "long") value = long(text.trim(), LIMITS.long);
      else value = long(text.split(/\s+/).filter(Boolean).join(" "), LIMITS.detail);
      const before = JSON.stringify(e.details[s.name]);
      if (Array.isArray(value) ? !value.length : !value) delete e.details[s.name]; else e.details[s.name] = value;
      if (JSON.stringify(e.details[s.name]) !== before) changed++;
    }
    return { url: entryUrl(t.name, e.name), message: `Edit ${e.name}'s details in ${t.name}`, note: changed ? "Saved" : "Nothing changed" };
  },
  addField(d, f) {
    const t = topicOf(d, f.c);
    const name = upperFirst(tidy(f.name, "question"));
    fieldNameOk(t, name, -1);
    const type = ["text", "tags", "list", "long"].includes(f.type) ? f.type : "text";
    const short = type === "text" || type === "tags";
    const group = tidy(f.group, "topic");
    const field = Object.assign({ name, type, filter: short && f.filter === "1", card: short && f.card === "1" },
      short && group ? { group } : {}, ownFlag());
    t.fields.push(field);
    return { url: fieldsUrl(t.name) + `#f${t.fields.length - 1}`, message: `Add field "${name}" to ${t.name}` };
  },
  updateField(d, f) {
    const t = topicOf(d, f.c);
    const i = t.fields.findIndex(x => fieldName(x) === f.field);
    if (i < 0) throw new Bad(`There's no field ${f.field} in ${t.name}.`);
    mustOwn(typeof t.fields[i] === "string" ? {} : t.fields[i], f.field);
    const old = typeof t.fields[i] === "string" ? { name: t.fields[i] } : Object.assign({}, t.fields[i]);
    const was = fieldSpecs([old])[0];
    const to = upperFirst(tidy(f.to, "question"));
    fieldNameOk(t, to, i);
    const short = was.type === "text" || was.type === "tags";
    const type = short && ["text", "tags"].includes(f.type) ? f.type : was.type;
    const group = tidy(f.group, "topic");
    const next = Object.assign(old, { name: to, type, filter: short && f.filter === "1", card: short && f.card === "1" });
    if (short && group) next.group = group; else if (short) delete next.group;
    t.fields[i] = next;
    for (const e of t.entries) {
      if (!(was.name in e.details)) continue;
      let v = e.details[was.name];
      if (type === "tags" && !Array.isArray(v)) v = [String(v)];
      if (type === "text" && Array.isArray(v)) v = v.join(", ");
      delete e.details[was.name];
      e.details[to] = v;
    }
    return { url: fieldsUrl(t.name) + `#f${i}`, message: `Change field "${was.name}" in ${t.name}` };
  },
  moveField(d, f) {  // swaps with the next field up or down that this login may change
    const t = topicOf(d, f.c);
    const i = t.fields.findIndex(x => fieldName(x) === f.field);
    if (i < 0) throw new Bad(`There's no field ${f.field} in ${t.name}.`);
    mustOwn(typeof t.fields[i] === "string" ? {} : t.fields[i], f.field);
    const step = f.dir === "up" ? -1 : 1;
    let j = i + step;
    while (j >= 0 && j < t.fields.length && !mine(t.fields[j])) j += step;
    if (j < 0 || j >= t.fields.length) return { url: fieldsUrl(t.name) + `#f${i}` };
    [t.fields[i], t.fields[j]] = [t.fields[j], t.fields[i]];
    return { url: fieldsUrl(t.name) + `#f${j}`, message: `Move field "${f.field}" ${f.dir} in ${t.name}` };
  },
  removeField(d, f) {
    const t = topicOf(d, f.c);
    const i = t.fields.findIndex(x => fieldName(x) === f.field);
    if (i < 0) throw new Bad(`There's no field ${f.field} in ${t.name}.`);
    mustOwn(typeof t.fields[i] === "string" ? {} : t.fields[i], f.field);
    t.fields.splice(i, 1);
    for (const e of t.entries) delete e.details[f.field];
    return { url: fieldsUrl(t.name), message: `Remove field "${f.field}" from ${t.name}` };
  },
  renameQuestion(d, f) {
    const to = upperFirst(tidy(f.to, "question"));
    if (!questionKey(to) || questionKey(to) === "name") throw new Bad("That can't be a question's name.");
    const t = topicOf(d, f.c), old = f.q || "";
    const i = t.fields.findIndex(x => fieldName(x) === old && isQuestion(x));
    if (i < 0) throw new Bad(`There's no question ${old} in ${t.name}.`);
    mustOwn(t.fields[i], `"${old}"`);
    if (t.fields.some((x, j) => j !== i && questionKey(fieldName(x)) === questionKey(to))) throw new Bad(`${t.name} already has ${to}.`);
    t.fields[i] = Object.assign({}, t.fields[i], { name: to });
    for (const e of t.entries) {
      if (old in e.details && old !== to) { e.details[to] = e.details[old]; delete e.details[old]; }
    }
    return { url: questionUrl(t.name, to), message: `Rename question "${old}" to "${to}" in ${t.name}` };
  },
  removeQuestion(d, f) {
    const t = topicOf(d, f.c), old = f.q || "";
    const field = t.fields.find(x => fieldName(x) === old && isQuestion(x));
    if (field) mustOwn(field, `"${old}"`);
    const kept = t.fields.filter(x => !(fieldName(x) === old && isQuestion(x)));
    if (kept.length === t.fields.length) throw new Bad(`There's no question ${old} in ${t.name}.`);
    t.fields = kept;
    for (const e of t.entries) delete e.details[old];
    return { url: listUrl(t.name), message: `Remove question "${old}" from ${t.name}` };
  },
};

// ---- GitHub ----

function b64encode(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(b64.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}
const serialise = data => JSON.stringify(data, null, 1) + "\n";

function gh(method, path, body) {
  return fetch(API + path, {
    method, cache: "no-store",
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// A player's additions: {topics: [their own topics], extra: {<shared topic>: {fields: [their questions],
// entries: [names they added], answers: {<shared name>: {<question>: answer, or null for cleared}}}}}.
const emptyOver = () => ({ topics: [], extra: {} });
const copyOf = x => JSON.parse(JSON.stringify(x));
const strip = x => { const y = copyOf(x); delete y.own; return y; };

function merge(base, over) {  // the shared topics with a player's additions, their own things marked own
  const data = { topics: [], sized: base.sized };
  for (const t of base.topics) {
    const x = (over.extra || {})[t.name] || {};
    const answers = x.answers || {};
    const topic = { name: t.name, note: t.note, fields: copyOf(t.fields), entries: [] };
    for (const f of x.fields || []) topic.fields.push(Object.assign(copyOf(f), { own: true }));
    for (const e of t.entries) {
      const details = copyOf(e.details);
      for (const [q, v] of Object.entries(answers[e.name] || {})) { if (v === null) delete details[q]; else details[q] = v; }
      topic.entries.push({ name: e.name, details });
    }
    for (const e of x.entries || []) {
      if (!topic.entries.some(y => same(y.name, e.name))) topic.entries.push({ name: e.name, details: copyOf(e.details), own: true });
    }
    data.topics.push(topic);
  }
  for (const t of over.topics || []) {
    if (data.topics.some(y => same(y.name, t.name))) continue;
    const topic = copyOf(t);
    topic.own = true;
    topic.fields = topic.fields.map(f => (typeof f === "string" ? { name: f, own: true } : Object.assign(f, { own: true })));
    topic.entries.forEach(e => { e.own = true; });
    data.topics.push(topic);
  }
  return data;
}

function split(base, data) {  // the reverse of merge: just the player's additions
  const over = emptyOver();
  for (const t of data.topics) {
    const b = !t.own && base.topics.find(x => x.name === t.name);
    if (!b) {
      over.topics.push(Object.assign(strip(t), { fields: t.fields.map(strip), entries: t.entries.map(strip) }));
      continue;
    }
    const baseFields = new Set(b.fields.map(fieldName));
    const fields = t.fields.filter(f => !baseFields.has(fieldName(f))).map(strip);
    const asked = t.fields.filter(f => isQuestion(f) || f.own).map(fieldName);  // what a player may set on shared names
    const entries = [], answers = {};
    for (const e of t.entries) {
      const be = !e.own && b.entries.find(x => x.name === e.name);
      if (!be) { entries.push(strip(e)); continue; }
      const changed = {};
      for (const q of asked) {
        const now = e.details[q], was = be.details[q];
        if (JSON.stringify(now) !== JSON.stringify(was)) changed[q] = now === undefined ? null : now;
      }
      if (Object.keys(changed).length) answers[e.name] = changed;
    }
    if (fields.length || entries.length || Object.keys(answers).length) over.extra[t.name] = { fields, entries, answers };
  }
  return over;
}

async function readFile(path, ref) {  // {data, sha} through the API, or null if it isn't there
  const r = await gh("GET", `/repos/${OWNER}/${REPO}/contents/${path}?ref=${ref}`);
  if (r.status === 404) return null;
  if (r.status === 401) throw Object.assign(new Error("token"), { expired: true });
  if (!r.ok) throw new Error(`GitHub answered HTTP ${r.status} for ${path}.`);
  const j = await r.json();
  return { data: JSON.parse(b64decode(j.content)), sha: j.sha };
}

async function loadData() {
  if (MODE !== "view") {
    try {
      const base = await readFile(FILE, BRANCH);
      BASE = base.data;
      SHA = base.sha;
      if (MODE === "user" && !editingBase()) {
        const over = await readFile(userFile(whose()), USER_BRANCH);
        OVER = over ? over.data : emptyOver();
        OVER_SHA = over ? over.sha : null;
        DATA = merge(BASE, OVER);
      } else {
        DATA = BASE;
        OVER = null;
      }
      return;
    } catch (err) {
      if (!err.expired) throw err;
      logOut();
      flash("The saved login no longer works with GitHub. Log in again.", true);
    }
  }
  BASE = DATA = null;  // not logged in: nothing is loaded or shown
  SHA = null;
}

async function put(path, branch, data, sha, message) {
  const body = { message, content: b64encode(serialise(data)), branch };
  if (sha) body.sha = sha;
  return gh("PUT", `/repos/${OWNER}/${REPO}/contents/${path}`, body);
}

async function commit(change) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const player = !editingBase();
    if (attempt || !BASE || (!player && !SHA) || (player && !OVER)) await loadData();
    const copy = player ? merge(BASE, OVER) : copyOf(BASE);
    const result = change(copy);  // throws Bad before anything is sent
    const by = MODE === "user" ? `${USER}${whose() !== USER && player ? ` for ${whose()}` : ""}: ` : "";
    let r;
    if (player) {
      const next = split(BASE, copy);
      if (serialise(next) === serialise(OVER)) return result;  // nothing to save
      r = await put(userFile(whose()), USER_BRANCH, next, OVER_SHA, by + (result.message || "update"));
      if (r.ok) {
        OVER = next;
        OVER_SHA = (await r.json()).content.sha;
        DATA = merge(BASE, OVER);
        return result;
      }
    } else {
      if (serialise(copy) === serialise(BASE)) return result;
      r = await put(FILE, BRANCH, copy, SHA, by + (result.message || "Update"));
      if (r.ok) {
        BASE = DATA = copy;
        SHA = (await r.json()).content.sha;
        return result;
      }
    }
    if (r.status === 409 || r.status === 422) continue;  // someone saved first (or the file is new): reload, redo
    if ([401, 403, 404].includes(r.status)) {
      throw new Error(`GitHub refused it (HTTP ${r.status}). The token may have expired or lost Contents: read and write on ${OWNER}/${REPO}.`);
    }
    throw new Error(`GitHub answered HTTP ${r.status}.`);
  }
  throw new Error("Couldn't save after a few tries (someone else saving at the same moment?). Try again.");
}

// ---- Player logins (users.json: [{name, salt, iter, iv, key}], the token AES-GCM-encrypted per password) ----

const bytes64 = b => btoa(String.fromCharCode(...b));
const unbytes64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function passwordKey(password, salt, iterations) {
  const raw = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, raw,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function unlock(user, password) {  // the token, or null for a wrong password
  const key = await passwordKey(password, unbytes64(user.salt), user.iter);
  try {
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unbytes64(user.iv),
      additionalData: new TextEncoder().encode(user.name.toLowerCase()) }, key, unbytes64(user.key));
    return new TextDecoder().decode(plain);
  } catch (e) { return null; }
}

async function lock(name, password, token) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await passwordKey(password, salt, ITERATIONS);
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(name.toLowerCase()) },
    key, new TextEncoder().encode(token));
  return { name, salt: bytes64(salt), iter: ITERATIONS, iv: bytes64(iv), key: bytes64(new Uint8Array(sealed)) };
}

async function readUsers() {  // the newest users.json (the API, so a changed password works at once), else Pages' copy
  try {
    const r = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${USERS_FILE}?ref=${BRANCH}`, { cache: "no-store" });
    if (r.ok) { const j = await r.json(); return { data: JSON.parse(b64decode(j.content)), sha: j.sha }; }
  } catch (e) {}
  const r = await fetch(USERS_FILE, { cache: "no-cache" });
  if (!r.ok) throw new Error("Couldn't load the list of players.");
  return { data: await r.json(), sha: null };
}

async function logIn(name, password) {
  const users = (await readUsers()).data.users || [];
  const user = users.find(u => same(u.name, name.trim()));
  const token = user && await unlock(user, password);
  if (!token) throw new Error("Wrong username or password.");
  MODE = "user"; USER = user.name; TOKEN = token; ADMIN = !!user.admin;
  store("ch-mode", "user"); store("ch-user", user.name); store("ch-token", token); store("ch-login", null);
  store("ch-admin", ADMIN ? "1" : null);
  setTarget(null);
  OVER = null;
  await loadData();
}

async function changePassword(password) {
  const users = await readUsers();
  const list = users.data.users || [];
  const i = list.findIndex(u => same(u.name, USER));
  if (i < 0) throw new Error("You're not in the list of players any more.");
  list[i] = Object.assign({}, list[i], await lock(list[i].name, password, TOKEN));  // keeps "admin"
  const r = await put(USERS_FILE, BRANCH, users.data, users.sha, `${USER}: change password`);
  if (!r.ok) throw new Error(`GitHub answered HTTP ${r.status}. Try again.`);
}

// ---- Admin console ----

const PLAYER_NAME = /^[A-Za-z0-9_-]{2,30}$/;

function setTarget(t) {
  TARGET = t || null;
  try { if (TARGET) sessionStorage.setItem("ch-target", TARGET); else sessionStorage.removeItem("ch-target"); } catch (e) {}
}

async function editUsers(change, message) {  // change users.json: fresh copy, again if someone saved first
  for (let attempt = 0; attempt < 2; attempt++) {
    const file = await readFile(USERS_FILE, BRANCH);
    const data = file.data;
    data.users = data.users || [];
    await change(data.users);
    const r = await put(USERS_FILE, BRANCH, data, file.sha, `${USER}: ${message}`);
    if (r.ok) return;
    if (r.status !== 409) throw new Error(`GitHub answered HTTP ${r.status}.`);
  }
  throw new Error("Someone else changed the players at the same moment. Try again.");
}

function playerIndex(users, name) {
  const i = users.findIndex(u => same(u.name, name));
  if (i < 0) throw new Bad(`There's no player called ${name}.`);
  return i;
}

async function adminAction(action, form) {
  if (MODE !== "user" || !ADMIN) throw new Bad("Only admins can do that.");
  const name = (form.name || "").trim(), password = form.password || "";
  if ((action === "add" || action === "password") && password.length < 6) throw new Bad("Use at least 6 characters for the password.");
  if (action === "add") {
    if (!PLAYER_NAME.test(name)) throw new Bad("Use 2 to 30 letters, digits, - or _ for the username.");
    await editUsers(async users => {
      if (users.some(u => same(u.name, name))) throw new Bad(`There's already a player called ${name}.`);
      users.push(await lock(name, password, TOKEN));
    }, `add player ${name}`);
    return `Added ${name}.`;
  }
  if (action === "password") {
    await editUsers(async users => {
      const i = playerIndex(users, name);
      users[i] = Object.assign({}, users[i], await lock(users[i].name, password, TOKEN));
    }, `reset ${name}'s password`);
    return `${name}'s password is changed.`;
  }
  if (same(name, USER)) throw new Bad("You can't change that for yourself.");
  if (action === "admin") {
    const on = form.value === "1";
    await editUsers(async users => {
      const u = users[playerIndex(users, name)];
      if (on) u.admin = true; else delete u.admin;
    }, on ? `make ${name} an admin` : `remove ${name} as admin`);
    return on ? `${name} is now an admin.` : `${name} is no longer an admin.`;
  }
  if (action === "remove") {
    await editUsers(async users => { users.splice(playerIndex(users, name), 1); }, `remove player ${name}`);
    const file = await readFile(userFile(name), USER_BRANCH);
    if (file) await gh("DELETE", `/repos/${OWNER}/${REPO}/contents/${userFile(name)}`,
      { message: `${USER}: remove ${name}'s additions`, sha: file.sha, branch: USER_BRANCH });
    if (TARGET && same(TARGET, name)) { setTarget(null); await loadData(); }
    return `Removed ${name}.`;
  }
  throw new Bad("Unknown admin action.");
}

function summary(over) {  // what a player has added, in a few words
  const topics = (over.topics || []).length;
  let names = (over.topics || []).reduce((n, t) => n + (t.entries || []).length, 0), questions = 0, answers = 0;
  for (const t of over.topics || []) questions += (t.fields || []).filter(isQuestion).length;
  for (const x of Object.values(over.extra || {})) {
    names += (x.entries || []).length;
    questions += (x.fields || []).length;
    answers += Object.values(x.answers || {}).reduce((n, a) => n + Object.keys(a).length, 0);
  }
  const parts = [[topics, "topic", "topics"], [names, "name", "names"], [questions, "question", "questions"],
    [answers, "answer on shared names", "answers on shared names"]].filter(([n]) => n).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
  return parts.length ? parts.join(", ") : "nothing added yet";
}

function adminPage() {
  const header = "<h1>Celebrity Heads</h1>" + tabs(null) + "<h2>Admin console</h2>";
  if (MODE !== "user" || !ADMIN) {
    return { title: "Admin · Celebrity Heads", category: "", header, content: '<p class="empty">Only admins can open this.</p>' };
  }
  return { title: "Admin · Celebrity Heads", category: "", header,
    content: '<div id="admin-body"><p class="count">Loading the players…</p></div>', init: initAdmin };
}

async function initAdmin() {
  const box = $("admin-body");
  try {
    const users = (await readFile(USERS_FILE, BRANCH)).data.users || [];
    const added = await Promise.all(users.map(async u => {
      const f = await readFile(userFile(u.name), USER_BRANCH);
      return f ? summary(f.data) : "nothing added yet";
    }));
    if (!document.body.contains(box)) return;  // moved to another page meanwhile
    box.innerHTML = adminBody(users, added);
  } catch (err) {
    box.innerHTML = `<p class="empty">Couldn't load the players: ${esc(err.message)}</p>`;
  }
}

function adminBody(users, added) {
  const chip = (value, label) => `<button type="button" class="chip" data-target="${esc(value)}" ` +
    `aria-pressed="${(TARGET || "") === value}">${esc(label)}</button>`;
  const others = users.filter(u => !same(u.name, USER));
  const work = '<section class="adminsec"><h3>Work on</h3><p class="note">Pick whose data the topic pages show and change. ' +
    "The bar at the top says which, until you switch back.</p><div class=\"chips\">" +
    chip("", `My own (${USER})`) + chip(SHARED, "Shared topics (everyone)") +
    others.map(u => chip(u.name, `${u.name}'s`)).join("") + "</div></section>";
  const players = users.map((u, i) => {
    const me = same(u.name, USER);
    const keep = hidden({ name: u.name });
    return `<div class="player"><p class="qtext">${esc(u.name)}${u.admin ? ' <span class="badge">admin</span>' : ""}` +
      `${me ? ' <span class="missing">(you)</span>' : ""}<br><span class="missing">${esc(added[i])}</span></p>` +
      `<form data-admin="password" class="row">${keep}<input class="field" name="password" type="password" minlength="6" ` +
      `required autocomplete="new-password" placeholder="New password" aria-label="New password for ${esc(u.name)}">` +
      '<button class="btn">Set password</button></form>' +
      (me ? "" : `<div class="row"><form data-admin="admin">${keep}${hidden({ value: u.admin ? "0" : "1" })}` +
        `<button class="btn">${u.admin ? "Remove admin" : "Make admin"}</button></form>` +
        `<form data-admin="remove" data-confirm="Remove ${esc(u.name)} and everything they've added?">${keep}` +
        '<button class="btn danger">Remove player</button></form></div>') + "</div>";
  }).join("");
  const add = '<section class="adminsec"><h3>Add a player</h3><form data-admin="add" class="form">' +
    '<label>Username<input class="field" name="name" required pattern="[A-Za-z0-9_\\-]{2,30}" autocomplete="off" autocapitalize="off"></label>' +
    '<label>Password<input class="field" name="password" type="password" minlength="6" required autocomplete="new-password"></label>' +
    '<div class="row"><button class="btn primary">Add player</button></div></form></section>';
  return work + `<section class="adminsec"><h3>Players</h3>${players}</section>` + add;
}

// ---- The page ----

const $ = id => document.getElementById(id);

function flash(message, error = false, ms = 0) {
  const box = $("status");
  box.textContent = message;
  box.classList.toggle("error", error);
  box.hidden = false;
  clearTimeout(flash.timer);
  if (ms) flash.timer = setTimeout(() => { box.hidden = true; }, ms);
}

function loginPage() {
  const content = '<form class="form login" id="login-form"><h2>Log in</h2>' +
    '<label>Username<input class="field" id="login-name" autocomplete="username" autocapitalize="off" required></label>' +
    '<label>Password<input class="field" id="login-password" type="password" autocomplete="current-password" required></label>' +
    '<div class="row"><button class="btn primary">Log in</button></div></form>';
  return { title: "Log in · Celebrity Heads", category: "", header: "<h1>Celebrity Heads</h1>", content, init: initLogin };
}

function initLogin() {
  $("login-form").addEventListener("submit", async e => {
    e.preventDefault();
    flash("Logging in…");
    try {
      await logIn($("login-name").value, $("login-password").value);
      render();
      flash(`Logged in as ${USER}.`, false, 2500);
    } catch (err) { flash(err.message, true); }
  });
}

function render() {
  const params = new URLSearchParams(location.search);
  const page = MODE === "view" ? loginPage() : params.has("n") ? entryPage(params) : params.has("ask") ? questionPage(params)
    : params.has("new") ? newTopicPage() : params.has("admin") ? adminPage() : params.has("fields") ? fieldsPage(params) : listPage(params);
  document.title = page.title;
  document.body.dataset.category = page.category;
  $("head").innerHTML = page.header;
  $("main").innerHTML = page.content;
  const login = store("ch-login");
  $("account").innerHTML = MODE === "user"
    ? `<details class="menu"><summary>${esc(USER)}${ADMIN ? " · admin" : ""}</summary><div class="menu-list">` +
      (ADMIN ? '<a href="?admin">Admin console</a>' : "") +
      '<a href="#" id="password">Change password</a><a href="#" id="signout">Log out</a></div></details>'
    : MODE === "admin"
      ? `<details class="menu"><summary>Owner</summary><div class="menu-list">` +
        (login ? `<span class="missing">GitHub: ${esc(login)}</span>` : "") + '<a href="#" id="signout">Sign out</a></div></details>'
      : "";
  const working = MODE === "user" && TARGET;
  $("working").hidden = !working;
  $("working").innerHTML = !working ? "" : (TARGET === SHARED
    ? "Working on the <b>shared topics</b>: changes show for everyone"
    : `Working on <b>${esc(TARGET)}</b>'s additions`) + ' · <a href="#" id="mine">Back to mine</a>';
  $("foot").innerHTML = (MODE === "view" ? '<a href="#" id="signin">Owner sign-in</a><br>' : "") + esc(RIOT_NOTICE);
  if (page.init) page.init();
  const target = location.hash && document.getElementById(decodeURIComponent(location.hash.slice(1)));
  if (target) target.scrollIntoView();
}

function go(url) {
  history.pushState(null, "", url);
  render();
  if (!location.hash) window.scrollTo(0, 0);
}

function initEntry() {
  // Back to the list with the search and filters it had, if this tab came from that topic's list.
  try {
    const saved = sessionStorage.getItem("ch-list");
    const back = document.querySelector(".back");
    if (back && saved && new URLSearchParams(saved).get("c") === document.body.dataset.category)
      back.href = back.getAttribute("href").split("?")[0] + saved;
  } catch (e) {}
}

function initList() {
  const addBox = $("add");
  if (addBox) {
    $("addbtn").addEventListener("click", () => { addBox.showModal(); addBox.querySelector("[name=n]").focus(); });
    $("addclose").addEventListener("click", () => addBox.close());
    addBox.addEventListener("click", e => { if (e.target === addBox) addBox.close(); });
  }
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
}

async function save(op, form) {
  if (!canEdit()) { flash("Log in first (at the bottom of the page).", true); return; }
  for (const b of document.querySelectorAll("main button, header button")) b.disabled = true;
  flash("Saving…");
  try {
    const result = await commit(d => OPS[op](d, form));
    flash(result.note || "Saved", false, result.note ? 3000 : 1500);
    go(result.url);
  } catch (err) {
    for (const b of document.querySelectorAll("main button, header button")) b.disabled = false;
    flash(err instanceof Bad ? err.message : `Couldn't save: ${err.message}`, true);
  }
}

function logOut() {
  MODE = "view"; USER = null; TOKEN = null; SHA = null; OVER = null; OVER_SHA = null; ADMIN = false;
  setTarget(null);
  DATA = BASE;
  for (const k of ["ch-mode", "ch-user", "ch-token", "ch-login", "ch-admin"]) store(k, null);
}

async function signIn(token) {
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" };
  const r = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${FILE}?ref=${BRANCH}`, { headers, cache: "no-store" });
  if (!r.ok) throw new Error(r.status === 401 ? "GitHub doesn't accept that token." : `That token can't read ${OWNER}/${REPO} (HTTP ${r.status}).`);
  MODE = "admin"; USER = null; TOKEN = token;
  store("ch-mode", "admin"); store("ch-user", null); store("ch-token", token);
  try {
    const me = await fetch(`${API}/user`, { headers, cache: "no-store" });
    if (me.ok) store("ch-login", (await me.json()).login);
  } catch (e) {}
  await loadData();
}

function start() {
  TOKEN = store("ch-token") || null;
  MODE = TOKEN ? (store("ch-mode") === "user" && store("ch-user") ? "user" : "admin") : "view";
  USER = MODE === "user" ? store("ch-user") : null;
  ADMIN = MODE === "user" && store("ch-admin") === "1";
  try { TARGET = ADMIN ? sessionStorage.getItem("ch-target") : null; } catch (e) { TARGET = null; }
  document.addEventListener("click", async e => {
    const menu = document.querySelector("details.menu[open]");
    if (menu && !menu.contains(e.target)) menu.open = false;  // a click elsewhere closes the account menu
    const pick = e.target.closest("[data-target]");
    if (pick) {
      setTarget(pick.dataset.target);
      flash("Loading…");
      try { await loadData(); go("?"); flash(TARGET ? "Switched. The bar at the top shows whose data this is." : "Back to your own.", false, 2500); }
      catch (err) { flash(err.message, true); }
      return;
    }
    const a = e.target.closest("a");
    if (a && a.closest("details.menu")) a.closest("details.menu").open = false;
    if (a && a.id === "mine") {
      e.preventDefault(); setTarget(null); flash("Loading…");
      try { await loadData(); render(); flash("Back to your own.", false, 2000); } catch (err) { flash(err.message, true); }
      return;
    }
    if (a && a.id === "signin") { e.preventDefault(); $("signin-box").showModal(); $("token").focus(); return; }
    if (a && a.id === "password") { e.preventDefault(); $("password-box").showModal(); $("new-password").focus(); return; }
    if (a && a.id === "signout") { e.preventDefault(); logOut(); render(); flash("Logged out.", false, 2500); return; }
    // Links within the page (?c=…) render here without reloading.
    const href = a && a.getAttribute("href");
    if (!href || !href.startsWith("?") || a.target || e.ctrlKey || e.metaKey || e.shiftKey || e.button) return;
    e.preventDefault();
    go(href);
  });
  document.addEventListener("submit", async e => {
    const f = e.target;
    if (f.dataset.admin) {
      e.preventDefault();
      if (f.dataset.confirm && !confirm(f.dataset.confirm)) return;
      const form = Object.fromEntries(new FormData(f));
      for (const b of f.querySelectorAll("button")) b.disabled = true;
      flash("Saving…");
      try { const done = await adminAction(f.dataset.admin, form); render(); flash(done, false, 2500); }
      catch (err) {
        for (const b of f.querySelectorAll("button")) b.disabled = false;
        flash(err instanceof Bad ? err.message : `Couldn't save: ${err.message}`, true);
      }
      return;
    }
    if (!f.dataset.op) return;
    e.preventDefault();
    if (f.dataset.confirm && !confirm(f.dataset.confirm)) return;
    const form = Object.fromEntries(new FormData(f));
    if (e.submitter && e.submitter.name) form[e.submitter.name] = e.submitter.value;
    const dialog = f.closest("dialog");
    if (dialog) dialog.close();
    save(f.dataset.op, form);
  });
  window.addEventListener("popstate", render);
  $("signin-form").addEventListener("submit", async e => {
    e.preventDefault();
    const token = $("token").value.trim();
    if (!token) return;
    flash("Checking the token…");
    try {
      await signIn(token);
      $("signin-box").close();
      $("token").value = "";
      render();
      flash("Signed in. Editing is on for this device.", false, 2500);
    } catch (err) { flash(err.message, true); }
  });
  $("signin-cancel").addEventListener("click", () => $("signin-box").close());
  $("password-form").addEventListener("submit", async e => {
    e.preventDefault();
    const a = $("new-password").value, b = $("new-password-again").value;
    if (a.length < 6) { flash("Use at least 6 characters.", true); return; }
    if (a !== b) { flash("The two passwords don't match.", true); return; }
    flash("Saving the new password…");
    try {
      await changePassword(a);
      $("password-box").close();
      $("new-password").value = $("new-password-again").value = "";
      flash("Password changed. Use it next time you log in.", false, 3000);
    } catch (err) { flash(err.message, true); }
  });
  $("password-cancel").addEventListener("click", () => $("password-box").close());
  loadData().then(render).catch(err => {
    $("main").innerHTML = `<p class="empty">Couldn't load the data: ${esc(err.message)}</p>`;
  });
}

if (typeof module !== "undefined") {  // tests (Node)
  module.exports = { fieldSpecs, values, filters, listPage, entryPage, questionPage, newTopicPage, OPS, Bad, serialise,
    answerOptions, merge, split, lock, unlock,
    summary, SHARED, fieldsPage,
    set: (data, token, mode, user, admin, target) => { DATA = data; TOKEN = token; MODE = mode || (token ? "admin" : "view");
      USER = user || null; ADMIN = !!admin; TARGET = target || null; } };
} else {
  start();
}
