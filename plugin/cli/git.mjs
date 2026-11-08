// Where a new post's session works in a git project: on the branch its folder is on, on another branch or a new
// one (switched to in the folder), or in a worktree of its own. Worktrees go where `claude --worktree` puts
// them, .claude/worktrees/<name> on a branch worktree-<name>, so Claude Code and agentbook find each other's.

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { cloneUrl, repoKey, withoutSecrets } from "../shared/repos.mjs";

export { cloneUrl, repoKey };

const git = (cwd, args, timeout = 30000) =>
  new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], { encoding: "utf8", timeout }, (err, stdout, stderr) => {
      if (err) reject(new Error(err.killed ? `git ${args[0]} didn't finish in ${timeout >= 60000 ? `${timeout / 60000} minutes` : `${timeout / 1000}s`}, so agentbook stopped it.` : lastWord(stderr) || err.message));
      else resolve(stdout.trim());
    });
  });
// The last thing git said, skipping its progress lines ("Updating files:  80% (49958/62447)\r").
const lastWord = (stderr) =>
  String(stderr || "")
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter((l) => l && !/^[\w ]+:\s+\d+% \(/.test(l))
    .at(-1);
// Checking a big repo out takes a while (a 62k-file monorepo takes most of a minute), so a worktree gets minutes.
const WORKTREE_MS = 10 * 60e3;
const real = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};
const WORKTREES = path.join(".claude", "worktrees");

// The branch a project's folder is on, and its other branches, newest first, each with the worktree it's
// checked out in (git won't check one branch out twice). Null for a folder that isn't a git checkout.
export async function branches(root) {
  const current = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"], 3000).catch(() => null);
  if (current == null) return null;
  const out = await git(root, ["for-each-ref", "--format=%(refname:short)%09%(worktreepath)", "refs/heads"], 3000).catch(() => "");
  const here = real(root);
  const others = out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, wt] = line.split("\t");
      return { name, worktree: wt && real(wt) !== here ? wt : null };
    })
    .filter((b) => b.name !== current)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })); // as the composer lists them
  return { branch: current === "HEAD" ? null : current, branches: others };
}

// A branch name from what the session should do: "Fix the login bug" → "fix-the-login-bug".
function nameFor(prompt) {
  const words = String(prompt || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").slice(0, 5);
  return words.join("-").slice(0, 32).replace(/-+$/, "") || "session";
}
const exists = (root, branch) => git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], 3000).then(() => true, () => false);
// A name no branch (`prefix` + name; null: no branch is made) and no worktree folder has yet.
async function unique(root, base, prefix = "") {
  for (let i = 1; ; i++) {
    const name = i === 1 ? base : `${base}-${i}`;
    if ((prefix == null || !(await exists(root, prefix + name))) && !fs.existsSync(path.join(root, WORKTREES, name))) return name;
  }
}

