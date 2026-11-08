// WIP: work on a branch that isn't on its project's main branch yet. A project's WIP is each branch a post
// worked on, and each worktree in the project's own folder (where Claude Code makes them), or the folder itself
// on a branch: worktrees other tools keep elsewhere (Conductor's, a /tmp checkout) are someone else's to track,
// unless a post works there. What's on one comes from git, not from what the agents recorded: its commits not on main (by what they change, so a commit cherry-picked onto main counts
// as there), how far main moved since it branched, what isn't committed in its worktree, and which files
// changed both there and on main.

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { capped, parseUnified, sizeOf, wholeFile } from "./changes.mjs";

const git = (cwd, args, timeout = 15000) =>
  new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], { encoding: "utf8", timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().split("\n").at(-1)));
      else resolve(stdout.replace(/\s+$/, ""));
    });
  });
const lines = (s) => (s ? s.split("\n") : []);
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

// Where a worktree is, from its project's folder (".claude/worktrees/x"), when it's inside it.
function placeIn(root, wt) {
  if (!wt) return null;
  const rel = path.relative(real(root), real(wt));
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : null;
}

// The same WIP on every machine has its own id: a project's branch on one machine.
export const wipId = (machine, root, branch) => crypto.createHash("sha1").update(`${machine}\0${root}\0${branch}`).digest("hex").slice(0, 12);

