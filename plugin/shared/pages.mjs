// Pages: a page of widgets that agents (and people) keep up to date: a reliability dashboard, a product
// exploration, a blog post draft. A page lives on the machine where it was made, like a post, and is its
// owner's (the machine's). It's private (its owner and its contributors) or public (anyone signed in), and
// only its contributors change it: the agents and people its owner added, and the agent that made it.
//
// Every change is a version, with who made it (an agent in one of its posts, or a person by hand), what it
// changed widget by widget, and a copy of the page as it then was. Restoring an older version saves it as a
// new one, so nothing is ever lost. A write that changes nothing makes no version.
//
// The store applies the ops (page.create, page.write, page.restore, page.visibility, page.contributor,
// page.archive) with applyPage(); routes check and shape what goes into them with the helpers here.

import { isLevel, levelOf } from "./visibility.mjs";
import { routinesOfPage } from "./routines.mjs";
import { BODY_MAX, titled } from "./text.mjs";
import { WIDGET_MAX, WIDGETS, WIDTHS, cleanData, noteLines } from "./widgets.mjs";
import { isPanel, rangeLabel } from "./dashboards.mjs";

export const COLORS = ["purple", "teal", "red", "amber", "blue", "pink", "green", "gray"];
export const VERSIONS_KEPT = 300; // per page; older ones go
const WIDGETS_MAX = 60;

const str = (v, max) => (v == null ? "" : String(v).slice(0, max));
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// A page's id, from its title: "Reliability: platform" is "reliability-platform", and the next one with that
// title "reliability-platform-2".
export function pageId(title, taken) {
  const base = String(title || "page").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48).replace(/-$/, "") || "page";
  let id = base;
  for (let i = 2; taken(id); i++) id = `${base}-${i}`;
  return id;
}

/* ---------- widgets ---------- */

// A checklist on a page is the person's tasks, not a list of its own: a "tasks" widget shows the tasks on the
// page, from their Tasks list, and what an agent writes in it (`items`) becomes tasks there (server.mjs). A list
// written as a checklist (`check`) is one too, and so is a tasks widget written again as a list. The widget itself
// keeps no items.
const isChecklist = (input, prev) => (input.type || prev?.type) === "list" && (prev?.type === "tasks" || !!(input.data?.check ?? (prev?.type === "list" ? prev.data?.check : false)));
export const widgetType = (input, prev = null) => (isChecklist(input, prev) ? "tasks" : input.type || prev?.type);
// The tasks a write puts on a page, as given in a tasks widget (or a checklist): { id?, text, note?, for?, done? }.
// `sub`, a list item's line under it, is its note. `text` is its title and `note` its body, as titled() makes them.
export function taskItems(input) {
  const items = Array.isArray(input?.data?.items) ? input.data.items : [];
  return items
    .slice(0, WIDGETS.tasks.fields.items.max)
    .map((it) => (typeof it === "string" ? { text: it } : it && typeof it === "object" ? it : {}))
    .map((it) => ({ id: it.id ? str(it.id, 100) : null, ...titled(str(it.text, BODY_MAX), str(it.note ?? it.body ?? it.sub, BODY_MAX)), for: it.for ? str(it.for, 200).trim() : null, done: typeof it.done === "boolean" ? it.done : null }))
    .filter((it) => it.text || it.id);
}

