// How far a turn's change reaches (its blast radius): the repo by folder, sized by its files,
// with the files the turn changed, the files that import them, and the changes no test imports. Worked out on the
// machine when a turn that changed files ends (daemon.mjs's reportTurn), from git: the files it tracks and their
// sizes (`git ls-tree`), and which of them import a changed one (`git grep`). It goes up with the turn's "Changed 3
// files" line, so it stays small: a few folders and the files that matter in them.

import path from "node:path";

const TEST = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z0-9]+$/i;
const CODE = /\.(m?[jt]sx?|cjs|vue|svelte)$/i;
const MAX_FOLDERS = 8;
const MAX_FILES = 24;
const MAX_IMPORTERS = 10;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const top = (p) => (p.includes("/") ? p.slice(0, p.indexOf("/")) : ".");
const inside = (p) => (p.includes("/") ? p.slice(p.indexOf("/") + 1) : p);
// What a file is imported as: its name without its extension, or its folder's for an index file.
function stemOf(p) {
  const base = path.posix.basename(p).replace(/\.[^.]+$/, "");
  return base === "index" ? path.posix.basename(path.posix.dirname(p)) : base;
}

// `files`: the turn's changed files, { abs, add, del, kind }. `git(args)`: runs git in the repo, resolving to its
// output. `root`: the repo's top folder. Null when there's nothing to say.
export async function reachOf({ files, root, git }) {
  const changed = files.filter((f) => f.abs && f.abs.startsWith(root + path.sep)).map((f) => ({ path: path.relative(root, f.abs).split(path.sep).join("/"), add: f.add || 0, del: f.del || 0, kind: f.kind }));
  if (!changed.length) return null;
  // Every file git tracks, and its size in bytes.
  const sizes = new Map();
  for (const line of String(await git(["ls-tree", "-r", "-l", "--full-tree", "HEAD"]).catch(() => "")).split("\n")) {
    const m = line.match(/^\S+ blob \S+\s+(\d+)\t(.+)$/);
    if (m) sizes.set(m[2], Number(m[1]));
  }
  for (const c of changed) if (!sizes.has(c.path)) sizes.set(c.path, Math.max(1, (c.add || 0) * 40));
  // Which files import each changed file (code only), by its name in an import, a require or a from.
  const importers = new Map();
  for (const c of changed.filter((x) => CODE.test(x.path) && x.kind !== "delete").slice(0, 8)) {
    const stem = stemOf(c.path);
    if (stem.length < 3) continue;
    const re = `(import|require|from)[^'"\`]*['"\`]([^'"\`]*/)?${esc(stem)}(/index)?(\\.[A-Za-z]+)?['"\`]`;
    const out = await git(["grep", "-l", "-E", "-e", re, "--", "*.js", "*.mjs", "*.cjs", "*.ts", "*.tsx", "*.jsx", "*.vue", "*.svelte"]).catch(() => "");
    for (const p of String(out).split("\n").filter(Boolean)) if (p !== c.path) importers.set(p, [...(importers.get(p) || []), c.path]);
  }
  const changedSet = new Set(changed.map((c) => c.path));
  const testsImport = new Set([...importers].filter(([p]) => TEST.test(p)).flatMap(([, of]) => of));
  const testsChanged = changed.filter((c) => TEST.test(c.path)).map((c) => stemOf(c.path).replace(/\.(test|spec)$/i, ""));
  const untested = (c) => CODE.test(c.path) && !TEST.test(c.path) && c.kind !== "delete" && !testsImport.has(c.path) && !testsChanged.includes(stemOf(c.path));

  // The files it shows: what changed, then what imports it (not tests, which say it's covered), up to MAX_FILES.
  const shown = [
    ...changed.map((c) => ({ path: c.path, size: sizes.get(c.path) || 1, add: c.add, del: c.del, changed: true, ...(untested(c) ? { untested: true } : {}) })),
    ...[...importers.keys()].filter((p) => !changedSet.has(p) && !TEST.test(p)).slice(0, MAX_IMPORTERS).map((p) => ({ path: p, size: sizes.get(p) || 1, imports: true })),
  ].slice(0, MAX_FILES);
  // The repo's folders, biggest first; the ones with a file shown always, up to MAX_FOLDERS; the rest as one.
  const bytes = new Map();
  for (const [p, n] of sizes) bytes.set(top(p), (bytes.get(top(p)) || 0) + n);
  const withShown = new Set(shown.map((f) => top(f.path)));
  const order = [...bytes.keys()].sort((a, b) => Number(withShown.has(b)) - Number(withShown.has(a)) || bytes.get(b) - bytes.get(a));
  const keep = order.slice(0, Math.max(MAX_FOLDERS, withShown.size));
  const folders = keep.map((dir) => {
    const mine = shown.filter((f) => top(f.path) === dir).map((f) => ({ ...f, path: inside(f.path) }));
    return { dir, size: bytes.get(dir), files: mine, rest: Math.max(0, bytes.get(dir) - mine.reduce((n, f) => n + f.size, 0)) };
  });
  const other = order.slice(keep.length).reduce((n, d) => n + bytes.get(d), 0);
  return {
    folders: other ? [...folders, { dir: "…", size: other, files: [], rest: other }] : folders,
    changed: changed.length,
    importers: [...importers.keys()].filter((p) => !changedSet.has(p) && !TEST.test(p)).length,
    untested: shown.filter((f) => f.untested).length,
  };
}
