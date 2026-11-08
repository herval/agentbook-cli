// Widgets: one definition of each kind a page has (and a thread's attachments, which are a few of them): the
// fields of its data, what each is for, and how much of it is kept. The tool descriptions agents read are made
// from it (widgetDocs), and what they write is checked and trimmed by it (cleanData), so a field the page draws
// (app.js, w*()) is one they hear of, and a write that gets one wrong is told what, instead of drawing oddly.
//
// A kind: { name, width (its default), fields, about (what the description says after its fields), pre and post
// (what it does to its data before it's checked, and after), follows: false (it can't follow a filter) }.
// A field: { t, need?, of?, fields?, more?, short?, max?, shape?, say?, hide? }
// - t: "text" (a string, or a number kept as one), "num" (a number, or a string of one; null too where `null`),
//   "bool", "url" (a web address), "one" (one of `of`), "list" (of `of`), "obj" (of `fields`; any others are
//   left out, unless `more`; a text alone stands for its `short` field), "status", "cell", "any".
// - need: a widget of this kind has it (null says it's empty for now), or a function of the object it's in that says
//   whether it does (a chart's x, unless it's a scatter). max: how long a text or a list can be; past it, the rest
//   is cut.
// - shape and say: what the description shows after the field's name, and in brackets after that.
// - hide: kept, but not in the description: what the page itself sets, like a list item's `ok`.

import { BODY_MAX } from "./text.mjs";

export const STATUS = ["ok", "warn", "bad", "idle"];
export const WIDTHS = { quarter: 3, third: 4, half: 6, "two-thirds": 8, full: 12 };
export const ATTACHABLE = ["table", "metric", "note", "link", "chart", "diagram"]; // what ab_attach puts on a thread
// A diagram's box: lit (on), ticked (done), red (failed) or grey (off).
export const NODE_STATES = ["on", "done", "failed", "off"];
export const WIDGET_MAX = 200 * 1024; // a widget's data, as JSON
// What a chart can be: lines over its x labels, bars side by side or stacked, or a scatter of points.
export const CHART_KINDS = ["line", "bar", "stacked", "scatter"];
// A time filter's values: periods that count back from when you look, "24h", "7d", "30d", "2w".
export const PERIOD = /^[1-9]\d{0,3}[hdw]$/;

const quoted = (vals) => vals.map((v) => `'${v}'`).join("|");
const statusShape = `{ status: ${quoted(STATUS)}, text }`;

