// What a session changed in its files, whichever agent ran it.
//
// Every edit is kept as hunks in the shape of Claude Code's structuredPatch: { oldStart, oldLines, newStart,
// newLines, lines: ["+added", "-removed", " unchanged"] }, with null line numbers when the agent didn't say
// where in the file it was (Hermes and OpenClaw only send the text they replaced). Codex's diffs, git's and
// apply_patch's are parsed into the same shape.
//
// A file's change over a turn or a session is the file before its first edit against the file after its last.
// Agents rarely record both: Claude Code keeps the file as it was only for small files, and the new text only
// for a Write. So each edit is an op that may know the text before it, the text after it, or neither, and the
// texts in between are worked out by applying its hunks forwards or backwards from whatever is known (the file
// on disk now is the last resort). When nothing pins a file down, it shows edit by edit instead.
//
// Pure: both the CLI (which works changes out from transcripts) and the server (which shows them) use it. Reading
// a file on disk is the CLI's (plugin/cli/changes.mjs).

export const CONTEXT = 3; // unchanged lines around each change
const MAX_LINES = 3000; // lines of one diff sent to the page; the rest are counted
const MAX_D = 1500; // past this many differences, the middle of a file is shown as replaced

/* ---------- a post's edits ---------- */

const KEEP_EDITS = 6000; // edits kept per post

// A path as the page shows it: relative to the session's folder, or under ~ when it's elsewhere.
export function relPath(p, cwd = "", home = process.env.HOME || "") {
  p = String(p || "");
  if (cwd && p.startsWith(cwd + "/")) return p.slice(cwd.length + 1);
  if (home && p.startsWith(home + "/")) return "~" + p.slice(home.length);
  return p;
}

// Keep an edit in a post's digest (`d.edits`), and count it on its step (`step.files`, what the step row shows).
// An edit is { abs, kind, add, del, at } plus where to find what it did: `op` itself, or `src` for the
// digest's owner to read back. Its turn is its step's unless it says.
export function noteEdit(d, step, e, cwd) {
  const path = relPath(e.abs, cwd);
  const edit = { ...e, path, step: step?.id ?? null, turn: e.turn ?? step?.turn ?? d.turn };
  (d.edits ||= []).push(edit);
  if (d.edits.length > KEEP_EDITS) d.edits.splice(0, d.edits.length - KEEP_EDITS);
  if (!step) return edit;
  const f = (step.files ||= []).find((x) => x.path === path);
  if (f) Object.assign(f, { add: f.add + e.add, del: f.del + e.del, kind: f.kind === e.kind ? f.kind : "edit" });
  else step.files.push({ path, kind: e.kind, add: e.add, del: e.del });
  return edit;
}

// A shell command that commits, so the commits made while it ran are the session's.
export const COMMITS = /\bgit\b(?:\s+-[cC]\s+\S+)*[^\n|;&]*?\bcommit\b(?![^\n|;&]*--dry-run)/;
// The commit a command's output names: git's "[main 2e5d2fa] subject".
export const shaIn = (out) => String(out || "").match(/^\[[^\]\n]*?\b([0-9a-f]{7,40})\] /m)?.[1] || null;

/* ---------- text as lines ---------- */

// Lines without their newlines, and whether the last one had one.
function toLines(text) {
  const lines = String(text ?? "").split("\n");
  const eol = lines.at(-1) === "";
  if (eol) lines.pop();
  return { lines, eol: eol || !lines.length };
}
const fromLines = (lines, eol) => lines.join("\n") + (eol && lines.length ? "\n" : "");

export function sizeOf(hunks) {
  let add = 0;
  let del = 0;
  for (const h of hunks || []) for (const l of h.lines || []) l[0] === "+" ? add++ : l[0] === "-" && del++;
  return { add, del };
}

// A whole file as one hunk, added (a new file) or removed (a deleted one).
export function wholeFile(text, sign = "+") {
  const { lines } = toLines(text);
  if (!lines.length) return [];
  const n = lines.length;
  const body = lines.map((l) => sign + l);
  return [sign === "+" ? { oldStart: 0, oldLines: 0, newStart: 1, newLines: n, lines: body } : { oldStart: 1, oldLines: n, newStart: 0, newLines: 0, lines: body }];
}