// Get the folder ready and say where to start: { cwd, branch }, and for a new worktree `make`, which checks it out
// there (it can take minutes in a 62k-file monorepo), calling `progress` as it goes. `branch` is an existing
// branch to work on (none: the one the folder is on). `fresh` makes a new branch instead, off `base` (none: the
// folder's branch). `worktree` gives it a folder of its own, where the folder's branch can't be checked out a
// second time, so it starts a new branch unless it's on another one. `busy` names a session working in the
// folder, whose branch it would switch out from under it.
export async function prepare({ root, worktree = false, branch = "", fresh = false, base = "", prompt = "", busy = false }) {
  const repo = path.basename(root);
  const info = await branches(root);
  if (!info) throw new Error(`${repo} isn't a git checkout, so it has no branches to pick from.`);
  const known = async (name) => {
    await git(root, ["check-ref-format", "--branch", name], 3000).catch(() => {
      throw new Error(`"${name}" isn't a branch name.`);
    });
    if (!(await exists(root, name))) throw new Error(`${repo} has no branch ${name}.`);
  };
  if (base) await known(base);
  if (base || branch === info.branch) branch = "";
  if (branch) await known(branch);
  fresh = fresh || !!base || (worktree && !branch);

  if (!worktree) {
    if (!branch && !fresh) return { cwd: root, branch: info.branch };
    const elsewhere = branch && info.branches.find((b) => b.name === branch)?.worktree;
    if (elsewhere) throw new Error(`${branch} is checked out in ${path.relative(real(root), real(elsewhere))}. Start this one in a worktree to work there.`);
    if (busy) throw new Error(`${busy} is working in ${repo}, so agentbook won't switch its branch out from under it. Start this one in a worktree.`);
    // Switching to another commit takes the folder's files with it; a new branch off the folder's own doesn't.
    const to = branch || (base && base !== info.branch ? `a new branch off ${base}` : "");
    if (to && (await git(root, ["status", "--porcelain", "--untracked-files=no"], 5000))) throw new Error(`${repo} has changes that aren't committed, so agentbook won't switch it to ${to}. Commit them first, or start this one in a worktree.`);
    if (branch) {
      await git(root, ["switch", branch]);
      return { cwd: root, branch };
    }
    const name = await unique(root, nameFor(prompt));
    await git(root, ["switch", "-c", name, base || "HEAD"]);
    return { cwd: root, branch: name };
  }

  // A branch checked out in a worktree already runs there.
  const there = branch && info.branches.find((b) => b.name === branch)?.worktree;
  if (there) return { cwd: there, branch };
  const name = await unique(root, branch ? branch.replace(/^worktree-/, "").replace(/[^\w.-]+/g, "-") : nameFor(prompt), branch ? null : "worktree-");
  const dir = path.join(root, WORKTREES, name);
  const made = !branch && `worktree-${name}`;
  return { cwd: dir, branch: branch || made, make: (progress) => addWorktree(root, dir, made ? ["-b", made, dir, base || "HEAD"] : [dir, branch], made, progress) };
}

// `git worktree add`, saying how far its checkout got as git does ({ done, total } files). One that fails takes
// what it made with it: its folder (no one's: unique() saw none there) and its new branch (`made`).
function addWorktree(root, dir, args, made, progress = () => {}) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  return new Promise((resolve, reject) => {
    // In a process group of its own, so stopping it stops the checkout git runs too, rather than leaving that
    // writing files into the folder after it's gone.
    const child = spawn("git", ["-C", root, "worktree", "add", ...args], { stdio: ["ignore", "ignore", "pipe"], detached: true });
    let said = "";
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill();
      }
    }, WORKTREE_MS);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (d) => {
      said = (said + d).slice(-8192);
      const m = [...said.slice(-400).matchAll(/Updating files:\s+\d+% \((\d+)\/(\d+)\)/g)].at(-1);
      if (m) progress({ done: Number(m[1]), total: Number(m[2]) });
    });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(dir);
      else reject(new Error(late ? `git worktree didn't finish in ${WORKTREE_MS / 60000} minutes, so agentbook stopped it.` : lastWord(said) || `git worktree add failed (${code}).`));
    });
  }).catch(async (e) => {
    fs.rmSync(dir, { recursive: true, force: true });
    await git(root, ["worktree", "prune"], 10000).catch(() => {});
    if (made) await git(root, ["branch", "-D", made], 5000).catch(() => {});
    throw e;
  });
}

/* ---------- a thread's folder that's gone ---------- */