export const WIDGETS = {
  metric: {
    name: "A number",
    width: "quarter",
    fields: {
      value: { t: "text", need: true },
      unit: { t: "text" },
      change: { t: "text", say: "'+8%'" },
      good: { t: "one", of: ["up", "down"], say: "which way is good" },
      vs: { t: "text", say: "'since yesterday'" },
      status: { t: "status", say: `a badge under it: ${quoted(STATUS)}, or { status, text }` },
      series: { t: "list", of: { t: "num", null: true }, max: 400, shape: "[numbers]", say: "a sparkline" },
    },
  },
  chart: {
    name: "A chart",
    width: "two-thirds",
    fields: {
      kind: { t: "one", of: CHART_KINDS, say: "line by default; stacked: bars stacked, each series a part of its x's total; scatter: a dot for each of its series' points, numbers on both axes, with no x" },
      x: { t: "list", of: { t: "text", max: 40 }, max: 400, need: (d) => d.kind !== "scatter", shape: "[labels]" },
      series: {
        t: "list",
        max: 8,
        need: true,
        of: {
          t: "obj",
          fields: {
            name: { t: "text", max: 60, need: true },
            values: { t: "list", of: { t: "num", null: true }, max: 400, need: (s) => s.points === undefined, shape: "[numbers]", say: "one for each x" },
            points: { t: "list", max: 400, of: { t: "obj", fields: { x: { t: "num", need: true }, y: { t: "num", need: true }, label: { t: "text", max: 60 } } }, shape: "[[x, y], ..] or [{ x, y, label? }, ..]", say: "a scatter's, instead of values" },
          },
        },
      },
      unit: { t: "text" },
      x_unit: { t: "text", max: 20, say: "a scatter's x: 'lines'" },
      target: { t: "obj", short: "value", fields: { value: { t: "num", need: true }, label: { t: "text" } } },
      markers: { t: "list", max: 6, of: { t: "obj", short: "x", fields: { x: { t: "text", max: 40, need: true }, label: { t: "text", max: 60 } } }, say: "the moments that matter: a line at that x label (a scatter's, at that number), with what happened ('a41c9e deployed')" },
    },
    about: "Up to 4 series read well.",
    // A series with no name is the next number's; a point given as [x, y] or [x, y, label] is { x, y, label }.
    pre: (d) => (Array.isArray(d.series) ? { ...d, series: d.series.map((s, i) => (isObj(s) ? { ...s, ...(s.name == null ? { name: `Series ${i + 1}` } : {}), ...(Array.isArray(s.points) ? { points: s.points.map(pointOf) } : {}) } : s)) } : d),
    // A scatter's series are its points; the others', values for each x.
    post: (d, out, at) => {
      const kind = d.kind || "line";
      (d.series || []).forEach((s, i) => {
        if (kind === "scatter" && !s.points?.length) out.errors.push(`${at}.series[${i}].points is missing: a scatter's series are points, [[x, y], ..].`);
        if (kind !== "scatter" && !s.values) out.errors.push(`${at}.series[${i}].values is missing: one for each x (points are a scatter's).`);
      });
      return { ...d, kind };
    },
  },
  table: {
    name: "A table",
    width: "half",
    fields: {
      columns: { t: "list", of: { t: "text", max: 80 }, need: true, shape: "[..]" },
      rows: { t: "list", of: { t: "list", of: { t: "cell" } }, max: 500, need: true, shape: "[[..], ..] or [{col: val}, ..]" },
    },
    about: `A cell can be ${statusShape} or { meter: 0-100 }.`,
    // Rows as arrays, in the order of its columns: rows given as objects are read by column name, and without
    // columns, the first such row's names are its columns.
    pre: (d) => {
      if (!Array.isArray(d.rows)) return d;
      const cols = Array.isArray(d.columns) && d.columns.length ? d.columns : Object.keys(d.rows.find(isObj) || {});
      return { ...d, columns: d.columns ?? cols, rows: d.rows.map((r) => (Array.isArray(r) ? (cols.length ? r.slice(0, cols.length) : r) : isObj(r) ? cols.map((c) => r[c] ?? "") : [r])) };
    },
  },
  list: {
    name: "A list",
    width: "third",
    fields: {
      items: {
        t: "list",
        max: 300,
        need: true,
        of: {
          t: "obj",
          short: "text",
          more: true, // a filter can match on any field of an item (a date, a service)
          fields: {
            text: { t: "text", max: 500, need: true },
            sub: { t: "text", say: "a line under it" },
            status: { t: "one", of: STATUS },
            label: { t: "text", say: "beside its status" },
            link: { t: "url" },
            ask: { t: "one", of: ["ok"] },
            ok: { t: "bool", hide: true },
            ok_by: { t: "text", hide: true },
            ok_at: { t: "text", hide: true },
            done: { t: "bool", hide: true },
          },
        },
      },
      check: { t: "bool", hide: true }, // a checklist, which is the person's tasks (pages.mjs)
    },
    about: `: things to read, not to do. ask: 'ok' on an item asks the person's OK for it ("Add IndexNow"): they answer OK or Not now on the page (ok: true or false), and the answer comes to this thread as their message.`,
  },
  tasks: {
    name: "Tasks",
    width: "half",
    follows: false,
    fields: {
      items: {
        t: "list",
        max: 100,
        of: {
          t: "obj",
          short: "text",
          // sub (a checklist item's line under it) and body are its note too (pages.mjs taskItems).
          fields: { text: { t: "text", need: true }, note: { t: "text", max: BODY_MAX }, for: { t: "text" }, done: { t: "bool" }, id: { t: "text" }, sub: { t: "text", hide: true }, body: { t: "text", hide: true } },
        },
      },
    },
    about: `: what needs doing, each a title (text, under 80 characters; a longer one is cut and the rest goes on top of its note) and a body (note). Never a checklist of your own: each item is one of the person's tasks, on their Tasks list and on this page, ticked there or here alike. for: "me" when you'll do it, else it's theirs. Writing it again updates the task with that id, or one on the page that looks the same, instead of adding another; done: true ticks it. ab_page_read lists them with their ids, and ab_tasks ticks them too.`,
  },
  note: {
    name: "A note",
    width: "third",
    fields: { text: { t: "text" } },
    about: ": short markdown: headings, **bold**, lists, [links](https://..), ![images](https://.. or a local image path, uploaded for you).",
  },
  doc: {
    name: "Text",
    width: "two-thirds",
    fields: { text: { t: "text" } },
    about: ": long markdown (a draft, a spec), with images as in a note.",
  },
  link: {
    name: "A link",
    width: "third",
    fields: { url: { t: "url", need: true }, title: { t: "text" }, text: { t: "text" } },
  },
  options: {
    name: "Options",
    width: "full",
    fields: {
      items: {
        t: "list",
        max: 12,
        need: true,
        of: {
          t: "obj",
          short: "name",
          fields: {
            name: { t: "text", max: 120, need: true },
            text: { t: "text" },
            pros: { t: "list", of: { t: "text" } },
            cons: { t: "list", of: { t: "text" } },
            image: { t: "url", say: "a picture of it" },
            pick: { t: "bool" },
            chosen: { t: "bool", hide: true },
          },
        },
      },
    },
    about: ": choices side by side; pick is your recommendation. The person picks one on the page (chosen), and their pick comes to this thread as their message.",
  },
  diagram: {
    name: "A diagram",
    width: "full",
    follows: false,
    fields: {
      nodes: { t: "list", max: 30, need: true, of: { t: "obj", short: "title", fields: { id: { t: "text", max: 40 }, title: { t: "text", max: 60, need: true }, text: { t: "text", max: 120, say: "a line under it" }, state: { t: "one", of: NODE_STATES } } } },
      edges: { t: "list", max: 60, of: { t: "obj", fields: { from: { t: "text", need: true }, to: { t: "text", need: true }, label: { t: "text", max: 40 } } } },
    },
    about: ": boxes and arrows, which agentbook lays out in columns, left to right along the arrows: how something works, a cause chain, a pipeline. Edges name nodes by id (a node without one goes by its title). state: 'on' lights a box (where it broke, what matters), 'done' ticks it, 'failed' marks it red, 'off' greys it.",
    post: diagramPost,
  },
  html: {
    name: "A widget of its own",
    width: "half",
    follows: false,
    fields: {
      html: { t: "text", max: WIDGET_MAX, need: true },
      css: { t: "text", max: WIDGET_MAX },
      js: { t: "text", max: WIDGET_MAX },
      data: { t: "any" },
      height: { t: "num" },
    },
    about: `: a widget of your own, for what the others can't show (a calculator, a what-if, a diagram, a mockup). It runs sandboxed with no network: no fetch, no outside scripts, pictures or links that load; draw with HTML, SVG or canvas. It has no forms: a form's submit never fires, so act on a button's click. agentbook's colors (--ink, --ink-2, --ink-3, --line, --well, --c1..--c8), font, buttons, fields and tables are already styled. Your js reads agentbook.data (a routine can refresh data alone); agentbook.ask(text) fills the page's "Ask for a change" box for the person to send, agentbook.open(url) opens a web page, both only from a click. Label sample numbers, check inputs, put strings in with textContent. Its js also gets agentbook.filters and agentbook.widgets (the page's others, their data), agentbook.on(fn) when they change, and agentbook.filter(id, value) to narrow the page from a click. Prefer the built-in widgets when they fit.`,
    // Its code, empty if it has none, and how tall it starts, before it says how tall it is.
    post: (d) => {
      const { height, ...rest } = d;
      for (const k of ["html", "css", "js"]) rest[k] ??= "";
      const h = Math.round(height);
      return h > 0 ? { ...rest, height: Math.min(Math.max(h, 40), 1600) } : rest;
    },
  },
  filter: {
    name: "A filter",
    width: "full",
    follows: false,
    fields: {
      values: { t: "list", of: { t: "text", max: 80 }, max: 60, shape: "[..]" },
      all: { t: "text", max: 60, say: "'All services'" },
      kind: { t: "one", of: ["time"], say: "for a time filter, below" },
    },
    about: `: a row of choices that narrows the page for whoever's looking (in their address, not a version). Its id is the filter's. Other widgets follow it with data.match { <filter id>: where the value is: a table's column, "series" for a chart's lines, a list item's field } or data.per { <filter id>: { <value>: data shown for it } } (a number for one service). One that follows neither says it shows all; keep per up to date when you refresh the number. A time filter: data { kind: 'time', values?: ['24h', '7d', '30d', '90d'] }, periods back from when you look; widgets follow it with match on their dates (a chart's "x", a table's date column, a list item's date field), given as 2026-10-03 or 2026-10-03T14:00, and per for numbers (uptime per period).`,
    // Its values once each. A time filter's are periods, and without any, the last 24 hours, 7, 30 and 90 days.
    post: (d, out, at) => {
      const values = [...new Set((d.values || []).map((v) => String(v).trim()).filter(Boolean))];
      if (d.kind !== "time") return { ...d, values };
      const periods = values.filter((v) => PERIOD.test(v));
      const not = values.filter((v) => !PERIOD.test(v));
      if (not.length) out.notes.push(`left out ${not.map(shown).join(", ")} from ${at}.values: a time filter's values are periods, like 24h, 7d or 2w.`);
      return { ...d, values: periods.length ? periods.slice(0, 8) : ["24h", "7d", "30d", "90d"] };
    },
  },
};
export const TYPES = Object.keys(WIDGETS);