// A filter: the values you pick from to narrow the page (each service, say), and what "all of them" is called.
// What you pick is yours, in the page's address; the widgets that follow it narrow to it (see followed). A time
// filter's values are periods that count back from when you look: "24h", "7d", "30d", "2w".
// A period as dates, counting back from now: "24h" from this hour, "7d" from the start of the day six days ago.
export function periodRange(v, now = Date.now()) {
  const m = String(v).match(/^(\d+)([hdw])$/);
  if (!m) return null;
  let from = now - Number(m[1]) * 3600e3;
  if (m[2] !== "h") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (Number(m[1]) * (m[2] === "w" ? 7 : 1) - 1));
    from = d.getTime();
  }
  return { from: new Date(from).toISOString(), to: new Date(now).toISOString() };
}
// The filters picked on a page, as a live routine gets them: values, and a time filter's period as dates.
export function filterInputs(p, picked) {
  const filters = Object.fromEntries(Object.entries(picked && typeof picked === "object" ? picked : {}).filter(([k, v]) => /^[\w-]{1,40}$/.test(k) && typeof v === "string" && v).slice(0, 8).map(([k, v]) => [k, v.slice(0, 80)]));
  const ranges = Object.fromEntries(Object.entries(filters).filter(([id]) => (p.widgets || []).some((w) => w.id === id && w.type === "filter" && w.data?.kind === "time")).map(([id, v]) => [id, periodRange(v)]).filter(([, r]) => r));
  return { filters, ranges };
}
// How a widget follows the page's filters, by the filter's id: `match` says where in it the picked value is (a
// table's column, "series" for a chart's lines, a list item's field), and `per` what it shows for each value, over
// its data (a number for one service). Each `per` is checked like the widget's own data.
const FILTER_ID = /^[\w-]{1,40}$/;
const pairs = (o, keep = (k) => FILTER_ID.test(k), n = 8) => (o && typeof o === "object" && !Array.isArray(o) ? Object.entries(o).filter(([k]) => keep(k)).slice(0, n) : []);
function followed(d, norm) {
  const { match, per, ...base } = d;
  if (match == null && per == null) return base;
  const out = { ...base };
  const m = pairs(match).filter(([, v]) => typeof v === "string" && v.trim());
  if (m.length) out.match = Object.fromEntries(m.map(([k, v]) => [k, str(v, 80)]));
  const only = (o, keys) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]));
  const p = pairs(per)
    .map(([k, vals]) => [k, Object.fromEntries(pairs(vals, (v) => v.length <= 80, 100).filter(([, o]) => o && typeof o === "object" && !Array.isArray(o)).map(([v, o]) => [v, only(norm({ ...base, ...o }, `data.per.${k}.${v}`), Object.keys(o))]))])
    .filter(([, vals]) => Object.keys(vals).length);
  if (p.length) out.per = Object.fromEntries(p);
  return out;
}

// One widget as given (by an agent, or edited by hand), merged over the one it updates: `data` merges key by
// key, as ab_attach does, unless the type changes. Its data is checked against its kind (widgets.mjs): it throws
// with all that's wrong, and adds to `notes` what was cut or left out on the way in.
export function widgetFrom(input, prev = null, notes = null) {
  if (!input || typeof input !== "object") throw new Error("Each widget is an object: { id, type, title, data }.");
  const id = str(input.id, 60).trim();
  if (!id) throw new Error("Each widget needs an id, so a later write can update it.");
  const type = widgetType(input, prev);
  if (!WIDGETS[type]) throw new Error(`Widget "${id}": type must be one of ${Object.keys(WIDGETS).join(", ")}.`);
  const same = prev && prev.type === type;
  // A checklist that becomes tasks keeps its place.
  const kept = same || (prev?.type === "list" && type === "tasks");
  const out = { errors: [], notes: [] };
  if (input.width != null && !WIDTHS[input.width]) out.errors.push(`width should be one of ${Object.keys(WIDTHS).join(", ")}, not ${JSON.stringify(input.width)}.`);
  const { match, per, ...given } = { ...(same ? prev.data : {}), ...(input.data && typeof input.data === "object" ? input.data : {}) };
  // A checklist's items are tasks (taskItems), which the widget doesn't keep.
  if (type === "tasks") delete given.check;
  let data = cleanData(type, given, out);
  if (type === "tasks") data = {};
  else if (WIDGETS[type].follows === false) {
    if (match != null || per != null) out.notes.push(`left out data.match and data.per: a ${type} widget doesn't follow filters.`);
  } else data = followed({ ...data, match, per }, (d, at) => cleanData(type, d, out, { at }));
  if (out.errors.length) throw new Error(out.errors.slice(0, 8).map((e) => `Widget "${id}": ${e}`).join("\n") + (out.errors.length > 8 ? `\n…and ${out.errors.length - 8} more like these.` : ""));
  if (notes) notes.push(...noteLines(out.notes).map((n) => `Widget "${id}": ${n}`));
  if (JSON.stringify(data).length > WIDGET_MAX) throw new Error(`Widget "${id}" is too big (over 200 KB).`);
  const width = WIDTHS[input.width] ? input.width : kept && prev.width ? prev.width : WIDGETS[type].width;
  const stack = input.stack === null ? null : input.stack ? str(input.stack, 40) : kept ? prev.stack || null : null;
  return { id, type, title: input.title != null ? str(input.title, 120) : prev?.title || "", width, stack, data };
}