// What can put back a thread's folder that's gone (another tool cleaned up its worktree), as its page offers it:
// `ways`, in order: its branch checked out there again, from here or, when only its
// remote has it, from there (`checkout`); a copy of the branch's commit there, not on the branch, when another folder
// has it, as git won't check a branch out twice (`copy`, `taken`: that folder); its repo's default branch there when
// the branch is gone (`base`); and always an empty folder, for the conversation alone (`empty`). `repo: false`: its
// repo's folder is gone too. Null while the folder is there.
export async function goneFolder({ cwd, root, branch }) {
  if (!cwd || fs.existsSync(cwd)) return null;
  const gone = { path: cwd, root: root || null, branch: branch || null, ways: ["empty"] };
  if (!root || !fs.existsSync(root)) return { ...gone, repo: false };
  // A folder inside the repo's own checkout (one of its folders) is put back with the repo, not as a worktree.
  const inside = cwd.startsWith(root + path.sep) && !cwd.startsWith(path.join(root, WORKTREES) + path.sep);
  if (!branch || inside) return gone;
  const sha = (ref) => git(root, ["rev-parse", "--verify", "--quiet", "--short", `${ref}^{commit}`], 3000).catch(() => null);
  const here = await sha(`refs/heads/${branch}`);
  const remote = here ? null : await sha(`refs/remotes/origin/${branch}`);
  if (here || remote) {
    // A worktree git still lists where the folder was doesn't count: it's gone too, and goes before the checkout.
    const list = await git(root, ["worktree", "list", "--porcelain"], 5000).catch(() => "");
    const taken = list
      .split("\n\n")
      .map((e) => ({ path: /^worktree (.+)$/m.exec(e)?.[1], branch: /^branch refs\/heads\/(.+)$/m.exec(e)?.[1] }))
      .find((w) => w.branch === branch && w.path && fs.existsSync(w.path))?.path;
    return taken ? { ...gone, sha: here, taken, ways: ["copy", "empty"] } : { ...gone, sha: here || remote, remote: !here, ways: ["checkout", "empty"] };
  }
  const head = await git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], 3000).catch(() => "");
  for (const base of [head, "origin/main", "origin/master", "main", "master"].filter(Boolean)) {
    const at = await sha(base);
    if (at) return { ...gone, base: base.replace(/^origin\//, ""), base_ref: base, sha: at, ways: ["base", "empty"] };
  }
  return gone;
}

// Put a thread's folder back one of the ways goneFolder offers, calling `progress` as the checkout goes. Never over
// a folder that's there: null when it's back already.
export async function restoreFolder({ cwd, root, branch, way }, progress) {
  const g = await goneFolder({ cwd, root, branch });
  if (!g) return null;
  if (!g.ways.includes(way)) throw new Error(way === "checkout" && g.taken ? `${branch} is checked out in ${g.taken} now.` : "That's not a way to put this one's folder back now.");
  if (way === "empty") {
    fs.mkdirSync(cwd, { recursive: true });
    return g;
  }
  // The worktree git still lists where the folder was holds its path, and its branch, until it's let go.
  await git(root, ["worktree", "prune"], 10000);
  if (way === "copy") await addWorktree(root, cwd, ["--detach", cwd, branch], null, progress);
  else if (way === "base") await addWorktree(root, cwd, ["--detach", cwd, g.base_ref], null, progress);
  else if (!g.remote) await addWorktree(root, cwd, [cwd, branch], null, progress);
  else {
    await git(root, ["fetch", "origin", branch], 120000).catch(() => {});
    await addWorktree(root, cwd, ["--track", "-b", branch, cwd, `origin/${branch}`], branch, progress);
  }
  return { ...g, sha: (await git(cwd, ["rev-parse", "--short", "HEAD"], 3000).catch(() => null)) || g.sha };
}

/* ---------- commits a session made ---------- */

// The commits on a checkout's branches since a time, newest first: { sha, at (ms), subject, files, add, del }.
export async function commitsSince(cwd, since, limit = 300) {
  const out = await git(cwd, ["log", "--branches", `--since=${since}`, `-n${limit}`, "--no-color", "--numstat", "--format=%x1e%H%x09%ct%x09%s"], 8000).catch(() => "");
  return out
    .split("\x1e")
    .filter((x) => x.trim())
    .map((chunk) => {
      const [head, ...rest] = chunk.split("\n");
      const [sha, ct, ...subject] = head.split("\t");
      let add = 0;
      let del = 0;
      let files = 0;
      for (const l of rest) {
        const m = l.match(/^(\d+|-)\t(\d+|-)\t/);
        if (!m) continue;
        files++;
        add += Number(m[1]) || 0;
        del += Number(m[2]) || 0;
      }
      return { sha, at: Number(ct) * 1000, subject: subject.join("\t"), files, add, del };
    });
}

// One commit's change, as a unified diff.
export const showCommit = (cwd, sha) => git(cwd, ["show", "--no-color", "--no-ext-diff", "-M", "--format=%H%x09%s", sha], 15000);

/* ---------- the same repo on every machine ---------- */

// The repo a checkout is a clone of, from its origin remote (or its first one): { remote, url }, where `remote`
// is its repoKey and `url` is what clones it. Read from .git/config, so it costs no git process.
export function remoteOf(root) {
  let text;
  try {
    text = fs.readFileSync(path.join(root, ".git", "config"), "utf8");
  } catch {
    return null;
  }
  const urls = {};
  let section = null;
  for (const line of text.split("\n")) {
    const head = line.match(/^\s*\[\s*([^\]]+?)\s*\]/);
    if (head) {
      section = head[1].match(/^remote\s+"(.+)"$/)?.[1] ?? null;
      continue;
    }
    const kv = section != null && line.match(/^\s*url\s*=\s*"?(.+?)"?\s*$/);
    if (kv && !urls[section]) urls[section] = kv[1];
  }
  const url = withoutSecrets(urls.origin || Object.values(urls)[0]);
  const remote = url && repoKey(url);
  return remote ? { remote, url } : null;
}
// The branch a checkout is on, from .git/HEAD; null on a detached commit or when it isn't a checkout.
export function currentBranch(root) {
  try {
    return fs.readFileSync(path.join(root, ".git", "HEAD"), "utf8").match(/^ref: refs\/heads\/(.+)$/m)?.[1].trim() || null;
  } catch {
    return null;
  }
}