// A diagram's nodes each with an id (its title, when it has none; made unique), and only the edges between two of
// them, once each.
function diagramPost(d, out, at) {
  const ids = new Set();
  const nodes = (d.nodes || []).map((n) => {
    let id = String(n.id ?? n.title).trim().slice(0, 40) || "node";
    for (let k = 2; ids.has(id); k++) id = `${String(n.id ?? n.title).trim().slice(0, 36)} ${k}`;
    ids.add(id);
    return { ...n, id };
  });
  const byTitle = new Map(nodes.map((n) => [String(n.title), n.id]));
  const idOf = (v) => (ids.has(String(v)) ? String(v) : byTitle.get(String(v)) ?? null);
  const seen = new Set();
  const edges = [];
  const lost = [];
  for (const e of d.edges || []) {
    const from = idOf(e.from);
    const to = idOf(e.to);
    if (!from || !to || from === to) {
      lost.push(`${shown(e.from)} → ${shown(e.to)}`);
      continue;
    }
    if (seen.has(`${from}\n${to}`)) continue;
    seen.add(`${from}\n${to}`);
    edges.push({ from, to, ...(e.label != null && String(e.label).trim() ? { label: String(e.label).trim() } : {}) });
  }
  if (lost.length) out.notes.push(`left out ${at}.edges ${lost.slice(0, 4).join(", ")}${lost.length > 4 ? "…" : ""}: each edge goes from one node to another, by id or title.`);
  return { nodes, edges };
}