// What a widget is, in a few words: "A table, 5 rows". A dashboard's panel keeps no numbers: "A chart, from datadog".
export function describe(w) {
  const d = w.data || {};
  if (isPanel(w)) return `${WIDGETS[w.type]?.name || "A panel"}, from ${w.query.source}`;
  if (w.type === "table") return `A table, ${plural(d.rows?.length || 0, "row")}`;
  if (w.type === "list") return `A list, ${plural(d.items?.length || 0, "item")}`;
  if (w.type === "tasks") return "A task list";
  if (w.type === "chart") return `A ${{ bar: "bar ", stacked: "stacked bar ", scatter: "scatter " }[d.kind] || ""}chart, ${plural(d.series?.length || 0, "series").replace("seriess", "series")}`;
  if (w.type === "doc") return `Text, ${plural(words(d.text), "word")}`;
  if (w.type === "options") return `Options, ${d.items?.length || 0}`;
  if (w.type === "filter") return `A filter, ${plural(d.values?.length || 0, "value")}`;
  return WIDGETS[w.type]?.name || "A widget";
}
const words = (t) => (String(t || "").match(/\S+/g) || []).length;
const metricText = (d) => `${d.value ?? "–"}${d.unit ? (/^[%°]/.test(d.unit) ? d.unit : ` ${d.unit}`) : ""}`;
// What a widget shows, for an agent told about the page: "a table, 5 rows", "a number, 412 ms".
export const outline = (w) => (w.type === "metric" ? `a number, ${metricText(w.data || {})}` : describe(w).toLowerCase());
// A panel's query, shape, thresholds and markers are part of how it looks.
const PANEL_KEYS = ["query", "shape", "thresholds", "markers"];
const panelOf = (w) => Object.fromEntries(PANEL_KEYS.filter((k) => w[k] != null).map((k) => [k, w[k]]));
const looks = (w) => JSON.stringify({ type: w.type, title: w.title, width: w.width, stack: w.stack || null, data: w.data, ...panelOf(w) });