// The first MAX_LINES lines of a diff, and how many more there were.
export function capped(hunks, max = MAX_LINES) {
  const out = [];
  let left = max;
  let more = 0;
  for (const h of hunks || []) {
    if (left <= 0) {
      more += h.lines.length;
      continue;
    }
    if (h.lines.length <= left) out.push(h);
    else {
      out.push({ ...h, lines: h.lines.slice(0, left) });
      more += h.lines.length - left;
    }
    left -= h.lines.length;
  }
  return { hunks: out, more };
}

/* ---------- applying hunks ---------- */

// Where `want` (lines) sits in `lines`: at `at` if it's there, else the nearest place at or after `from`.
function locate(lines, want, at, from) {
  const fits = (i) => {
    if (i < from || i + want.length > lines.length) return false;
    for (let j = 0; j < want.length; j++) if (lines[i + j] !== want[j]) return false;
    return true;
  };
  at = Math.max(from, Math.min(at, lines.length));
  if (!want.length) return at;
  for (let d = 0; at - d >= from || at + d < lines.length; d++) {
    if (fits(at + d)) return at + d;
    if (d && fits(at - d)) return at - d;
  }
  return -1;
}

// Apply a change's hunks to a text, or undo them (`reverse`). Null when they don't fit: the text isn't the
// one the change was made to. Hunks without line numbers are found by their content, in order.
export function applyHunks(text, hunks, reverse = false) {
  const { lines, eol } = toLines(text);
  let shift = 0;
  let from = 0;
  for (const h of hunks || []) {
    const was = [];
    const now = [];
    for (const l of h.lines) {
      const c = l[0] ?? " ";
      if (c === "\\") continue;
      const body = l.slice(1);
      if (c === " " || c === (reverse ? "+" : "-")) was.push(body);
      if (c === " " || c === (reverse ? "-" : "+")) now.push(body);
    }
    const start = reverse ? h.newStart : h.oldStart;
    // git puts a hunk that only adds lines after the line it names; one that touches lines, at its first.
    const at = start == null ? from : was.length ? start - 1 + shift : start + shift;
    const i = locate(lines, was, at, from);
    if (i < 0) return null;
    lines.splice(i, was.length, ...now);
    shift += now.length - was.length;
    from = i + now.length;
  }
  return fromLines(lines, eol);
}

/* ---------- diffing two texts ---------- */

// Myers' diff of two line lists: [" ", line] kept, ["-", line] removed, ["+", line] added.
function myers(a, b) {
  const n = a.length;
  const m = b.length;
  if (!n || !m) return [...a.map((l) => ["-", l]), ...b.map((l) => ["+", l])];
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  let end = -1;
  for (let d = 0; d <= max && end < 0; d++) {
    if (d > MAX_D) return [...a.map((l) => ["-", l]), ...b.map((l) => ["+", l])];
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) x++, y++;
      v[off + k] = x;
      if (x >= n && y >= m) {
        end = d;
        break;
      }
    }
  }
  const ops = [];
  let x = n;
  let y = m;
  for (let d = end; d >= 0; d--) {
    const w = trace[d];
    const at = (k) => w[k + d + 1];
    const k = x - y;
    const pk = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const px = d ? at(pk) : 0;
    const py = d ? px - pk : 0;
    while (x > px && y > py) ops.push([" ", a[--x]]), y--;
    if (d) x === px ? ops.push(["+", b[--y]]) : ops.push(["-", a[--x]]);
  }
  return ops.reverse();
}

// Ops grouped into hunks, each with CONTEXT unchanged lines around its changes. `numbered`: false for changes
// whose place in the file isn't known.
function hunksOf(ops, context = CONTEXT, numbered = true) {
  const oldAt = [];
  const newAt = [];
  let o = 1;
  let nn = 1;
  for (const [c] of ops) {
    oldAt.push(o);
    newAt.push(nn);
    if (c !== "+") o++;
    if (c !== "-") nn++;
  }
  const hunks = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i][0] === " ") {
      i++;
      continue;
    }
    let last = i;
    let j = i;
    while (j < ops.length) {
      if (ops[j][0] !== " ") last = j;
      else if (j - last > 2 * context) break;
      j++;
    }
    const start = Math.max(0, i - context);
    const stop = Math.min(ops.length, last + context + 1);
    const lines = ops.slice(start, stop).map(([c, l]) => c + l);
    const { add, del } = sizeOf([{ lines }]);
    const oldLines = lines.length - add;
    const newLines = lines.length - del;
    hunks.push({
      oldStart: numbered ? (oldLines ? oldAt[start] : oldAt[start] - 1) : null,
      oldLines,
      newStart: numbered ? (newLines ? newAt[start] : newAt[start] - 1) : null,
      newLines,
      lines,
    });
    i = stop;
  }
  return hunks;
}