// The branch work lands on: the one origin's HEAD names, else main or master, else the one the project's
// folder is on.
async function baseOf(root) {
  const has = (b) => git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`], 3000).then(() => true, () => false);
  const origin = await git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], 3000).catch(() => "");
  const named = origin.replace(/^origin\//, "");
  for (const b of [named, "main", "master"]) if (b && (await has(b))) return b;
  const here = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"], 3000).catch(() => "");
  return here && here !== "HEAD" ? here : null;
}

// A project's branches, each with the worktree it's checked out in (null: none, or one that's gone).
async function heads(root) {
  const out = await git(root, ["for-each-ref", "--format=%(refname:short)%09%(objectname)%09%(worktreepath)%09%(committerdate:iso-strict)%09%(subject)", "refs/heads"], 5000);
  return lines(out).map((l) => {
    const [branch, sha, wt, at, ...subject] = l.split("\t");
    return { branch, sha, worktree: wt && fs.existsSync(wt) ? wt : null, at: at || null, subject: subject.join("\t") };
  });
}

// What isn't committed in a worktree: how many files.
// How many files a worktree has changed and not committed. `git status` lists untracked files across the whole tree
// (about 2 CPU-seconds in a 62k-file monorepo, for each of its dozens of worktrees), and a worktree nobody works in
// doesn't change on its own, so it's read on every scan only while a session works in it (`live`), once more when
// that stops, and otherwise every few minutes.
const DIRTY_IDLE_MS = 5 * 60e3;
const dirtyKept = new Map(); // real worktree path -> { at, n, live }
async function dirtyIn(wt, live = false) {
  if (!wt) return 0;
  const key = real(wt);
  const kept = dirtyKept.get(key);
  if (kept && !live && !kept.live && Date.now() - kept.at < DIRTY_IDLE_MS) return kept.n;
  const n = lines(await git(wt, ["status", "--porcelain", "--untracked-files=normal"], 8000).catch(() => "")).length;
  if (dirtyKept.size > 500) dirtyKept.clear();
  dirtyKept.set(key, { at: Date.now(), n, live });
  return n;
}
// Whether a folder (a working session's) is the worktree or inside it.
const within = (wt, dirs) => {
  const w = real(wt);
  return dirs.some((d) => d === w || d.startsWith(w + path.sep));
};
// A branch's commits since it left `base`, each marked as landed when `base` has the same change.
async function cherry(root, base, branch) {
  return lines(await git(root, ["cherry", base, branch], 8000).catch(() => "")).map((l) => ({ sha: l.slice(2), landed: l[0] === "-" }));
}

// Whether a branch moved since it was made, from its reflog (newest first, so its last line is where it was
// made). A branch that landed by fast-forward has no commit `git cherry` sees anymore, like one that never had
// any: this tells them apart. A reflog that doesn't go back to its making (its oldest lines expired) moved at
// least once; with none at all, it can't say (null).
async function moved(root, h) {
  const log = lines(await git(root, ["reflog", "show", "--format=%H %gs", `refs/heads/${h.branch}`], 5000).catch(() => ""));
  const first = log.at(-1);
  if (!first) return null;
  return first.slice(41).startsWith("branch: Created") ? first.slice(0, 40) !== h.sha : true;
}

// Where a branch left main: the last commit they share, with its time and subject (null when they share none).
async function forkOf(root, base, branch) {
  const mb = await git(root, ["merge-base", base, branch], 8000).catch(() => "");
  if (!mb) return null;
  const [sha, at, ...subject] = (await git(root, ["log", "-1", "--format=%H%x09%cI%x09%s", mb], 5000)).split("\t");
  return { sha, at, subject: subject.join("\t") };
}

// How a branch stands against main changes only when one of them moves, and `git cherry` reads every commit
// on both sides since they parted, so it's kept by the two commits it was worked out for (and the branch's name:
// two branches on one commit can have moved differently to get there).
const standing = new Map(); // "root, base commit, branch, its commit" -> { commits, behind, moved, fork }
async function standingOf(root, base, baseSha, h) {
  const key = `${root}\0${baseSha}\0${h.branch}\0${h.sha}`;
  if (!standing.has(key)) {
    const [commits, behind, went, fork] = await Promise.all([cherry(root, base, h.branch), git(root, ["rev-list", "--count", `${h.branch}..${base}`], 8000).then(Number, () => 0), moved(root, h), forkOf(root, base, h.branch).catch(() => null)]);
    if (standing.size > 500) standing.clear();
    standing.set(key, { commits, behind, moved: went, fork });
  }
  return standing.get(key);
}

// A project's WIP, summed up for the sidebar: the branches in `branches` (posts worked on them), and the ones
// checked out in the project's folder or a worktree inside it, except the main one. Null when the folder isn't
// a git checkout. `working`: the folders sessions are working in now, whose worktrees are read fresh (dirtyIn).
export async function listWip(root, branches = new Set(), machine = "", working = []) {
  const busy = working.map(real);
  const base = await baseOf(root).catch(() => null);
  if (!base) return null;
  const all = await heads(root).catch(() => null);
  if (!all) return null;
  const tip = all.find((h) => h.branch === base);
  const baseSha = tip?.sha;
  // main's latest commit, which a timeline of its WIP starts from
  const baseHead = tip ? { sha: tip.sha, at: tip.at, subject: tip.subject } : null;
  const ours = (wt) => !!wt && (real(wt) === real(root) || !!placeIn(root, wt));
  const picked = all.filter((h) => h.branch !== base && (ours(h.worktree) || branches.has(h.branch)));
  const out = [];
  for (let i = 0; i < picked.length; i += 6) {
    out.push(
      ...(await Promise.all(
        picked.slice(i, i + 6).map(async (h) => {
          const [{ commits, behind, moved, fork }, dirty] = await Promise.all([standingOf(root, base, baseSha, h), dirtyIn(h.worktree, !!h.worktree && within(h.worktree, busy))]);
          // `worked`: it had commits of its own, landed or not, so with nothing left to land it's merged, not
          // a branch nothing happened on yet. `fork`: the commit it left main at.
          return { id: wipId(machine, root, h.branch), root, branch: h.branch, sha: h.sha, base, base_head: baseHead, worktree: h.worktree, place: placeIn(root, h.worktree), here: !!h.worktree && real(h.worktree) === real(root), ahead: commits.filter((c) => !c.landed).length, commits: commits.length, worked: commits.length > 0 || !!moved, behind, fork, dirty, subject: h.subject, at: h.at };
        }),
      )),
    );
  }
  return out;
}

// `git diff --numstat` and `--name-status` together: each file with its lines added and removed, and whether
// it's new or deleted. A binary file has no line counts.
async function changed(cwd, range) {
  const [nums, names] = await Promise.all([git(cwd, ["diff", "--no-renames", "--numstat", ...range], 15000), git(cwd, ["diff", "--no-renames", "--name-status", ...range], 15000)]);
  const kind = new Map(lines(names).map((l) => [l.slice(l.indexOf("\t") + 1), l[0]]));
  return lines(nums).map((l) => {
    const [a, d, ...p] = l.split("\t");
    const file = p.join("\t");
    const k = kind.get(file);
    return { path: file, add: a === "-" ? null : Number(a), del: d === "-" ? null : Number(d), kind: k === "A" ? "create" : k === "D" ? "delete" : "edit", binary: a === "-" };
  });
}
// Files a worktree has that git doesn't track yet, each counted as all added.
async function untracked(wt) {
  const list = lines(await git(wt, ["ls-files", "--others", "--exclude-standard"], 8000).catch(() => ""));
  return list.slice(0, 500).map((p) => {
    let add = null;
    try {
      const buf = fs.readFileSync(path.join(wt, p));
      if (buf.length <= 2 * 1024 * 1024 && !buf.subarray(0, 8000).includes(0)) add = wholeFile(buf.toString("utf8"))[0]?.lines.length || 0;
    } catch {}
    return { path: p, add, del: add == null ? null : 0, kind: "create", binary: add == null, untracked: true };
  });
}

// Which worktree a branch is checked out in, read fresh.
const worktreeOf = async (root, branch) => (await heads(root)).find((h) => h.branch === branch);

// One WIP in full, for its page: its commits (landed or not), main's commits since it branched with the
// files they share with it, and its changes: committed since it branched, and not committed in its worktree.
export async function wipDetail(root, branch, machine = "") {
  const base = await baseOf(root);
  if (!base) throw Object.assign(new Error(`${path.basename(root)} has no main branch to compare with.`), { status: 404 });
  const head = await worktreeOf(root, branch);
  if (!head) throw Object.assign(new Error(`${path.basename(root)} has no branch ${branch}.`), { status: 404 });
  const mb = await git(root, ["merge-base", base, branch], 8000).catch(() => null);
  const marks = new Map((await cherry(root, base, branch)).map((c) => [c.sha, c.landed]));
  const log = mb ? await git(root, ["log", "--max-count=100", "--format=%H%x1f%h%x1f%cI%x1f%s", `${mb}..${branch}`], 8000) : "";
  const commits = lines(log).map((l) => {
    const [sha, short, at, subject] = l.split("\x1f");
    return { sha, short, at, subject, landed: !!marks.get(sha) };
  });
  const mainLog = mb ? await git(root, ["log", "--max-count=50", "--name-only", "--format=%x1e%h%x1f%cI%x1f%s", `${mb}..${base}`], 8000) : "";
  const main = mainLog
    .split("\x1e")
    .filter((x) => x.trim())
    .map((chunk) => {
      const [first, ...files] = chunk.split("\n");
      const [short, at, subject] = first.split("\x1f");
      return { short, at, subject, files: files.filter(Boolean) };
    });
  const behind = mb ? Number(await git(root, ["rev-list", "--count", `${branch}..${base}`], 8000).catch(() => 0)) : 0;
  const committed = mb ? await changed(root, [mb, branch]).catch(() => []) : [];
  const wt = head.worktree;
  const uncommitted = wt ? [...(await changed(wt, ["HEAD"]).catch(() => [])), ...(await untracked(wt))] : [];
  const onMain = new Set(main.flatMap((c) => c.files));
  const mine = new Set([...committed, ...uncommitted].map((f) => f.path));
  for (const c of main) c.overlap = c.files.filter((f) => mine.has(f));
  for (const c of main) delete c.files;
  for (const f of [...committed, ...uncommitted]) f.on_main = onMain.has(f.path);
  return {
    id: wipId(machine, root, branch),
    root,
    branch,
    base,
    merge_base: mb ? mb.slice(0, 7) : null,
    worktree: wt,
    place: placeIn(root, wt),
    here: !!wt && real(wt) === real(root),
    subject: head.subject,
    at: head.at,
    ahead: commits.filter((c) => !c.landed).length,
    behind,
    dirty: uncommitted.length,
    commits,
    main,
    overlap: [...mine].filter((f) => onMain.has(f)),
    committed,
    uncommitted,
  };
}

// One file's change in a WIP: what its commits changed since it branched, or what isn't committed in its
// worktree (a file git doesn't track yet, whole).
export async function wipDiff(root, branch, file, scope) {
  if (!file || path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) throw Object.assign(new Error("That isn't a file in this project."), { status: 400 });
  const base = await baseOf(root);
  const head = await worktreeOf(root, branch);
  if (!base || !head) throw Object.assign(new Error(`${path.basename(root)} has no branch ${branch}.`), { status: 404 });
  let text;
  if (scope === "uncommitted") {
    const wt = head.worktree;
    if (!wt) throw Object.assign(new Error(`${branch} isn't checked out anywhere, so nothing on it is uncommitted.`), { status: 404 });
    const tracked = await git(wt, ["ls-files", "--error-unmatch", "--", file], 5000).then(() => true, () => false);
    if (!tracked) {
      const full = real(path.join(wt, file));
      if (!full.startsWith(real(wt) + path.sep)) throw Object.assign(new Error("That isn't a file in this project."), { status: 400 });
      const buf = fs.readFileSync(full);
      if (buf.subarray(0, 8000).includes(0)) return { path: file, kind: "create", binary: true, hunks: [] };
      return { path: file, kind: "create", ...capped(wholeFile(buf.toString("utf8"))) };
    }
    text = await git(wt, ["diff", "--no-renames", "HEAD", "--", file]);
  } else {
    const mb = await git(root, ["merge-base", base, branch], 8000);
    text = await git(root, ["diff", "--no-renames", mb, branch, "--", file]);
  }
  const f = parseUnified(text)[0];
  if (!f) return { path: file, kind: "edit", hunks: [] };
  if (/^Binary files /m.test(text)) return { path: file, kind: f.kind, binary: true, hunks: [] };
  return { path: file, kind: f.kind, ...capped(f.hunks), ...sizeOf(f.hunks) };
}