// How a widget changed, or null if it didn't.
function widgetChange(o, w) {
  if (looks(o) === looks(w)) return null;
  if (o.type !== w.type) return { text: `Now ${describe(w).toLowerCase()}` };
  // A panel: its query, how it's shown, or its thresholds.
  if (isPanel(w) || isPanel(o)) {
    const moved = (k) => JSON.stringify(o[k] ?? null) !== JSON.stringify(w[k] ?? null);
    const said = [moved("query") ? "a new query" : "", moved("shape") ? "shown differently" : "", moved("thresholds") ? "new thresholds" : "", moved("markers") ? "new markers" : ""].filter(Boolean);
    if (said.length) return { text: said.join(", ").replace(/^./, (c) => c.toUpperCase()) };
  }
  const sameData = JSON.stringify(o.data) === JSON.stringify(w.data);
  if (sameData && o.title !== w.title) return { what: "title", from: o.title, to: w.title };
  if (sameData) return { text: o.width !== w.width ? "Resized" : "Moved" };
  const a = o.data || {};
  const b = w.data || {};
  if (w.type === "metric" && (a.value !== b.value || a.unit !== b.unit)) return { from: metricText(a), to: metricText(b) };
  if (w.type === "table") {
    const n = b.rows?.length || 0;
    const m = a.rows?.length || 0;
    if (n !== m) return { text: `${plural(n, "row")}, was ${m}` };
    const k = (b.rows || []).filter((r, i) => JSON.stringify(r) !== JSON.stringify(a.rows?.[i])).length;
    if (k) return { text: `${plural(k, "row")} changed` };
  }
  if (w.type === "list") {
    const n = b.items?.length || 0;
    const m = a.items?.length || 0;
    const done = (d) => (d.items || []).filter((x) => x.done).length;
    if (n !== m) return { text: `${plural(n, "item")}, was ${m}` };
    if (done(b) !== done(a)) return { text: `${done(b)} done, was ${done(a)}` };
  }
  if (w.type === "chart") {
    const ax = a.x || [];
    const bx = b.x || [];
    if (bx.length > ax.length && ax.every((x, i) => x === bx[i])) {
      const added = bx.slice(ax.length);
      return { text: `Added ${added.slice(0, 3).join(", ")}${added.length > 3 ? ` and ${added.length - 3} more` : ""}` };
    }
    return { text: "New data" };
  }
  if (w.type === "note" || w.type === "doc") {
    const diff = words(b.text) - words(a.text);
    return { text: diff > 0 ? `+${plural(diff, "word")}` : diff < 0 ? `−${plural(-diff, "word")}` : "Rewritten" };
  }
  if (w.type === "options") {
    const picked = (b.items || []).find((x) => x.pick && !(a.items || []).find((y) => y.name === x.name)?.pick);
    if (picked) return { text: `Picked ${picked.name}` };
    if ((b.items?.length || 0) !== (a.items?.length || 0)) return { text: `${b.items?.length || 0} options, was ${a.items?.length || 0}` };
  }
  if (w.type === "link" && a.url !== b.url) return { text: "Links somewhere else" };
  if (w.type === "filter" && (a.values || []).join() !== (b.values || []).join()) return { text: `${plural(b.values?.length || 0, "value")}, was ${a.values?.length || 0}` };
  if (w.type === "html") return { text: ["html", "css", "js"].some((k) => a[k] !== b[k]) ? "Rebuilt" : JSON.stringify(a.data) !== JSON.stringify(b.data) ? "New data" : "Resized" };
  return { text: o.title !== w.title ? `Renamed, and changed` : "Changed" };
}

// What changed between two states of a page ({ title, emoji, about, widgets }), widget by widget.
export function changesBetween(before, after) {
  const out = [];
  if (before.title !== after.title) out.push({ w: "Title", kind: "changed", what: "title", from: before.title, to: after.title });
  if (before.emoji !== after.emoji) out.push({ w: "Icon", kind: "changed", from: before.emoji, to: after.emoji });
  if ((before.about || "") !== (after.about || "")) out.push({ w: "Description", kind: "changed", text: after.about ? "Rewritten" : "Removed" });
  // A dashboard's variables, and the range it opens on.
  const vars = (d) => JSON.stringify(d?.vars || []);
  if (vars(before.dash) !== vars(after.dash)) out.push({ w: "Variables", kind: "changed", text: (after.dash?.vars || []).length ? (after.dash.vars.map((v) => v.label).join(", ")) : "None now" });
  if ((before.dash?.range || null) !== (after.dash?.range || null) && after.dash) out.push({ w: "Range", kind: "changed", from: rangeLabel(before.dash?.range), to: rangeLabel(after.dash.range) });
  const old = new Map(before.widgets.map((w) => [w.id, w]));
  const now = new Map(after.widgets.map((w) => [w.id, w]));
  const name = (w, o) => w.title || o?.title || WIDGETS[w.type]?.name;
  for (const w of after.widgets) {
    const o = old.get(w.id);
    if (!o) {
      out.push({ id: w.id, w: name(w), kind: "added", text: describe(w) });
      continue;
    }
    const c = widgetChange(o, w);
    if (c) out.push({ id: w.id, w: c.what === "title" ? o.title || WIDGETS[w.type]?.name : name(w, o), kind: "changed", ...c });
  }
  for (const o of before.widgets) if (!now.has(o.id)) out.push({ id: o.id, w: name(o), kind: "removed", text: describe(o) });
  const kept = after.widgets.filter((w) => old.has(w.id)).map((w) => w.id).join("\n");
  const was = before.widgets.filter((w) => now.has(w.id)).map((w) => w.id).join("\n");
  if (kept !== was) out.push({ w: "Layout", kind: "changed", text: "Moved widgets around" });
  return out;
}