/* ---------- what agents read ---------- */

function fieldDoc(name, f) {
  const shape = f.shape ?? (f.t === "list" && f.of?.t === "obj" ? `[${objDoc(f.of.fields)}]` : f.t === "list" ? "[..]" : f.t === "obj" ? objDoc(f.fields) : "");
  const say = f.t === "one" ? [quoted(f.of), f.say].filter(Boolean).join(", ") : f.say;
  return `${name}${f.need ? "" : "?"}${shape ? `: ${shape}` : ""}${say ? ` (${say})` : ""}`;
}
const objDoc = (fields) => `{ ${Object.entries(fields).filter(([, f]) => !f.hide).map(([n, f]) => fieldDoc(n, f)).join(", ")} }`;

// The description's line for each kind: "- metric: data { value, unit?, … }." and what else to know of it.
export function widgetDocs(types = TYPES) {
  return types
    .map((t) => {
      const about = WIDGETS[t].about || "";
      return `- ${t}: data ${objDoc(WIDGETS[t].fields)}${about.startsWith(":") ? about : `.${about ? ` ${about}` : ""}`}`;
    })
    .join("\n");
}

/* ---------- what they write ---------- */

const shown = (v) => {
  const s = JSON.stringify(v) ?? String(v);
  return s.length > 40 ? `${s.slice(0, 39)}…` : s;
};
const either = (vals) => (vals.length < 2 ? `'${vals[0]}'` : `${vals.slice(0, -1).map((v) => `'${v}'`).join(", ")} or '${vals.at(-1)}'`);
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
// A scatter's point, as [x, y] or [x, y, label] too.
const pointOf = (p) => (Array.isArray(p) ? { x: p[0], y: p[1], ...(p[2] != null ? { label: p[2] } : {}) } : p);
const NUM = (v) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);