// The change from one text to another, as hunks. Null for a file that isn't there.
export function diffTexts(before, after, { context = CONTEXT, numbered = true } = {}) {
  const a = before == null ? [] : toLines(before).lines;
  const b = after == null ? [] : toLines(after).lines;
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const mid = myers(a.slice(p, a.length - s), b.slice(p, b.length - s));
  const ops = [...a.slice(Math.max(0, p - context), p).map((l) => [" ", l]), ...mid, ...a.slice(a.length - s, a.length - s + context).map((l) => [" ", l])];
  const skipped = Math.max(0, p - context);
  const hunks = hunksOf(ops, context, numbered);
  if (numbered && skipped) for (const h of hunks) (h.oldStart += skipped), (h.newStart += skipped);
  return hunks;
}

/* ---------- reading other tools' diffs ---------- */

const RANGE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const unquote = (p) => String(p || "").replace(/^"(.*)"$/, "$1");
const side = (p) => {
  p = unquote(p.split("\t")[0].trim());
  return p === "/dev/null" ? null : p.replace(/^[ab]\//, "");
};

// A unified diff (git's, Codex's) as files: { path, from (renamed from), kind, hunks, binary }.
export function parseUnified(text) {
  const files = [];
  let f = null;
  let h = null;
  let left = [0, 0];
  const open = (path = null) => {
    f = { path, from: null, kind: "edit", hunks: [], binary: false };
    files.push(f);
    h = null;
    return f;
  };
  for (const line of String(text || "").split("\n")) {
    if (h && (left[0] > 0 || left[1] > 0)) {
      const c = line[0] ?? " ";
      if (c === "\\") {
        h.lines.push(line);
        continue;
      }
      if (c === " " || c === "-" || c === "+") {
        h.lines.push(c + line.slice(1));
        if (c !== "+") left[0]--;
        if (c !== "-") left[1]--;
        continue;
      }
      if (line === "") {
        h.lines.push(" ");
        left[0]--;
        left[1]--;
        continue;
      }
      h = null;
    }
    let m;
    if (line.startsWith("\\") && f?.hunks.length) f.hunks.at(-1).lines.push(line);
    else if ((m = line.match(/^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/))) open(m[2]);
    else if (/^new file mode/.test(line) && f) f.kind = "create";
    else if (/^deleted file mode/.test(line) && f) f.kind = "delete";
    else if ((m = line.match(/^rename from (.+)$/)) && f) (f.from = unquote(m[1])), (f.kind = "rename");
    else if ((m = line.match(/^rename to (.+)$/)) && f) f.path = unquote(m[1]);
    else if (/^Binary files .* differ$/.test(line) || /^GIT binary patch/.test(line)) (f || open()).binary = true;
    else if (line.startsWith("--- ") && !h) {
      if (!f || f.hunks.length) open();
      const p = side(line.slice(4));
      if (p == null) f.kind = "create";
      else if (!f.path) f.path = p;
    } else if (line.startsWith("+++ ") && !h && f) {
      const p = side(line.slice(4));
      if (p == null) f.kind = "delete";
      else f.path = p;
    } else if ((m = line.match(RANGE))) {
      if (!f) open();
      h = { oldStart: +m[1], oldLines: m[2] == null ? 1 : +m[2], newStart: +m[3], newLines: m[4] == null ? 1 : +m[4], lines: [] };
      left = [h.oldLines, h.newLines];
      f.hunks.push(h);
    }
  }
  return files.filter((x) => x.path || x.hunks.length);
}

// An apply_patch patch (Codex's format, which Hermes and OpenClaw use too) as files. Its chunks say what to
// replace, with a few lines around it, but not where: their hunks have no line numbers.
export function parsePatch(text) {
  const files = [];
  let f = null;
  let h = null;
  for (const line of String(text || "").split("\n")) {
    let m;
    if ((m = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/))) {
      f = { path: m[2].trim(), kind: m[1] === "Add" ? "create" : m[1] === "Delete" ? "delete" : "edit", hunks: [], to: null };
      files.push(f);
      h = null;
    } else if ((m = line.match(/^\*\*\* Move to: (.+)$/)) && f) f.to = m[1].trim();
    else if (/^\*\*\* (Begin|End) Patch|^\*\*\* End of File/.test(line)) h = line.startsWith("*** End of File") ? h : null;
    else if (f && line.startsWith("@@")) h = null;
    else if (f && /^[ +-]/.test(line)) {
      if (!h) f.hunks.push((h = { oldStart: null, oldLines: 0, newStart: null, newLines: 0, lines: [] }));
      h.lines.push(line);
      if (line[0] !== "+") h.oldLines++;
      if (line[0] !== "-") h.newLines++;
    }
  }
  for (const x of files) if (x.kind === "create") x.content = x.hunks.flatMap((hh) => hh.lines.map((l) => l.slice(1))).join("\n") + "\n";
  return files;
}