/* ---------- who sees and changes it ---------- */

// `who`: { agent } or { user }. The page's owner is the machine's, and isn't listed.
export const contributes = (p, who) => !!who && (p.contributors || []).some((c) => (who.agent && c.agent === who.agent) || (who.user && c.user === who.user));
export const pagePublic = (p) => p?.visibility === "public";

/* ---------- applying the ops (the store calls this) ---------- */

const keep = (w) => ({ id: w.id, type: w.type, title: w.title, width: w.width, stack: w.stack || null, data: w.data, ...panelOf(w), v: w.v, at: w.at, by: w.by });
const snapshot = (p) => ({ title: p.title, emoji: p.emoji, about: p.about, widgets: p.widgets.map(keep), ...(p.dash ? { dash: p.dash } : {}) });

// Save the page as it is now as its next version. `changes` were worked out against how it was. A routine's
// refresh (routines.mjs) is `quiet`: the page doesn't move up the feed (`moved` stays), and it doesn't count
// among the times it was updated today.
function addVersion(state, p, { at, by, summary, changes, restored = null, hand = false, quiet = false }) {
  p.version = (p.version || 0) + 1;
  for (const w of p.widgets) if (!w.v || changes.some((c) => c.id === w.id && c.kind !== "removed")) Object.assign(w, { v: p.version, at, by });
  const v = { id: `${p.id}@${p.version}`, page: p.id, v: p.version, at, by, summary: summary || autoSummary(changes, restored), changes, restored, hand, ...(quiet ? { quiet } : {}), snapshot: snapshot(p) };
  state.page_versions.push(v);
  if (quiet) p.moved ||= p.updated;
  else p.moved = at;
  p.updated = at;
  p.last = { v: p.version, at, by, summary: v.summary, changes, restored, hand };
  if (!quiet) p.recent = [...(p.recent || []), { v: p.version, at, by }].slice(-30);
  keepVersions(state, p.id);
}
// Only the newest versions of each page stay: its newest 300 that no routine wrote, and of each routine's, its
// newest 48 and the last of each day for 90 days.
export const ROUTINE_VERSIONS_KEPT = 48;
function keepVersions(state, pid) {
  const mine = state.page_versions.filter((x) => x.page === pid);
  const drop = new Set();
  const theirs = mine.filter((x) => !x.by?.routine);
  for (const x of theirs.slice(0, Math.max(0, theirs.length - VERSIONS_KEPT))) drop.add(x);
  const byRoutine = {};
  for (const x of mine) if (x.by?.routine) (byRoutine[x.by.routine] ||= []).push(x);
  const since = Date.now() - 90 * 864e5;
  for (const list of Object.values(byRoutine)) {
    if (list.length <= ROUTINE_VERSIONS_KEPT) continue;
    const lastOfDay = new Map();
    for (const x of list) lastOfDay.set(x.at.slice(0, 10), x);
    const days = new Set([...lastOfDay.values()].filter((x) => Date.parse(x.at) > since));
    for (const x of list.slice(0, list.length - ROUTINE_VERSIONS_KEPT)) if (!days.has(x)) drop.add(x);
  }
  if (drop.size) state.page_versions = state.page_versions.filter((x) => !drop.has(x));
}
function autoSummary(changes, restored) {
  if (restored) return `Restored v${restored}`;
  if (!changes.length) return "No changes";
  const list = (names) => `${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""}`;
  const parts = ["added", "changed", "removed"]
    .map((kind) => [kind, changes.filter((c) => c.id && c.kind === kind).map((c) => c.w)])
    .filter(([, names]) => names.length)
    .map(([kind, names]) => `${kind} ${list(names)}`);
  if (!parts.length) return `Changed the ${changes[0].w.toLowerCase()}`;
  const text = parts.join(", ");
  return text[0].toUpperCase() + text.slice(1);
}

