// Dashboards: a page (kind "dashboard") whose panels hold queries, not numbers. A panel is a
// widget (a number, a chart, a table, a list) plus its query, in its source's own language, and a shape that says how
// the answer becomes the widget's data. agentbook runs the queries for the range and variables whoever's looking picks,
// through its owner's connectors, keeps each answer a minute or so for everyone, and never saves numbers as versions.
//
// This module is what both sides share: the ranges and the interval a range gets, the variables, checking a panel as
// it's written, and turning a source's frames into a widget's data (shapeAnswer). Running a query is the server's
// (server/dashboards.mjs), each source's language its connector's (server/integrations/connectors/*.mjs).
//
// A source answers in frames:
//   a time series   { name, labels: { service: "core-api" }, unit, time: [ms, …], values: [n | null, …] }
//   a table         { columns: ["resource_name", "p95"], rows: [["GET /cart", 412], …], units?: { p95: "ms" } }
//   one value       { name, value, unit }

import { STATUS, WIDGETS, WIDTHS } from "./widgets.mjs";

export const PANEL_TYPES = ["metric", "chart", "table", "list"];
// What else a dashboard may hold: words about it, written as on any page.
export const PLAIN_TYPES = ["note", "doc", "link"];
export const RANGES = ["15m", "1h", "4h", "12h", "24h", "2d", "7d", "30d", "90d"];
export const DEFAULT_RANGE = "24h";
export const POINTS = 100; // about how many points a chart draws: 15 min for 24 hours, 2 h for 7 days
// The steps an interval is rounded up to: 15 s, 1, 5, 15, 30 min, 1, 2, 6, 12 h, a day.
export const STEPS = [15e3, 60e3, 300e3, 900e3, 1800e3, 3600e3, 7200e3, 21600e3, 43200e3, 86400e3];
const UNIT_MS = { m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 };
const SPAN_MAX = 400 * 86400e3;
export const VARS_MAX = 8;
export const VALUES_MAX = 100;
const QUERY_MAX = 4000;
const VAR_ID = /^[a-z][a-z0-9_]{0,29}$/;
// Built in: filled for whoever's looking, never a dashboard's own.
export const BUILT_IN = ["from", "to", "interval"];
// All of a variable's values: "*".
export const ALL = "*";

const str = (v, max) => (v == null ? "" : String(v).slice(0, max));
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

/* ---------- ranges and intervals ---------- */

// A relative range ("24h") counts back from now; an absolute one is from and to (ms, or anything Date reads).
export const relative = (v) => typeof v === "string" && /^[1-9]\d{0,3}[mhdw]$/.test(v);
const spanOf = (v) => Number(v.slice(0, -1)) * UNIT_MS[v.slice(-1)];

// The range a view asks for: { from, to } in ms, `rel` its relative name ("24h") when it counts back from now, and
// `past` when it ends before now. Throws with what's wrong.
export function rangeOf(view = {}, now = Date.now()) {
  const range = view.range ?? (view.from == null && view.to == null ? DEFAULT_RANGE : null);
  if (range != null) {
    if (!relative(range)) throw new Error(`A range is like ${RANGES.slice(0, 5).join(", ")}, not ${JSON.stringify(range)}.`);
    const span = Math.min(spanOf(range), SPAN_MAX);
    return { from: now - span, to: now, rel: range, past: false };
  }
  const at = (v) => (typeof v === "number" ? v : num(v) ?? Date.parse(v));
  const from = at(view.from);
  const to = view.to == null || view.to === "now" ? now : at(view.to);
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw new Error("A range needs from and to as dates or ms.");
  if (to <= from) throw new Error("A range's to comes after its from.");
  if (to - from > SPAN_MAX) throw new Error("A range is at most 400 days.");
  if (to - from < 60e3) throw new Error("A range is at least a minute.");
  return { from, to: Math.min(to, now), rel: null, past: to < now - 60e3 };
}

// The interval a range gets, so a chart draws about 100 points: the range over 100, rounded up to a step (a day's
// multiple past a day).
export function intervalFor(from, to, points = POINTS) {
  const want = (to - from) / points;
  return STEPS.find((s) => s >= want) || Math.ceil(want / 86400e3) * 86400e3;
}