/* ---------- edits as the other agents record them ---------- */

const looksUnified = (t) => /^(?:diff --git |--- |@@ -\d)/m.test(String(t || ""));
const withSize = (e) => ({ ...e, ...sizeOf(shownHunks(e.op)) });
const absOf = (p, cwd) => (!p ? "" : String(p).startsWith("/") ? String(p) : cwd ? `${cwd.replace(/\/$/, "")}/${p}` : String(p));

// A Codex fileChange item's changes: each file's diff (an added file's is its text).
export function codexEdits(item, cwd) {
  return (item.changes || [])
    .map((c) => {
      const kind = typeof c.kind === "string" ? c.kind : c.kind?.type;
      const abs = absOf(c.kind?.move_path || c.path, cwd);
      const text = String(c.diff ?? c.unified_diff ?? c.content ?? "");
      if (kind === "add") return withSize({ abs, kind: "create", op: looksUnified(text) ? { created: true, hunks: parseUnified(text)[0]?.hunks || [] } : { created: true, before: null, after: text } });
      if (kind === "delete") return withSize({ abs, kind: "delete", op: looksUnified(text) ? { deleted: true, hunks: parseUnified(text)[0]?.hunks || [] } : { deleted: true, ...(text ? { before: text } : {}) } });
      const hunks = parseUnified(text)[0]?.hunks || [];
      return withSize({ abs, kind: "edit", op: hunks.length ? { hunks } : { unknown: true } });
    })
    .filter((e) => e.abs);
}

// Hermes's and OpenClaw's edits, from what their tools were asked to do: replace some text, write a file, or
// apply a patch. None of them say where in the file, so their hunks have no line numbers.
const EDIT_TOOLS = /^(?:edit|edit_file|patch|str_replace|str_replace_editor|str_replace_based_edit_tool|replace|replace_in_file|search_replace|multi_edit|multiedit|apply_patch|write|write_file|create_file|file_write)$/;
export function argEdits(name, args, cwd) {
  let a = args;
  if (typeof a === "string") {
    try {
      a = JSON.parse(a);
    } catch {
      a = /\*\*\* Begin Patch/.test(a) ? { patch: a } : {};
    }
  }
  if (!a || typeof a !== "object" || !EDIT_TOOLS.test(String(name || "").toLowerCase())) return [];
  const patch = [a.patch, a.input, a.diff].find((x) => typeof x === "string" && (/\*\*\* (?:Begin Patch|Update File|Add File|Delete File)/.test(x) || looksUnified(x)));
  if (patch) {
    if (/\*\*\* (?:Begin Patch|Update File|Add File|Delete File)/.test(patch))
      return parsePatch(patch).map((f) => withSize({ abs: absOf(f.to || f.path, cwd), kind: f.kind, op: f.kind === "create" ? { created: true, before: null, after: f.content } : f.kind === "delete" ? { deleted: true } : { hunks: f.hunks } }));
    return parseUnified(patch).map((f) => withSize({ abs: absOf(f.path, cwd), kind: f.kind === "rename" ? "edit" : f.kind, op: f.kind === "delete" ? { deleted: true, hunks: f.hunks } : f.kind === "create" ? { created: true, hunks: f.hunks } : { hunks: f.hunks } }));
  }
  const file = absOf(a.path ?? a.file_path ?? a.filePath ?? a.file ?? a.target_file, cwd);
  if (!file) return [];
  const content = a.content ?? a.file_text ?? a.text ?? a.contents;
  if (typeof content === "string" && (a.command === "create" || !("old_string" in a || "oldText" in a || "old_str" in a))) return [withSize({ abs: file, kind: "edit", op: { after: content } })];
  const pairs = Array.isArray(a.edits) ? a.edits : [a];
  return pairs
    .map((e) => ({ old: e.old_string ?? e.oldText ?? e.old_str ?? e.old ?? e.search, new: e.new_string ?? e.newText ?? e.new_str ?? e.new ?? e.replace, all: !!(e.replace_all ?? e.replaceAll) }))
    .filter((r) => typeof r.old === "string" && typeof r.new === "string" && r.old !== r.new)
    .map((r) => withSize({ abs: file, kind: "edit", op: { replace: r } }));
}

