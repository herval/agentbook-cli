#!/usr/bin/env node
// An agentbook-cli older than the plugin a session starts on (an update since it started) is replaced by that one:
// a session's hook (ensureCli) stops it and starts the newer; one as new or newer is left be, so a session on an older
// plugin never takes it back. agentbook-cli says its version (GET /api/health), and starts with the person's
// environment, not the session's that started it (cleanEnv).
// Run: node test/cli-upgrade.mjs

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEnv, olderVersion, outdated } from "../plugin/lib/common.mjs";

let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-cli-upgrade-")));
const HOME = path.join(BASE, "data");
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
const PORT = await freePort();

// Two copies of the plugin, as an update leaves them: the one a running agentbook-cli started from, and a newer one.
const pluginAt = (name, version) => {
  const dir = path.join(BASE, name);
  fs.cpSync(path.join(REPO, "plugin"), dir, { recursive: true });
  const file = path.join(dir, ".claude-plugin", "plugin.json");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), version }, null, 2));
  return dir;
};
const OLD = pluginAt("old", "0.0.1");
const NEW = pluginAt("new", "0.0.2");

// A machine's agentbook-cli, with no agents of its own here, and not logged in to a server. As a session's hook has
// it: that session's own variables, which agentbook-cli mustn't keep.
const env = { ...process.env, AGENTBOOK_HOME: HOME, AGENTBOOK_PORT: String(PORT), AGENTBOOK_CODEX: "0", AGENTBOOK_CODEX_MCP: "0", AGENTBOOK_OPENCLAW: "0", AGENTBOOK_HERMES: "0", AGENTBOOK_CLAUDE: "/usr/bin/false", AGENTBOOK_TERMINAL: "0", AGENTBOOK_NOTIFY: "0", AGENTBOOK_CLONE_DIR: path.join(BASE, "clones"), CLAUDE_CONFIG_DIR: path.join(BASE, "claude"), CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "a-session", AGENTBOOK_LAUNCH_ID: "l-stale", AGENTBOOK_LABEL: "gull 3" };
for (const k of ["AGENTBOOK_PLUGIN_DIR", "AGENTBOOK_CHANNEL", "AGENTBOOK_HUB", "AGENTBOOK_HUB_TOKEN", "AGENTBOOK_TOKEN", "AGENTBOOK_URL", "AGENTBOOK_OWNER", "AGENTBOOK_SERVER", "AGENTBOOK_SERVER_TOKEN", "CLAUDE_JOB_DIR"]) delete env[k];
fs.mkdirSync(env.CLAUDE_CONFIG_DIR, { recursive: true });

// With the key in its folder, as its pid goes only to a caller that has it.
const keyHeader = () => {
  try {
    return { "x-agentbook-key": fs.readFileSync(path.join(HOME, "cli", "local.key"), "utf8").trim() };
  } catch {
    return {};
  }
};
const health = () => fetch(`http://127.0.0.1:${PORT}/api/health`, { headers: keyHeader(), signal: AbortSignal.timeout(1500) }).then((r) => r.json(), () => null);
const until = async (fn, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (await fn()) return true;
  return false;
};
// A session's hook on a plugin: its ensureCli, run as the hook runs it.
const hook = (root) => spawnSync(process.execPath, ["-e", `import(${JSON.stringify(path.join(root, "lib", "common.mjs"))}).then((m) => m.ensureCli()).then((ok) => console.log(ok))`], { env: { ...env, CLAUDE_PLUGIN_ROOT: root }, encoding: "utf8", timeout: 20000 });
const pids = new Set();

try {
  // ---------- the parts ----------
  check(olderVersion("0.3.9", "0.3.20") && !olderVersion("0.3.20", "0.3.20") && !olderVersion("0.4", "0.3.99") && olderVersion("0.3", "0.3.1"), "versions compare number by number");
  check(outdated({ cli: true, version: "0.0.1" }, NEW) && outdated({ cli: true }, NEW) && !outdated({ cli: true, version: "0.0.2" }, NEW) && !outdated({ cli: true, version: "0.0.3" }, NEW), "an agentbook-cli is outdated when it's older than the plugin, or from before it said its version");
  check(!outdated({ name: "agentbook" }, NEW) && !outdated(null, NEW), "something else on its port isn't");
  const clean = cleanEnv({}, env);
  check(!["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "AGENTBOOK_LAUNCH_ID", "AGENTBOOK_LABEL"].some((k) => k in clean), "agentbook-cli starts without the session's own variables");
  check(clean.AGENTBOOK_HOME === HOME && clean.CLAUDE_CONFIG_DIR === env.CLAUDE_CONFIG_DIR && clean.PATH === env.PATH, "and with the person's");

  // ---------- an old agentbook-cli, running ----------
  const old = spawn(process.execPath, [path.join(OLD, "cli", "main.mjs"), "run"], { env, stdio: "ignore", detached: true });
  old.unref();
  check(await until(async () => (await health())?.version === "0.0.1"), "agentbook-cli says its version and pid (GET /api/health)");
  const was = await health();
  pids.add(was?.pid);
  check(was?.pid === old.pid, "(the pid is its own)");

  // ---------- a session on the newer plugin starts ----------
  const r = hook(NEW);
  check(r.stdout.trim() === "true", `its hook says agentbook-cli is up${r.stderr ? ` (${r.stderr.trim().split("\n").pop()})` : ""}`);
  // (It answers once it's done starting.)
  let now = null;
  await until(async () => (now = await health())?.version === "0.0.2");
  if (now?.pid) pids.add(now.pid);
  check(now?.version === "0.0.2" && now.pid !== was.pid, "the old agentbook-cli was stopped, and the newer one started in its place");
  check(await until(async () => !isAlive(was.pid), 3000), "the old one's process is gone");

  // ---------- a session on the older plugin starts ----------
  const back = hook(OLD);
  let after = null;
  await until(async () => !!(after = await health()));
  check(back.stdout.trim() === "true" && after?.version === "0.0.2" && after.pid === now.pid, "a session on the older plugin leaves the newer agentbook-cli be");
  const same = hook(NEW);
  check(same.stdout.trim() === "true" && (await health())?.pid === now.pid, "and one on the same plugin too");
} catch (e) {
  check(false, `crashed: ${e.stack}`);
} finally {
  // Whatever answers on its port now is the test's too.
  const last = await health();
  if (last?.pid) pids.add(last.pid);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  await until(async () => !(await health()), 4000);
  if (failures) console.log(`\nagentbook-cli's log:\n${(() => { try { return fs.readFileSync(path.join(HOME, "cli", "cli.log"), "utf8").split("\n").slice(-25).join("\n"); } catch { return "(none)"; } })()}`);
  fs.rmSync(BASE, { recursive: true, force: true });
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