// The range as a query runs it, so two people looking at "the last 24 hours" a few seconds apart ask the same thing:
// its end rounded up to the interval, its start that many intervals before. The source isn't asked past now.
export function roundRange(r, interval) {
  const to = Math.ceil(r.to / interval) * interval;
  const from = to - Math.ceil((r.to - r.from) / interval) * interval;
  return { from, to };
}
// The same length just before: what Compare draws, and a number's change.
export const previous = (r) => ({ from: r.from - (r.to - r.from), to: r.from });

// How long an answer is kept for everyone: a range ending now, its interval, between 30 s and 5 min; one wholly in
// the past, a day.
export const keepFor = (r, interval) => (r.past ? 86400e3 : Math.min(Math.max(interval, 30e3), 300e3));

// "15m", "1h", "1d": an interval in a query's own words.
export function intervalText(ms) {
  if (ms % 86400e3 === 0) return `${ms / 86400e3}d`;
  if (ms % 3600e3 === 0) return `${ms / 3600e3}h`;
  if (ms % 60e3 === 0) return `${ms / 60e3}m`;
  return `${Math.round(ms / 1000)}s`;
}
// "Last 24 hours".
export function rangeLabel(v) {
  if (!relative(v)) return "Custom range";
  const n = Number(v.slice(0, -1));
  const unit = { m: "minute", h: "hour", d: "day", w: "week" }[v.slice(-1)];
  return n === 1 ? `Last ${unit}` : `Last ${n} ${unit}s`;
}

/* ---------- variables ---------- */

// A dashboard's variables, as written: [{ id, label?, values: [..], default?, multi?, all? }]. `all` (on unless it's
// false) offers "All" ("*"). Throws with what's wrong.
export function varsFrom(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new Error("vars is a list: [{ id, label, values, default }].");
  if (list.length > VARS_MAX) throw new Error(`A dashboard has up to ${VARS_MAX} variables.`);
  const seen = new Set();
  return list.map((v, i) => {
    if (!isObj(v)) throw new Error(`vars[${i}] is an object: { id, label, values, default }.`);
    const id = str(v.id, 40).trim().replace(/^\$/, "");
    if (!VAR_ID.test(id)) throw new Error(`vars[${i}].id is lower case letters, digits and _ ("env", "service"), not ${JSON.stringify(v.id)}.`);
    if (BUILT_IN.includes(id)) throw new Error(`$${id} is built in: give the variable another id.`);
    if (seen.has(id)) throw new Error(`Two variables are called ${id}.`);
    seen.add(id);
    const values = Array.isArray(v.values) ? [...new Set(v.values.map((x) => str(x, 80).trim()).filter(Boolean))].slice(0, VALUES_MAX) : [];
    if (!values.length) throw new Error(`Variable "${id}" needs values to pick from.`);
    const all = v.all !== false;
    const multi = !!v.multi;
    let dflt = v.default == null ? (all ? ALL : values[0]) : v.default;
    dflt = Array.isArray(dflt) ? dflt.map((x) => str(x, 80)) : str(dflt, 80);
    const fine = (x) => values.includes(x) || (all && x === ALL);
    if (Array.isArray(dflt) ? !multi || !dflt.every(fine) : !fine(dflt)) throw new Error(`Variable "${id}"'s default is one of its values${all ? ' or "*"' : ""}.`);
    return { id, label: str(v.label, 40).trim() || id[0].toUpperCase() + id.slice(1), values, default: dflt, ...(multi ? { multi } : {}), ...(all ? {} : { all: false }) };
  });
}

// What's picked, as the queries get it: each variable's value(s), from what the view says or its default. A value
// that isn't one of its values is its default.
export function picked(vars, asked = {}) {
  const out = {};
  for (const v of vars) {
    let x = asked?.[v.id];
    if (typeof x === "string" && v.multi && x.includes(",")) x = x.split(",");
    const fine = (y) => typeof y === "string" && (v.values.includes(y) || (v.all !== false && y === ALL));
    if (Array.isArray(x)) {
      x = v.multi ? [...new Set(x.filter(fine))] : x.find(fine);
      if (Array.isArray(x) && (!x.length || x.includes(ALL))) x = x.includes(ALL) ? ALL : null;
      if (Array.isArray(x) && x.length === 1) x = x[0];
    }
    out[v.id] = fine(x) || Array.isArray(x) ? x : v.default;
  }
  return out;
}