/* ---------- one file over many edits ---------- */

// An op is what one edit did to one file, as much as is known:
//   hunks      the change (line numbers may be null)
//   before     the text before it (null: the file wasn't there)
//   after      the text after it (null: it was deleted)
//   replace    { old, new, all }: text it replaced, for tools that say only that
//   created, deleted
//   unknown    something changed the file, but not what
function forward(op, text) {
  if (op.after !== undefined) return op.after;
  if (op.deleted) return null;
  if (op.unknown || text === undefined) return undefined;
  if (op.replace) {
    if (text == null || !op.replace.old || !text.includes(op.replace.old)) return undefined;
    return op.replace.all ? text.split(op.replace.old).join(op.replace.new) : text.replace(op.replace.old, () => op.replace.new);
  }
  if (op.hunks) return applyHunks(text ?? "", op.hunks) ?? undefined;
  return undefined;
}
function backward(op, text) {
  if (op.before !== undefined) return op.before;
  if (op.created) return null;
  if (op.unknown || text === undefined) return undefined;
  if (op.replace) {
    if (text == null || op.replace.all || !op.replace.new || !text.includes(op.replace.new)) return undefined;
    return text.replace(op.replace.new, () => op.replace.old);
  }
  if (op.hunks) return text == null ? undefined : applyHunks(text, op.hunks, true) ?? undefined;
  return undefined;
}

// The file's text before each op and after the last (undefined where it can't be known). `disk`: a function
// giving the file as it is now (null: not there), asked only when nothing else pins the end down.
export function statesOf(ops, disk) {
  const n = ops.length;
  const K = new Array(n + 1).fill(undefined);
  ops.forEach((op, i) => {
    if (op.before !== undefined) K[i] = op.before;
    if (op.after !== undefined) K[i + 1] = op.after;
    else if (op.deleted) K[i + 1] = null;
  });
  const sweep = () => {
    for (let i = 0; i < n; i++) if (K[i] !== undefined && K[i + 1] === undefined) K[i + 1] = forward(ops[i], K[i]);
    for (let i = n - 1; i >= 0; i--) if (K[i + 1] !== undefined && K[i] === undefined) K[i] = backward(ops[i], K[i + 1]);
  };
  sweep();
  sweep();
  if (K.some((k) => k === undefined) && K[n] === undefined && disk) {
    const now = disk();
    if (now !== undefined) {
      K[n] = now;
      sweep();
      sweep();
    }
  }
  return K;
}

// What an edit shows on its own: its hunks, or the text it wrote, or the text it replaced.
export function shownHunks(op) {
  if (op.hunks?.length) return op.hunks;
  if (op.created && typeof op.after === "string") return wholeFile(op.after, "+");
  if (op.deleted && typeof op.before === "string") return wholeFile(op.before, "-");
  if (typeof op.before === "string" && typeof op.after === "string") return diffTexts(op.before, op.after);
  if (op.replace) return diffTexts(op.replace.old, op.replace.new, { numbered: false });
  if (typeof op.after === "string") return wholeFile(op.after, "+");
  return [];
}

// One file's change over ops[from..to): { kind, hunks, exact, outside }. `exact`: it's the file before
// against the file after; otherwise its edits one after another. `outside`: something besides these edits
// changed the file between them, so the diff includes that too.
export function fileChange(ops, K, from = 0, to = ops.length) {
  const before = K[from];
  const after = K[to];
  const kinds = ops.slice(from, to);
  if (before !== undefined && after !== undefined) {
    if (before == null && after == null) return { kind: "gone", hunks: [], exact: true, outside: false };
    let outside = false;
    for (let i = from; i < to; i++) {
      const fw = K[i] === undefined ? undefined : forward(ops[i], K[i]);
      if (fw !== undefined && K[i + 1] !== undefined && fw !== K[i + 1]) outside = true;
    }
    const kind = before == null ? "create" : after == null ? "delete" : "edit";
    return { kind, hunks: before === after ? [] : diffTexts(before, after), exact: true, outside };
  }
  const kind = kinds[0]?.created ? "create" : kinds.at(-1)?.deleted ? "delete" : "edit";
  return { kind, hunks: kinds.flatMap(shownHunks), exact: false, outside: false };
}

/* ---------- a post's changes ---------- */

