#!/usr/bin/env node
// How often the WIP list reads a worktree's uncommitted changes (`git status` lists untracked files across the whole
// tree, seconds of CPU in a big repo): on every scan while a session works in it, once more when that stops, and
// otherwise every few minutes. Run: node test/wip-dirty.mjs

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listWip } from "../plugin/cli/wip.mjs";

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failures++;
};

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-wip-dirty-")));
const repo = path.join(HOME, "shop");
const git = (cwd, ...args) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
try {
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "app.js"), "one\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "Start");
  const cart = path.join(repo, ".claude", "worktrees", "cart");
  git(repo, "worktree", "add", "-q", "-b", "worktree-cart", cart);
  const dirty = async (working = []) => (await listWip(repo, new Set(), "box", working))?.find((w) => w.branch === "worktree-cart")?.dirty;

  check((await dirty()) === 0, "a worktree's uncommitted changes are read the first time");
  fs.writeFileSync(path.join(cart, "cart.css"), ".cart {}\n");
  check((await dirty()) === 0, "with no session working in it, it isn't read again on the next scan");
  check((await dirty([path.join(cart, "src")])) === 1, "with a session working in it (or in a folder inside it), it's read on every scan");
  fs.writeFileSync(path.join(cart, "README"), "a cart\n");
  check((await dirty()) === 2, "once that session stops, it's read once more");
  fs.writeFileSync(path.join(cart, "more.css"), ".more {}\n");
  check((await dirty()) === 2, "and then it waits again");
  check((await dirty([repo])) === 2, "a session in the project's own folder doesn't count as working in each of its worktrees");
} finally {
  fs.rmSync(HOME, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