// The $names a query uses, in order, once each: $env, ${service}.
export function varsIn(text) {
  const out = [];
  for (const m of String(text || "").matchAll(/\$\{?([a-z][a-z0-9_]*)\}?/g)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}
// A query's text with its variables filled in. `put(name, value, at)` says how a value goes into this source's
// language at that spot (`at`: the text just before it, so a tag knows it's a tag); `ctx` the built-in ones' values.
// Throws on a $name the dashboard doesn't have.
export function fillVars(text, values, put, ctx = {}) {
  return String(text || "").replace(/\$\{?([a-z][a-z0-9_]*)\}?/g, (m, name, offset, all) => {
    if (BUILT_IN.includes(name)) return put(name, ctx[name], all.slice(0, offset), true);
    if (!(name in values)) throw new Error(`The query uses $${name}, which isn't one of the dashboard's variables (${Object.keys(values).map((k) => `$${k}`).join(", ") || "it has none"}).`);
    return put(name, values[name], all.slice(0, offset), false);
  });
}

/* ---------- panels, as written ---------- */

// The shapes, field by field: what each widget type takes, and what it's for (for the tool's description).
export const SHAPES = {
  metric: {
    reduce: { of: ["last", "avg", "sum", "max", "min"], say: "how a series becomes one number: last by default" },
    unit: { t: "text" },
    decimals: { t: "num", say: "digits after the point" },
    compare: { of: ["previous"], say: "the change against the period before" },
    good: { of: ["up", "down"], say: "which way is good" },
    spark: { t: "bool", say: "a sparkline under it, on by default for a series" },
  },
  chart: {
    kind: { of: ["line", "bar", "stacked"], say: "line by default" },
    series: { t: "text", say: "where each line's name comes from: 'labels.service', or 'name' (the default: the query's name, else its labels)" },
    unit: { t: "text" },
    top: { t: "num", say: "the most lines it draws, the biggest first (8 at most)" },
  },
  table: {
    columns: { t: "obj", say: "{ source column: 'Its name here' }, in the order to show them; others are left out" },
    sort: { t: "text", say: "a column, '-p95' for biggest first" },
    limit: { t: "num", say: "rows shown, 20 by default" },
    units: { t: "obj", say: "{ column: 'ms' }" },
  },
  list: {
    text: { t: "text", say: "the column each item's text comes from: 'name' by default" },
    sub: { t: "text", say: "a column for the line under it" },
    status: { t: "text", say: `a column of ${STATUS.join("/")} (a connector says its states so)` },
    label: { t: "text", say: "a column shown beside its status" },
    link: { t: "text", say: "a column of web addresses" },
    limit: { t: "num", say: "items shown, 20 by default" },
  },
};
// A query, as written: { source, lang, text } and what its language takes besides (a connector says, as `fields`).
export const QUERY_FIELDS = { source: 60, lang: 30, text: QUERY_MAX, formula: 400, compute: 200, by: 200, limit: 10, name: 60, sort: 60 };

function queryFrom(q, at, errors) {
  if (!isObj(q)) {
    errors.push(`${at} is { source, lang, text }: the connector (its id, like "datadog"), its query language, and the query.`);
    return null;
  }
  const out = {};
  for (const [k, max] of Object.entries(QUERY_FIELDS)) if (q[k] != null && q[k] !== "") out[k] = k === "limit" ? num(q[k]) : str(q[k], max);
  // Several queries a formula combines: { a: "…", b: "…" }.
  if (isObj(q.queries)) {
    const named = Object.entries(q.queries).filter(([k, v]) => /^[a-z][a-z0-9_]{0,19}$/.test(k) && typeof v === "string" && v.trim()).slice(0, 8);
    if (named.length) out.queries = Object.fromEntries(named.map(([k, v]) => [k, str(v, QUERY_MAX)]));
  }
  if (!out.source) errors.push(`${at}.source is missing: the connector it asks, by its id ("datadog") from ab_source.`);
  if (!out.lang) errors.push(`${at}.lang is missing: the connector's query language ("metrics", "spans", "monitors", "events" for Datadog).`);
  if (!out.text && !out.queries) errors.push(`${at}.text is missing: the query, in the source's own language.`);
  if (out.limit != null && !(out.limit >= 1 && out.limit <= 1000)) errors.push(`${at}.limit is 1 to 1000.`);
  return out;
}
function shapeFrom(type, s, notes) {
  const fields = SHAPES[type];
  if (s == null) return {};
  if (!isObj(s)) throw new Error("shape is an object.");
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    const f = fields[k];
    if (!f) {
      notes.push(`left out shape.${k}: a ${type}'s shape takes ${Object.keys(fields).join(", ")}.`);
      continue;
    }
    if (f.of) {
      if (!f.of.includes(v)) throw new Error(`shape.${k} is one of ${f.of.join(", ")}.`);
      out[k] = v;
    } else if (f.t === "num") {
      if (num(v) == null) throw new Error(`shape.${k} is a number.`);
      out[k] = num(v);
    } else if (f.t === "bool") out[k] = !!v;
    else if (f.t === "obj") {
      if (!isObj(v)) throw new Error(`shape.${k} is an object: ${f.say}.`);
      out[k] = Object.fromEntries(Object.entries(v).slice(0, 30).map(([a, b]) => [str(a, 80), str(b, 80)]));
    } else out[k] = str(v, 120);
  }
  if (out.top != null) out.top = Math.min(Math.max(Math.round(out.top), 1), 8);
  if (out.limit != null) out.limit = Math.min(Math.max(Math.round(out.limit), 1), 200);
  return out;
}
// A panel's thresholds: { warn, bad }. Higher is worse, unless bad is below warn (a conversion rate).
function thresholdsFrom(t) {
  if (t == null) return null;
  if (!isObj(t)) throw new Error("thresholds is { warn, bad }.");
  const warn = num(t.warn);
  const bad = num(t.bad);
  if (warn == null && bad == null) throw new Error("thresholds needs warn, bad or both, as numbers.");
  return { ...(warn != null ? { warn } : {}), ...(bad != null ? { bad } : {}) };
}