const under = (abs, dir) => !!dir && (abs === dir || abs.startsWith(dir + "/"));
// A file in the session's folder (or its repo), as opposed to one elsewhere, like Claude's memory.
export const ownFile = (abs, s) => under(abs, s.cwd) || under(abs, s.root);
export const filesChanged = (edits, s) => new Set((edits || []).filter((e) => ownFile(e.abs, s)).map((e) => e.abs)).size;
// Files in a temporary folder, outside the session's, are scratch work.
const SCRATCH = /^(\/private)?\/tmp\/|^\/var\/folders\/|\/\.claude\/jobs\/[^/]+\/tmp\//;
const scratch = (abs, s) => SCRATCH.test(abs) && !ownFile(abs, s);

// Works out a post's changes from its edits. `load(edit)` gives an edit's op when the edit only says where to
// find it; `disk(abs)` the file as it is now (none for files on another machine).
export function createChanges({ load, disk = null }) {
  const ops = new Map(); // an edit's op, for the newest few hundred
  const memo = new Map(); // post + scope -> { key, at, value }
  const opOf = (e) => {
    if (e.op) return e.op;
    const k = `${e.src?.file}:${e.src?.at}:${e.fi ?? ""}:${e.abs}`;
    let op = ops.get(k);
    if (!op) {
      op = load(e) || { unknown: true };
      ops.set(k, op);
      if (ops.size > 400) ops.delete(ops.keys().next().value);
    }
    return op;
  };

  // The files changed by the edits `match` picks, each with its kind, size, hunks and how they were found.
  // Files elsewhere than the session's folder come last, marked `elsewhere`; scratch files are left out.
  function compute(edits, s, match = () => true, useDisk = true) {
    const byFile = new Map();
    for (const e of edits || []) {
      if (scratch(e.abs, s)) continue;
      if (!byFile.has(e.abs)) byFile.set(e.abs, []);
      byFile.get(e.abs).push(e);
    }
    const files = [];
    for (const [abs, all] of byFile) {
      const list = [...all].sort((a, b) => String(a.at).localeCompare(String(b.at)));
      const from = list.findIndex(match);
      if (from < 0) continue;
      const to = list.length - [...list].reverse().findIndex(match);
      const mine = list.slice(from, to);
      const fileOps = list.map(opOf);
      const K = statesOf(fileOps, disk && useDisk ? () => disk(abs) : null);
      const ch = fileChange(fileOps, K, from, to);
      if (ch.kind === "gone") continue;
      const cmd = mine.filter((e) => e.kind === "command").length;
      const nodiff = !ch.hunks.length && fileOps.slice(from, to).some((o) => o.unknown);
      if (!ch.hunks.length && !nodiff) continue;
      files.push({
        path: mine.at(-1).path,
        abs,
        kind: ch.kind,
        ...sizeOf(ch.hunks),
        edits: mine.length,
        exact: ch.exact,
        outside: ch.outside,
        by: cmd === mine.length ? "command" : cmd ? "both" : "edit",
        ...(nodiff ? { nodiff: true } : {}),
        ...(ownFile(abs, s) ? {} : { elsewhere: true }),
        at: mine.at(-1).at,
        hunks: ch.hunks,
      });
    }
    files.sort((a, b) => Number(!!a.elsewhere) - Number(!!b.elsewhere) || a.path.localeCompare(b.path));
    return files;
  }

  // The same, remembered for a few seconds per post and scope, as long as the post has no new edits.
  function changes(post, edits, s, scope, match, useDisk = true) {
    const key = `${edits?.length || 0}:${edits?.at(-1)?.at || ""}`;
    const id = `${post}\u0000${scope}`;
    const m = memo.get(id);
    if (m && m.key === key && Date.now() - m.at < 15e3) return m.value;
    const value = compute(edits, s, match, useDisk);
    memo.set(id, { key, at: Date.now(), value });
    if (memo.size > 200) memo.delete(memo.keys().next().value);
    return value;
  }

  return { changes, opOf };
}

// ", +40 −8" for a change's size, leaving out a side with nothing on it.
export const sizeText = ({ add, del }) => (add || del ? `, ${[add ? `+${add}` : "", del ? `−${del}` : ""].filter(Boolean).join(" ")}` : "");

// What the page sums up: files changed in the session's folder, and lines added and removed.
export function totals(files) {
  const own = files.filter((f) => !f.elsewhere);
  return { files: own.length, add: own.reduce((n, f) => n + f.add, 0), del: own.reduce((n, f) => n + f.del, 0) };
}