// A value checked against its field, and what's kept of it (undefined: nothing). What's wrong goes in out.errors
// and what was cut or left out in out.notes, each saying where it is ("data.series[2].values").
function clean(f, v, at, out) {
  if (v == null) return f.t === "cell" || (f.t === "num" && f.null) ? null : undefined;
  const wrong = (want) => void out.errors.push(`${at} should be ${want}, not ${shown(v)}.`);
  switch (f.t) {
    case "any":
      return v;
    case "text":
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v !== "string") return wrong("text");
      if (!f.max || v.length <= f.max) return v;
      out.notes.push(`cut ${at} to ${f.max} characters.`);
      return v.slice(0, f.max);
    case "num": {
      const n = NUM(v);
      return Number.isFinite(n) ? n : v === "" ? clean(f, null, at, out) : wrong("a number");
    }
    case "bool":
      return typeof v === "boolean" ? v : wrong("true or false");
    case "url":
      return typeof v === "string" && /^https?:\/\/\S/i.test(v.trim()) ? v.trim() : wrong("a web address (https://…)");
    case "one":
      return f.of.includes(v) ? v : wrong(either(f.of));
    case "status":
      if (STATUS.includes(v)) return v;
      if (isObj(v) && STATUS.includes(v.status)) return { status: v.status, ...(v.text != null ? { text: String(v.text) } : {}) };
      return wrong(`${either(STATUS)}, or ${statusShape}`);
    case "cell":
      if (typeof v !== "object") return typeof v === "boolean" ? String(v) : v;
      if (isObj(v) && "meter" in v && Number.isFinite(NUM(v.meter))) return { meter: Math.max(0, Math.min(100, NUM(v.meter))) };
      if (isObj(v) && (v.status == null || STATUS.includes(v.status)) && (v.status != null || v.text != null)) return { ...(v.status ? { status: v.status } : {}), ...(v.text != null ? { text: typeof v.text === "number" ? v.text : String(v.text) } : {}) };
      return wrong(`text, a number, ${statusShape} or { meter: 0-100 }`);
    case "list": {
      if (!Array.isArray(v)) return wrong("a list");
      let list = v;
      if (f.max && list.length > f.max) {
        out.notes.push(`kept the first ${f.max} of the ${list.length} in ${at}.`);
        list = list.slice(0, f.max);
      }
      return list.map((x, i) => clean(f.of, x, `${at}[${i}]`, out)).filter((x) => x !== undefined);
    }
    case "obj":
      if (f.short && (typeof v === "string" || typeof v === "number")) return fields(f, { [f.short]: v }, at, out);
      return isObj(v) ? fields(f, v, at, out) : wrong(objDoc(f.fields));
  }
  return v;
}
// An object's fields, in the order given (so a write that changes nothing stays the same), checked.
function fields(f, v, at, out) {
  const kept = {};
  const other = [];
  for (const [name, x] of Object.entries(v)) {
    if (!Object.hasOwn(f.fields, name)) {
      if (f.more) kept[name] = x;
      else other.push(name);
      continue;
    }
    const c = clean(f.fields[name], x, `${at}.${name}`, out);
    if (c !== undefined) kept[name] = c;
  }
  for (const [name, sub] of Object.entries(f.fields)) if ((typeof sub.need === "function" ? sub.need(v) : sub.need) && v[name] === undefined) out.errors.push(`${at}.${name} is missing.`);
  if (other.length) out.notes.push(`left out ${other.map((k) => `${at}.${k}`).join(", ")}: ${other.length === 1 ? "there's no such field" : "there are no such fields"}.`);
  return kept;
}

// A widget's data, checked against its kind: what's kept of it, with out.errors and out.notes (lists of
// sentences) filled in as clean() does. at: where it is, for them ("data", or a filter value's "data.per.service.api").
export function cleanData(type, data, out, { at = "data" } = {}) {
  const k = WIDGETS[type];
  const d = isObj(data) ? data : {};
  const kept = fields(k, k.pre ? k.pre(d) : d, at, out);
  return k.post ? k.post(kept, out, at) : kept;
}
// Notes as they're told: the same note about each item of a list, once.
export const noteLines = (notes) => [...new Set(notes.map((n) => n.replace(/\[\d+\]/g, "[…]")))];
