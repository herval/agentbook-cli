// TOON (Token-Oriented Object Notation), read into plain values. Tool servers made for models answer in it
// rather than JSON: acme-litellm's Datadog and GKE tools do. A routine's ctx.tool parses what a tool said
// with this, so a script gets `data` it can index instead of text it has to pick apart.
//
//   window: 3h                                  key: value
//   group_by: null
//   tags[2]: prod,eu                            an array of values on one line
//   timeseries[1]:                              an array of items, one per "- " line
//     - buckets[2]{time,p95_ms,count}:          a table: one row per line, values in the fields' order
//         "2026-10-09T18:00:00Z",89.5,1480
//         "2026-10-09T19:00:00Z",100.9,32387
//   server:                                     an object, its keys one level in
//     name: litellm
//
// Values are null, true, false, numbers, quoted strings (JSON escapes) or bare strings. A header can name another
// delimiter than the comma: [N|] or [N<tab>]. Lenient: a count that doesn't match the lines is read as the lines.

const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;
// A line that starts a field: a key, maybe an array header, and a colon.
const FIELD = /^("(?:[^"\\]|\\.)*"|[^\s"[{:][^[{:]*?)\s*(\[[^\]]*\](?:\{[^}]*\})?)?:(?:\s|$)/;

export function parseToon(src) {
  const lines = String(src ?? "")
    .split(/\r?\n/)
    .map((raw) => ({ ind: raw.length - raw.trimStart().length, t: raw.trim() }))
    .filter((l) => l.t);
  if (!lines.length) return null;
  let i = 0;
  const first = lines[0];
  if (/^\[[^\]]*\](\{[^}]*\})?:/.test(first.t)) {
    i = 1;
    return arrayAfter(header(first.t), first.ind);
  }
  if (lines.length === 1 && !FIELD.test(first.t)) return value(first.t);
  return object(first.ind);

  // Fields at exactly this indent, until a line that isn't one.
  function object(ind) {
    const o = {};
    while (i < lines.length && lines[i].ind === ind && !isItem(lines[i].t)) field(o, lines[i++].t, ind);
    return o;
  }

  // One field's line (already read): its value is on it, or in the deeper lines after it.
  function field(o, t, ind) {
    const m = t.match(FIELD);
    if (!m) {
      o[t] = null; // not a field: keep the text as a key, rather than lose it
      return;
    }
    const key = m[1].startsWith('"') ? JSON.parse(m[1]) : m[1].trim();
    const rest = t.slice(m[0].length).trim();
    if (m[2]) {
      o[key] = arrayAfter({ ...header(m[2] + ":"), after: rest }, ind);
      return;
    }
    if (rest) o[key] = value(rest);
    else if (i < lines.length && lines[i].ind > ind) o[key] = object(lines[i].ind);
    else o[key] = {};
  }

  // An array whose header was just read at `ind`: inline values, a table's rows, or "- " items, deeper in.
  function arrayAfter(h, ind) {
    if (h.fields) {
      const rows = [];
      while (i < lines.length && lines[i].ind > ind && !isItem(lines[i].t)) {
        const cells = split(lines[i++].t, h.delim).map(value);
        rows.push(Object.fromEntries(h.fields.map((f, k) => [f, cells[k] ?? null])));
      }
      return rows;
    }
    if (h.after) return split(h.after, h.delim).map(value);
    const items = [];
    const at = i < lines.length && lines[i].ind > ind ? lines[i].ind : -1;
    while (i < lines.length && lines[i].ind === at && isItem(lines[i].t)) items.push(item(lines[i].ind, lines[i++].t.replace(/^-\s?/, "")));
    return items;
  }

  // One "- " item: a value, an array, or an object whose first field is on the item's line and whose other
  // fields sit where that first field would.
  function item(ind, rest) {
    if (!rest) return {};
    if (/^\[[^\]]*\](\{[^}]*\})?:/.test(rest)) return arrayAfter(header(rest), ind);
    if (!FIELD.test(rest)) return value(rest);
    const o = {};
    field(o, rest, ind + 2);
    while (i < lines.length && lines[i].ind === ind + 2 && !isItem(lines[i].t)) field(o, lines[i++].t, ind + 2);
    return o;
  }
}

const isItem = (t) => t === "-" || t.startsWith("- ");

// "[4]{a,b}: rest" -> { n, delim, fields, after }
function header(t) {
  const m = t.match(/^\[(\d*)([\t|]?)\](?:\{([^}]*)\})?:\s?(.*)$/);
  if (!m) return { n: 0, delim: ",", fields: null, after: "" };
  const delim = m[2] || ",";
  return { n: Number(m[1]) || 0, delim, fields: m[3] != null ? split(m[3], delim).map((f) => (f.startsWith('"') ? JSON.parse(f) : f)) : null, after: m[4].trim() };
}

// Split on the delimiter, outside quotes.
function split(s, delim) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (quoted) {
      cur += c;
      if (c === "\\") cur += s[++k] ?? "";
      else if (c === '"') quoted = false;
    } else if (c === '"') {
      quoted = true;
      cur += c;
    } else if (c === delim) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  out.push(cur.trim());
  return out;
}

function value(s) {
  s = s.trim();
  if (s.startsWith('"') && s.endsWith('"') && s.length > 1) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s === "null") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (NUMBER.test(s)) return Number(s);
  return s;
}

// What a tool said, as data: JSON if it is, else TOON if it reads as some, else null.
export function toolData(text) {
  const t = String(text ?? "").trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {}
  try {
    const v = parseToon(t);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}
