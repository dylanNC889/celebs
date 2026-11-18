const T = process.env.T || "/tmp/t";  // the work folder tests/run.sh sets up
const fs = require("fs");
const app = require(T + "/app.js");
const check = (label, ok) => console.log((ok ? "PASS " : "FAIL ") + label);
const base = JSON.parse(fs.readFileSync(T + "/data.json", "utf8"));
delete base.topics[0].noNewNames;  // these checks add names to Valorant
let over = { topics: [], extra: {} };
const page = q => { const p = new URLSearchParams(q); const x = p.has("n") ? app.entryPage(p) : p.has("ask") ? app.questionPage(p) : p.has("fields") ? app.fieldsPage(p) : app.listPage(p); return x.header + x.content; };
function as(op, form, mode = "player") {
  const shared = mode === "shared";
  const data = shared ? JSON.parse(JSON.stringify(base)) : app.merge(base, over);
  app.set(data, "t", "user", "Akimei", true, shared ? app.SHARED : null);
  try { const r = app.OPS[op](data, form); if (shared) Object.assign(base, data); else over = app.split(base, data); return r; }
  catch (e) { if (e instanceof app.Bad) return { bad: e.message }; throw e; }
}
const view = q => { app.set(app.merge(base, over), "t", "user", "Akimei", true, null); return page(q); };

// bulk add
let r = as("addName", { c: "Valorant", n: "TenZ\nShroud\n\nshroud\n  Jett  " });
check(`bulk add: ${r.note}`, r.note === "Added 2 names (2 already there)" && r.url === "?c=Valorant" && over.extra.Valorant.entries.map(e => e.name).join() === "Shroud,TenZ");
r = as("addName", { c: "Valorant", n: "Asuna" });
check("single name still opens its page", r.url === "?c=Valorant&n=Asuna");
check("over 300 names refused", !!as("addName", { c: "Valorant", n: Array.from({ length: 301 }, (_, i) => "N" + i).join("\n") }).bad);