// A panel as an agent writes it, merged over the one it updates (its query, shape and thresholds are replaced
// whole when given). It never has numbers: `data` is refused. A dashboard's plain widgets (a note, a doc, a link)
// are checked as a page's are, by `plain`. Throws with what's wrong; adds to `notes` what was left out.
export function panelFrom(input, prev = null, notes = [], plain = null) {
  if (!isObj(input)) throw new Error("Each panel is an object: { id, type, title, query, shape }.");
  const id = str(input.id, 60).trim();
  if (!id) throw new Error("Each panel needs an id, so a later write can update it.");
  const type = input.type || prev?.type;
  if (PLAIN_TYPES.includes(type)) {
    if (!plain) throw new Error(`Panel "${id}": a ${type} is written as on a page.`);
    return plain(input, prev?.type === type ? prev : null);
  }
  if (!PANEL_TYPES.includes(type)) throw new Error(`Panel "${id}": type is one of ${[...PANEL_TYPES, ...PLAIN_TYPES].join(", ")}.`);
  const errors = [];
  if (input.data != null && !(isObj(input.data) && !Object.keys(input.data).length)) errors.push("a panel's numbers come from its query; give it one (query), not data.");
  if (input.width != null && !WIDTHS[input.width]) errors.push(`width is one of ${Object.keys(WIDTHS).join(", ")}, not ${JSON.stringify(input.width)}.`);
  const same = prev && prev.type === type;
  const query = input.query != null ? queryFrom(input.query, "query", errors) : same ? prev.query : (errors.push("it needs a query: { source, lang, text }."), null);
  let shape = {};
  let thresholds = null;
  let markers = null;
  const local = [];
  try {
    shape = input.shape !== undefined ? shapeFrom(type, input.shape, local) : same ? prev.shape || {} : {};
    thresholds = input.thresholds !== undefined ? thresholdsFrom(input.thresholds) : same ? prev.thresholds || null : null;
  } catch (e) {
    errors.push(e.message);
  }
  if (input.markers !== undefined) markers = input.markers === null ? null : type === "chart" ? queryFrom(input.markers, "markers", errors) : (errors.push("markers are a chart's."), null);
  else if (same) markers = prev.markers || null;
  if (errors.length) throw new Error(errors.map((e) => `Panel "${id}": ${e}`).join("\n"));
  notes.push(...local.map((n) => `Panel "${id}": ${n}`));
  const width = WIDTHS[input.width] ? input.width : same && prev.width ? prev.width : WIDGETS[type].width;
  const stack = input.stack === null ? null : input.stack ? str(input.stack, 40) : same ? prev.stack || null : null;
  return { id, type, title: input.title != null ? str(input.title, 120) : prev?.title || "", width, stack, data: {}, query, shape, ...(thresholds ? { thresholds } : {}), ...(markers ? { markers } : {}) };
}
export const isPanel = (w) => !!w?.query && PANEL_TYPES.includes(w.type);