// The page as a write (page.write's widgets, remove, order, title…) would leave it.
function written(p, op) {
  const byId = new Map(p.widgets.map((w) => [w.id, w]));
  const next = p.widgets.map((w) => ({ ...w }));
  const at = new Map(next.map((w, i) => [w.id, i]));
  for (const w of op.widgets || []) {
    if (at.has(w.id)) next[at.get(w.id)] = { ...byId.get(w.id), ...w };
    else {
      at.set(w.id, next.length);
      next.push({ ...w });
    }
  }
  const gone = new Set(op.remove || []);
  let widgets = next.filter((w) => !gone.has(w.id));
  if (Array.isArray(op.order) && op.order.length) {
    const rank = new Map(op.order.map((id, i) => [id, i]));
    widgets = widgets.map((w, i) => ({ w, i })).sort((a, b) => (rank.get(a.w.id) ?? 1e6 + a.i) - (rank.get(b.w.id) ?? 1e6 + b.i)).map((x) => x.w);
  }
  const dash = op.dash || p.dash;
  return { title: op.title || p.title, emoji: op.emoji || p.emoji, about: op.about != null ? op.about : p.about, widgets, ...(dash ? { dash } : {}) };
}
// What a write would change, without making it.
export const writeChanges = (p, op) => changesBetween(snapshot(p), written(p, op));

export function applyPage(state, op, now) {
  const p = state.pages[op.pid];
  switch (op.t) {
    case "page.create": {
      if (p) break;
      // `owner`: the person whose page it is (who made it, or whose agent did), on a server many people use.
      // A dashboard (`kind`) has panels that hold queries, and its variables and range (`dash`: dashboards.mjs).
      const page = { id: op.pid, title: op.title, emoji: op.emoji || "📄", color: op.color || null, about: op.about || "", visibility: levelOf(op.visibility), by: op.by, owner: op.owner || null, contributors: op.contributors || [], widgets: [], version: 0, created: now, updated: now, archived: null, ...(op.kind === "dashboard" ? { kind: "dashboard", dash: op.dash || { vars: [], range: "24h" } } : {}) };
      state.pages[op.pid] = page;
      const empty = { title: page.title, emoji: page.emoji, about: page.about, widgets: [], ...(page.dash ? { dash: page.dash } : {}) };
      page.widgets = (op.widgets || []).map((w) => ({ ...w }));
      addVersion(state, page, { at: now, by: op.by, summary: op.summary || "Made the page", changes: changesBetween(empty, snapshot(page)).filter((c) => c.id), hand: !!op.hand });
      break;
    }
    case "page.write": {
      if (!p) break;
      const before = snapshot(p);
      const after = written(p, op);
      const changes = changesBetween(before, after);
      if (!changes.length) break;
      Object.assign(p, { title: after.title, emoji: after.emoji, about: after.about, widgets: after.widgets, ...(after.dash ? { dash: after.dash } : {}) });
      addVersion(state, p, { at: now, by: op.by, summary: op.summary, changes, hand: !!op.hand, quiet: !!op.quiet });
      break;
    }
    case "page.restore": {
      const v = p && state.page_versions.find((x) => x.page === p.id && x.v === op.v);
      if (!v) break;
      const changes = changesBetween(snapshot(p), v.snapshot);
      if (!changes.length) break;
      Object.assign(p, { title: v.snapshot.title, emoji: v.snapshot.emoji, about: v.snapshot.about, widgets: v.snapshot.widgets.map((w) => ({ ...w })), ...(v.snapshot.dash ? { dash: v.snapshot.dash } : {}) });
      addVersion(state, p, { at: now, by: op.by, changes, restored: op.v, hand: true });
      break;
    }
    case "page.visibility": {
      // Who sees it, and whether the people who keep it see the work of the threads on it (`show_work`, on unless
      // its owner turned it off).
      if (p && isLevel(op.visibility)) p.visibility = op.visibility;
      if (p && op.show_work !== undefined) p.show_work = !!op.show_work;
      break;
    }
    case "page.color": {
      if (p) p.color = COLORS.includes(op.color) ? op.color : null;
      break;
    }
    case "page.contributor": {
      // Added (as an editor) or taken off. What they wrote stays in its versions.
      if (!p || !op.who) break;
      const same = (c) => (op.who.agent && c.agent === op.who.agent) || (op.who.user && c.user === op.who.user);
      if (op.remove) p.contributors = p.contributors.filter((c) => !same(c) || c.role === "made");
      else if (!p.contributors.some(same)) p.contributors.push({ ...op.who, role: op.role === "made" ? "made" : "editor", at: now, by: op.by || null });
      break;
    }
    case "page.archive": {
      if (p) p.archived = op.archived ? now : null;
      break;
    }
    case "page.post": {
      // A thread its person put on a page by hand (`pid`), moved from another, or took off (`pid` null, `was` the
      // page it left): where it is from then on, ahead of the page it worked out (postPages). `told`: its agent
      // heard so, with its next message.
      state.page_posts ||= {};
      state.page_posts[op.post] = { page: op.pid || null, was: op.was || null, by: op.by || null, at: now, told: false };
      break;
    }
    case "page.told": {
      const m = state.page_posts?.[op.post];
      if (m) m.told = true;
      break;
    }
  }
}