// edit details
as("editDetails", { c: "Valorant", n: "TenZ", "f:Role": "  Duelist ", "f:Origin": "Canada", "f:Real name": "" });
check("own name: shared fields can be filled", JSON.stringify(over.extra.Valorant.entries.find(e => e.name === "TenZ").details) === '{"Role":"Duelist","Origin":"Canada"}');
r = as("editDetails", { c: "Valorant", n: "Jett", "f:Role": "Sentinel" });
check("shared name: shared fields ignored for a player", r.note === "Nothing changed" && !(over.extra.Valorant.answers || {}).Jett);
check("edit form on Jett: only a note (no own fields yet)", view("?c=Valorant&n=Jett").includes("These details are shared"));
check("edit form on TenZ: all fields editable", (view("?c=Valorant&n=TenZ").match(/name="f:/g) || []).length === 16);

// fields
r = as("addField", { c: "Valorant", name: "weapons", type: "tags", filter: "1", card: "1", group: "" });
check("add a several-values field", over.extra.Valorant.fields[0].name === "Weapons" && over.extra.Valorant.fields[0].type === "tags" && r.url === "?c=Valorant&ask=Weapons");
as("addField", { c: "Valorant", name: "Main", type: "text", filter: "1", group: "Pro" });
as("editDetails", { c: "Valorant", n: "Jett", "f:Weapons": "Vandal, operator, Vandal", "f:Main": "TenZ" });
as("editDetails", { c: "Valorant", n: "TenZ", "f:Weapons": "Vandal" });
check("own fields on a shared name go in answers", JSON.stringify(over.extra.Valorant.answers.Jett) === '{"Weapons":["Vandal","operator"],"Main":"TenZ"}');
let list = view("?c=Valorant");
check("filter for the several-values field: has-all mode, counts", /data-field="Weapons" data-mode="all" data-kind="chips">.*data-value="Vandal"[^>]*>Vandal<span class="n">2</s.test(list));
check("field in its own filter tab", />Pro<span class="n">/.test(list));
check("shown on cards", /n=Jett".*?class="meta">[^<]*Vandal, operator/s.test(list));
check("fields page: shared rows read-only, own rows editable", (() => { const f = view("?c=Valorant&fields=1"); return f.includes("Role<br>") && f.includes("· shared") && (f.match(/data-op="updateField"/g) || []).length === 2; })());
check("can't change a shared field as a player", !!as("updateField", { c: "Valorant", field: "Role", to: "Class", type: "text" }).bad && !!as("removeField", { c: "Valorant", field: "Role" }).bad);
check("name clash refused", !!as("addField", { c: "Valorant", name: "role", type: "text" }).bad);
as("updateField", { c: "Valorant", field: "Weapons", to: "Guns", type: "text", filter: "", card: "1", group: "" });
check("rename + several→one value converts values, filter off", over.extra.Valorant.answers.Jett.Guns === "Vandal, operator" && !view("?c=Valorant").includes('data-field="Guns"'));
r = as("moveField", { c: "Valorant", field: "Main", dir: "up" });
check("move own field up (past nothing shared)", over.extra.Valorant.fields.map(f => f.name).join() === "Main,Guns");
as("moveField", { c: "Valorant", field: "Main", dir: "up" });
check("move stops at shared fields", over.extra.Valorant.fields.map(f => f.name).join() === "Main,Guns");
as("removeField", { c: "Valorant", field: "Guns" });
check("remove own field and its values", !JSON.stringify(over).includes("Guns") && !JSON.stringify(over).includes("Vandal"));

// several-answer questions
as("answer", { c: "Valorant", n: "Jett", q: "Powers", a: "wind, Dash", multi: "1", back: "entry" });
check("several answers from typed commas", JSON.stringify(over.extra.Valorant.answers.Jett.Powers) === '["Wind","Dash"]' && over.extra.Valorant.fields.find(f => f.name === "Powers").type === "tags");
as("answer", { c: "Valorant", n: "Jett", q: "Powers", pick: "Wind", back: "entry" });
check("a button toggles its answer off", JSON.stringify(over.extra.Valorant.answers.Jett.Powers) === '["Dash"]');
as("answer", { c: "Valorant", n: "Jett", q: "Powers", pick: "Wind", back: "entry" });
as("answer", { c: "Valorant", n: "TenZ", q: "Powers", a: "dash", back: "entry" });
check("toggles back on; spelling reused", JSON.stringify(over.extra.Valorant.answers.Jett.Powers) === '["Dash","Wind"]' && JSON.stringify(over.extra.Valorant.entries.find(e => e.name === "TenZ").details.Powers) === '["Dash"]');
const jett = view("?c=Valorant&n=Jett");
check("profile: both answers pressed, Add answers…", /value="Dash" aria-pressed="true".*value="Wind" aria-pressed="true"/s.test(jett) && jett.includes("Add answers…"));
check("filter: Powers in Questions with has-all", /data-field="Powers" data-mode="all"/.test(view("?c=Valorant")));
as("answer", { c: "Valorant", n: "Jett", q: "Powers", clear: "1", back: "entry" });
check("clear all answers", !(over.extra.Valorant.answers.Jett || {}).Powers);
check("single-answer questions unchanged (Yes/No)", (as("answer", { c: "Valorant", n: "Sage", q: "Heals?", pick: "Yes", back: "entry" }), over.extra.Valorant.answers.Sage["Heals?"] === "Yes"));

// shared mode (admin)
as("editDetails", { c: "Valorant", n: "Jett", "f:Origin": "South Korea (Seoul)" }, "shared");
check("admin on shared topics edits shared details", base.topics[0].entries.find(e => e.name === "Jett").details.Origin === "South Korea (Seoul)");
as("updateField", { c: "Book Characters", field: "Book", to: "Book", type: "text", filter: "1", card: "1", group: "" }, "shared");
check("admin turns a shared field into a filter", base.topics[1].fields[0].filter === true && typeof base.topics[1].fields[0] === "object");
check("round trip with arrays stable", JSON.stringify(app.split(base, app.merge(base, over))) === JSON.stringify(over));