// A dashboard's own settings, as written: its variables and the range it opens on.
export function dashFrom(input, prev = null) {
  const out = { vars: prev?.vars || [], range: prev?.range || DEFAULT_RANGE };
  if (input.vars !== undefined) out.vars = varsFrom(input.vars);
  if (input.range !== undefined) {
    if (!relative(input.range)) throw new Error(`range is the one it opens on, like ${RANGES.slice(0, 6).join(", ")}.`);
    out.range = input.range;
  }
  return out;
}

/* ---------- an answer, as a widget's data ---------- */

const REDUCE = {
  last: (vs) => [...vs].reverse().find((v) => v != null) ?? null,
  avg: (vs) => (vs.some((v) => v != null) ? vs.reduce((a, v) => a + (v ?? 0), 0) / vs.filter((v) => v != null).length : null),
  sum: (vs) => (vs.some((v) => v != null) ? vs.reduce((a, v) => a + (v ?? 0), 0) : null),
  max: (vs) => (vs.some((v) => v != null) ? Math.max(...vs.filter((v) => v != null)) : null),
  min: (vs) => (vs.some((v) => v != null) ? Math.min(...vs.filter((v) => v != null)) : null),
};
const isSeries = (f) => Array.isArray(f?.time) && Array.isArray(f?.values);
const isTable = (f) => Array.isArray(f?.columns) && Array.isArray(f?.rows);
// A number as it's shown: 1,234 and 12.3 and 0.042.
export function numText(v, decimals = null) {
  if (v == null || !Number.isFinite(v)) return "–";
  if (decimals != null) return v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const a = Math.abs(v);
  const d = a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3;
  return Number(v.toFixed(d)).toLocaleString("en-US", { maximumFractionDigits: d });
}
// Where a panel stands against its thresholds: ok, warn or bad (null without any).
export function standing(v, t) {
  if (!t || v == null) return null;
  const down = t.warn != null && t.bad != null && t.bad < t.warn;
  const past = (x) => x != null && (down ? v <= x : v >= x);
  return past(t.bad) ? "bad" : past(t.warn) ? "warn" : "ok";
}
const nameOf = (f, by) => {
  if (by && by !== "name") {
    const k = by.replace(/^labels\./, "");
    return str(f.labels?.[k] ?? f.name ?? "", 60) || "–";
  }
  const labels = Object.values(f.labels || {}).filter(Boolean);
  return str(f.name || labels.join(", ") || "Series", 60);
};
// Several series as one, added time by time: a number made of all of them.
function summed(frames) {
  const times = [...new Set(frames.flatMap((f) => f.time))].sort((a, b) => a - b);
  const at = frames.map((f) => new Map(f.time.map((t, i) => [t, f.values[i]])));
  return { time: times, values: times.map((t) => (at.some((m) => m.get(t) != null) ? at.reduce((a, m) => a + (m.get(t) ?? 0), 0) : null)), unit: frames[0]?.unit };
}