// Clean up a WIP once everything on it is on main: remove its worktree (git refuses one with changes) and
// delete its branch. Refuses while anything on it isn't on main, or the project's own folder is on it.
export async function cleanUp(root, branch) {
  const d = await wipDetail(root, branch);
  if (d.here) throw Object.assign(new Error(`${path.basename(root)}'s own folder is on ${branch}.`), { status: 409 });
  if (d.ahead) throw Object.assign(new Error(`${d.ahead} commit${d.ahead === 1 ? " isn't" : "s aren't"} on ${d.base} yet.`), { status: 409 });
  if (d.dirty) throw Object.assign(new Error(`${d.dirty} file${d.dirty === 1 ? " isn't" : "s aren't"} committed.`), { status: 409 });
  if (d.worktree) await git(root, ["worktree", "remove", d.worktree], 30000);
  // Every commit on it is on main by what it changes, so deleting it loses nothing, even when git can't tell
  // by ancestry (a cherry-picked commit).
  await git(root, ["branch", "-D", branch], 8000);
  return { removed: d.worktree, branch };
}

// Discard a WIP: remove its worktree with whatever isn't committed there, and delete its branch with whatever
// isn't on main. Refuses when the project's own folder is on it, or (given `sha`) it moved off the commit that was
// shown. Its last commit, `sha`, git keeps a while (`git branch <name> <sha>` brings it back) though nothing
// names it anymore.
export async function discard(root, branch, sha = null) {
  const head = await worktreeOf(root, branch);
  if (!head) throw Object.assign(new Error(`${path.basename(root)} has no branch ${branch}.`), { status: 404 });
  if (sha && head.sha !== sha) throw Object.assign(new Error(`${branch} moved since: look again before discarding it.`), { status: 409 });
  if (head.worktree && real(head.worktree) === real(root)) throw Object.assign(new Error(`${path.basename(root)}'s own folder is on ${branch}.`), { status: 409 });
  if (head.worktree) await git(root, ["worktree", "remove", "--force", head.worktree], 30000);
  await git(root, ["branch", "-D", branch], 8000);
  return { removed: head.worktree, branch, sha: head.sha };
}
