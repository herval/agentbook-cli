#!/usr/bin/env node
// What agentbook-cli has to manage alone once it's in a repo of its own: its launcher doesn't need bin/agentbook or
// server/, help and --version work with no daemon and no login, and its files say what's true about it.
// Run: node test/cli-basics.mjs

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testPort } from "./harness-ports.mjs";

const TEST = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(TEST, "..");
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-cli-basics-")));
const PORT = testPort(6510, 40);

let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const json = (f) => JSON.parse(fs.readFileSync(path.join(REPO, f), "utf8"));

// A fake claude that writes down what it was started with.
const bin = path.join(BASE, "bin");
const CALLS = path.join(BASE, "claude.log");
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\nprintf '%s\\n' "channel=$AGENTBOOK_CHANNEL plugin_dir=$AGENTBOOK_PLUGIN_DIR $*" >> "${CALLS}"\n`, { mode: 0o755 });
const lastCall = () => fs.readFileSync(CALLS, "utf8").trim().split("\n").at(-1);

// What ships, with nothing else around it: no bin/agentbook, no server/.
const SHIP = path.join(BASE, "ship");
fs.mkdirSync(path.join(SHIP, "bin"), { recursive: true });
fs.cpSync(path.join(REPO, "plugin"), path.join(SHIP, "plugin"), { recursive: true });
fs.copyFileSync(path.join(REPO, "bin", "agentbook-cli"), path.join(SHIP, "bin", "agentbook-cli"));

const USER = path.join(BASE, "person");
const DATA = path.join(USER, ".agentbook");
fs.mkdirSync(USER);
const env = { PATH: `${bin}:${process.env.PATH}`, HOME: USER, AGENTBOOK_HOME: DATA, AGENTBOOK_PORT: String(PORT), CLAUDE_CONFIG_DIR: path.join(USER, ".claude") };
const run = (file, ...args) => spawnSync(file, args, { env, encoding: "utf8", timeout: 30000 });
const CLI = path.join(SHIP, "bin", "agentbook-cli");
const OLD = path.join(REPO, "bin", "agentbook");
const HAS_OLD = fs.existsSync(OLD);

try {
  // ---------- Claude Code with agentbook's channel ----------
  check(!fs.existsSync(path.join(SHIP, "bin", "agentbook")) && !fs.existsSync(path.join(SHIP, "server")), "(what ships has no bin/agentbook and no server/)");
  check(run(CLI, "claude", "--resume", "a b").status === 0, "agentbook-cli claude runs with no bin/agentbook");
  check(lastCall() === "channel=1 plugin_dir= --dangerously-load-development-channels plugin:agentbook@agentbook --resume a b", `and starts Claude Code with the channel and your arguments (${lastCall()})`);
  check(run(CLI, "dev", "-c").status === 0, "agentbook-cli dev runs with no bin/agentbook");
  const dev = /^channel=1 plugin_dir=(\S+) --plugin-dir (\S+) --dangerously-load-development-channels plugin:agentbook@inline -c$/.exec(lastCall());
  check(dev?.[1] === path.join(SHIP, "plugin") && dev[2].startsWith(path.join(DATA, "cli", "plugin-copies") + path.sep), `and loads the plugin from a copy of this folder's (${lastCall()})`);
  check(fs.existsSync(path.join(dev?.[2] || "", ".claude-plugin", "plugin.json")), "which is really there");

  // Only where bin/agentbook is: this test can ship without it.
  if (HAS_OLD) {
    check(run(OLD, "claude", "-c").status === 0 && lastCall().endsWith("plugin:agentbook@agentbook -c") && lastCall().startsWith("channel=1"), "agentbook claude still works here");
    check(run(OLD, "dev").status === 0 && lastCall().includes(`plugin_dir=${path.join(REPO, "plugin")} --plugin-dir`), "and so does agentbook dev");
  }

  // ---------- help and --version ----------
  fs.rmSync(DATA, { recursive: true, force: true });
  const { version } = json("plugin/.claude-plugin/plugin.json");
  for (const a of ["--version", "-v", "version"]) {
    const r = run(CLI, a);
    check(r.status === 0 && r.stdout.trim() === `agentbook-cli ${version}` && !r.stderr, `${a} says the plugin's version (${JSON.stringify(r.stdout + r.stderr)})`);
  }
  for (const a of ["help", "--help", "-h"]) {
    const r = run(CLI, a);
    check(r.status === 0 && r.stdout.startsWith(`agentbook-cli ${version}:`) && !r.stderr, `${a} prints its help`);
  }
  if (HAS_OLD) check(run(OLD, "--version").stdout.trim() === `agentbook-cli ${version}`, "bin/agentbook passes them on");
  check(!fs.existsSync(DATA), "neither makes its data folder, or starts anything that would");
  check(!(await fetch(`http://127.0.0.1:${PORT}/api/health`).catch(() => null)), "and no daemon is running");

  const help = run(CLI, "help").stdout;
  const { COMMANDS } = await import("../plugin/cli/commands.mjs");
  const left = COMMANDS.filter((c) => !["connect", "local"].includes(c) && !new RegExp(`agentbook-cli (\\S*\\|)?${c}\\b|(, |\\|)(--)?${c}\\b`).test(help));
  check(!left.length, `help names each command (left out: ${left.join(", ") || "none"})`);
  check(help.includes(path.join(DATA, "cli", "cli.log")), "and where its log is");
  check(!/\bsessions?\b/.test(help), "and doesn't call a thread a session");

  const none = run(CLI, "nope");
  check(none.status === 1 && /there's no nope command/.test(none.stderr) && none.stderr.includes("help"), "a command it doesn't have is still an error, and says what it has");

  // ---------- what its files say ----------
  const root = json("package.json");
  check(root.version === undefined || root.version === version, "the root package.json has no version to disagree with the plugin's");
  for (const f of ["plugin/openclaw/package.json", "plugin/dsh/package.json"]) {
    const p = json(f);
    check(/github\.com\/herval\/agentbook-cli/.test(p.repository?.url || "") && !p.repository?.directory, `${f} says its repository, wherever it ends up in there`);
  }
  // In plugin/ here, and at the top of the public repo.
  const beside = fs.existsSync(path.join(REPO, "plugin", "SECURITY.md")) ? "plugin" : ".";
  const security = fs.readFileSync(path.join(REPO, beside, "SECURITY.md"), "utf8");
  check(security.includes("https://github.com/herval/agentbook-cli/security/advisories/new"), "SECURITY.md, beside the README, reports through GitHub");
  check(!/[\w.+-]+@[\w-]+\.\w+/.test(security), "with no email address");
  check(fs.readFileSync(path.join(REPO, beside, "README.md"), "utf8").includes("(SECURITY.md)"), "and the README links to it");
} finally {
  fs.rmSync(BASE, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} checks failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