// A panel's answer as its widget's data. `frames`: what its query answered; `before`: the same query for the period
// before (Compare, a number's change), `shift` ms earlier; `marks`: its markers' answer ([{ time, label }]). A chart's x is its times, as
// ISO dates (`times` keeps them in ms): the page writes them in its viewer's time. Notes what it left out.
export function shapeAnswer(panel, frames, { before = null, shift = 0, marks = null, notes = [] } = {}) {
  const s = panel.shape || {};
  const list = Array.isArray(frames) ? frames : [];
  if (panel.type === "metric") {
    const series = list.filter(isSeries);
    const one = list.find((f) => f && f.value !== undefined && !isSeries(f));
    const reduce = REDUCE[s.reduce || "last"];
    let value = null;
    let unit = s.unit ?? null;
    let spark = null;
    if (series.length) {
      const all = series.length > 1 ? summed(series) : series[0];
      if (series.length > 1) notes.push(`${series.length} series added together into one number.`);
      value = reduce(all.values);
      unit ??= all.unit ?? null;
      if (s.spark !== false) spark = all.values.slice(-120);
    } else if (one) {
      value = num(one.value);
      unit ??= one.unit ?? null;
    } else if (list.some(isTable)) {
      const t = list.find(isTable);
      value = num(t.rows?.[0]?.[t.columns.length - 1]);
    }
    const out = { value: numText(value, s.decimals ?? null), ...(unit ? { unit } : {}), ...(spark?.some((v) => v != null) ? { series: spark } : {}) };
    if (s.good) out.good = s.good;
    const was = before ? shapeAnswer({ ...panel, shape: { ...s, compare: undefined } }, before).raw : null;
    if (s.compare === "previous" && value != null && was != null && was !== 0) {
      const pct = ((value - was) / Math.abs(was)) * 100;
      out.change = `${pct >= 0 ? "+" : "−"}${Math.abs(pct) >= 10 ? Math.round(Math.abs(pct)) : Math.abs(pct).toFixed(1)}%`;
      out.vs = "vs the period before";
    }
    const st = standing(value, panel.thresholds);
    if (st) out.status = st;
    return Object.defineProperty(out, "raw", { value, enumerable: false });
  }
  if (panel.type === "chart") {
    const series = list.filter(isSeries);
    const times = [...new Set(series.flatMap((f) => f.time))].sort((a, b) => a - b).slice(-400);
    const top = s.top || 8;
    const ranked = series.map((f) => ({ f, size: f.values.reduce((a, v) => a + Math.abs(v ?? 0), 0) })).sort((a, b) => b.size - a.size);
    if (ranked.length > top) notes.push(`${top} of ${ranked.length} series drawn, the biggest.`);
    const line = (f) => {
      const at = new Map(f.time.map((t, i) => [t, f.values[i]]));
      return times.map((t) => (at.get(t) == null ? null : num(at.get(t))));
    };
    const out = { kind: s.kind || "line", x: times.map((t) => new Date(t).toISOString()), times, series: ranked.slice(0, top).map(({ f }) => ({ name: nameOf(f, s.series), values: line(f) })) };
    const unit = s.unit ?? series[0]?.unit;
    if (unit) out.unit = unit;
    // The period before (`shift` earlier: the range's length, a whole number of intervals), moved onto this one's
    // times: dashed lines, for the series drawn.
    const was = (before || []).filter(isSeries);
    if (was.length && times.length) {
      const names = new Set(out.series.map((x) => x.name));
      const moved = was.filter((f) => names.has(nameOf(f, s.series))).map((f) => ({ ...f, time: f.time.map((t) => t + shift) }));
      for (const f of moved.slice(0, 8 - out.series.length)) out.series.push({ name: `${nameOf(f, s.series)} (before)`, values: line(f), before: true });
    }
    const t = panel.thresholds;
    const mark = t?.bad ?? t?.warn;
    if (mark != null) out.target = { value: mark, label: t.bad != null ? "bad" : "warn" };
    if (t) out.thresholds = t;
    // A marker sits at the time nearest it, if that's on the chart.
    if (marks?.length && times.length) {
      const step = times.length > 1 ? times[1] - times[0] : 0;
      out.markers = marks
        .filter((m) => m.time >= times[0] - step && m.time <= times.at(-1) + step)
        .slice(-6)
        .map((m) => ({ x: new Date(times.reduce((a, t) => (Math.abs(t - m.time) < Math.abs(a - m.time) ? t : a), times[0])).toISOString(), label: str(m.label, 60), at: m.time }));
    }
    return out;
  }
  // A table and a list read a table: a source's own, or one made of its series (each one's name and its last value).
  let t = list.find(isTable);
  if (!t && list.some(isSeries)) {
    const reduce = REDUCE[s.reduce || "last"];
    const labels = [...new Set(list.filter(isSeries).flatMap((f) => Object.keys(f.labels || {})))];
    const cols = labels.length ? labels : ["name"];
    t = { columns: [...cols, "value"], rows: list.filter(isSeries).map((f) => [...cols.map((c) => (labels.length ? f.labels?.[c] ?? "" : nameOf(f))), reduce(f.values)]) };
  }
  if (!t) t = { columns: [], rows: [] };
  let rows = t.rows.map((r) => (Array.isArray(r) ? r : isObj(r) ? t.columns.map((c) => r[c]) : [r]));
  const col = (name) => t.columns.indexOf(name);
  const limit = s.limit || 20;
  if (s.sort) {
    const desc = s.sort.startsWith("-");
    const i = col(s.sort.replace(/^-/, ""));
    if (i < 0) notes.push(`shape.sort: no column "${s.sort.replace(/^-/, "")}" (${t.columns.join(", ")}).`);
    else rows = [...rows].sort((a, b) => ((num(a[i]) ?? -Infinity) - (num(b[i]) ?? -Infinity) || String(a[i]).localeCompare(String(b[i]))) * (desc ? -1 : 1));
  }
  if (rows.length > limit) notes.push(`${limit} of ${rows.length} rows shown.`);
  rows = rows.slice(0, limit);
  if (panel.type === "list") {
    const pick = (r, k) => (k && col(k) >= 0 ? r[col(k)] : null);
    const items = rows.map((r) => {
      const it = { text: str(pick(r, s.text || "name") ?? r[0], 500) };
      const sub = pick(r, s.sub);
      if (sub != null && sub !== "") it.sub = str(sub, 200);
      const st = pick(r, s.status || (col("status") >= 0 ? "status" : null));
      if (STATUS.includes(st)) it.status = st;
      const label = pick(r, s.label);
      if (label != null && label !== "") it.label = str(label, 60);
      const link = pick(r, s.link || (col("link") >= 0 ? "link" : null));
      if (typeof link === "string" && /^https?:\/\//.test(link)) it.link = link;
      return it;
    });
    return { items };
  }
  // A table: its columns as the shape names them (in that order), each number in its unit, and a status cell where
  // the panel's thresholds say.
  const named = s.columns && Object.keys(s.columns).length ? Object.entries(s.columns).filter(([c]) => col(c) >= 0) : t.columns.map((c) => [c, c]);
  if (s.columns) for (const c of Object.keys(s.columns)) if (col(c) < 0) notes.push(`shape.columns: no column "${c}" (${t.columns.join(", ")}).`);
  const units = { ...(t.units || {}), ...(s.units || {}) };
  const numeric = named.map(([c]) => rows.length > 0 && rows.every((r) => r[col(c)] == null || num(r[col(c)]) != null));
  const lastNum = numeric.lastIndexOf(true);
  const cell = (r, [c], j) => {
    const v = r[col(c)];
    if (!numeric[j] || v == null) return v ?? "";
    const text = `${numText(num(v))}${units[c] ? ` ${units[c]}` : ""}`;
    const st = j === lastNum ? standing(num(v), panel.thresholds) : null;
    return st ? { status: st, text } : text;
  };
  return { columns: named.map(([, name]) => name), rows: rows.map((r) => named.map((c, j) => cell(r, c, j))) };
}

// A panel's answer as CSV rows (its widget's data, as shown): for "Copy as CSV".
export function answerRows(type, d) {
  if (type === "metric") return [["value", "unit"], [d.value, d.unit || ""]];
  if (type === "chart") return [["time", ...d.series.map((s) => s.name)], ...d.x.map((x, i) => [x, ...d.series.map((s) => s.values[i] ?? "")])];
  if (type === "table") return [d.columns, ...d.rows.map((r) => r.map((c) => (isObj(c) ? c.text ?? "" : c)))];
  if (type === "list") return [["text", "status", "sub"], ...d.items.map((it) => [it.text, it.status || "", it.sub || ""])];
  return [];
}