// Where a folder is in git, from the files alone (it's asked about working sessions every second): the
// checkout it's in (`top`, a linked worktree's own folder), the project that checkout belongs to (a linked
// worktree's is its main checkout's) and the branch it's on ("HEAD" on a detached commit, as git says it).
// Null outside a checkout. Which checkout a folder is in doesn't change; its branch is read each time.
const checkouts = new Map(); // folder -> { top, head, root } or null
export function placeOf(dir) {
  if (!checkouts.has(dir)) checkouts.set(dir, checkoutOf(dir));
  const c = checkouts.get(dir);
  if (!c) return null;
  try {
    const head = fs.readFileSync(c.head, "utf8");
    return { top: c.top, root: c.root, repo: path.basename(c.root), branch: head.match(/^ref: refs\/heads\/(.+)$/m)?.[1].trim() || "HEAD" };
  } catch {
    checkouts.delete(dir); // the worktree's gone: look again next time
    return null;
  }
}
function checkoutOf(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const dotgit = path.join(d, ".git");
    try {
      if (fs.statSync(dotgit).isDirectory()) return { top: d, head: path.join(dotgit, "HEAD"), root: real(d) };
      // A linked worktree's .git is a file naming its git folder, whose commondir leads to the main checkout's.
      const gitdir = path.resolve(d, fs.readFileSync(dotgit, "utf8").match(/^gitdir: (.+)$/m)[1].trim());
      let root = d;
      try {
        const common = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, "commondir"), "utf8").trim());
        if (path.basename(common) === ".git") root = path.dirname(common);
      } catch {} // a submodule: a project of its own
      return { top: d, head: path.join(gitdir, "HEAD"), root: real(root) };
    } catch {}
    if (path.dirname(d) === d) return null;
  }
}

// The git checkouts right inside some folders (~/dev/*), the most recently used first. Linked worktrees
// (a .git file, not a folder) belong to their main checkout, so they're left out.
export function scanCheckouts(parents, limit = 60) {
  const found = new Map();
  for (const dir of parents) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || !(e.isDirectory() || e.isSymbolicLink())) continue;
      const root = path.join(dir, e.name);
      try {
        const st = fs.statSync(path.join(root, ".git"));
        if (st.isDirectory()) found.set(root, st.mtimeMs);
      } catch {}
    }
  }
  return [...found].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([root, at]) => ({ root, at: new Date(at).toISOString() }));
}

// Where a clone of `url` goes in `dir`: a folder named after the repo, or a checkout of it already there.
export function cloneTarget(dir, url) {
  const key = repoKey(url);
  const base = (key || "repo").split("/").pop().replace(/[^\w.-]+/g, "-") || "repo";
  for (let i = 1; ; i++) {
    const to = path.join(dir, i === 1 ? base : `${base}-${i}`);
    if (!fs.existsSync(to)) return { dir: to, exists: false };
    if (key && remoteOf(to)?.remote === key) return { dir: to, exists: true };
  }
}

// Clone a repo, without ever stopping to ask for a password or a host key: it works with the credentials
// this machine already has, or fails saying why (git's "fatal:" line, not the advice it ends with).
export function clone(url, dir) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes" };
  return new Promise((resolve, reject) => {
    execFile("git", ["clone", "--quiet", "--", url, dir], { encoding: "utf8", timeout: 20 * 60e3, env }, (err, stdout, stderr) => {
      if (!err) return resolve(dir);
      const lines = String(stderr || err.message).trim().split("\n");
      reject(new Error((lines.find((l) => l.startsWith("fatal: ")) || lines.at(-1)).replace(/^fatal: /, "")));
    });
  });
}