// A page for the feed's state: everything but its versions, which load with the page itself.
export const pageSummary = (p, state) => ({ ...p, versions: state.page_versions.reduce((n, v) => n + (v.page === p.id ? 1 : 0), 0), routines: state.routines ? routinesOfPage(state, p.id) : [] });

// A page in full: its versions (newest first, without their copies of the page), and its threads: the ones
// that changed it, and the ones started from it, which may only have asked about it.
export function pageDetail(state, id) {
  const p = state.pages[id];
  if (!p) return null;
  const versions = state.page_versions.filter((v) => v.page === id).reverse().map(({ snapshot: _, ...v }) => v);
  const posts = {};
  for (const v of versions) {
    if (!v.by?.post) continue;
    const x = (posts[v.by.post] ||= { post: v.by.post, agent: v.by.agent, versions: 0, first: v.v, last: v.v, at: v.at });
    x.versions++;
    x.first = Math.min(x.first, v.v);
  }
  for (const l of Object.values(state.launches || {})) if (l.page === id && l.post) posts[l.post] ||= { post: l.post, agent: l.agent, versions: 0, at: l.at };
  return { ...pageSummary(p, state), history: versions, posts: Object.values(posts) };
}

// The page each post is on, by post: the one its person put it on by hand (or none, once they took it off it);
// else the one it was started from (by any of its launches), or the one it made when it was asked for a new page;
// else the one it changed last, as the page counts it among its threads. A page that's gone isn't one.
export function postPages(state) {
  const out = {};
  for (const l of Object.values(state.launches || {})) {
    if (!l.page || !l.post || out[l.post]) continue;
    const id = l.page === "new" ? state.page_versions.find((v) => v.v === 1 && v.by?.post === l.post)?.page : l.page;
    if (id && state.pages[id]) out[l.post] = id;
  }
  const changed = {};
  for (const v of state.page_versions) if (v.by?.post && state.pages[v.page]) changed[v.by.post] = v.page;
  for (const [post, id] of Object.entries(changed)) out[post] ||= id;
  for (const [post, m] of Object.entries(state.page_posts || {})) {
    if (m.page && state.pages[m.page]) out[post] = m.page;
    else delete out[post];
  }
  return out;
}
