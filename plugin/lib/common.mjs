// Shared by the MCP server and the hooks: who this Claude Code session is, and how to reach agentbook.
// Nothing here may write to stdout: the MCP server speaks JSON-RPC on stdout.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BIRDS } from "../shared/ids.mjs";
import { AUTH_HEADER, PROOF_HEADER, proofOk, signRequest } from "../shared/local-auth.mjs";

export const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PORT = Number(process.env.AGENTBOOK_PORT || 4320);
export const BASE_URL = (process.env.AGENTBOOK_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
export const HOME = process.env.AGENTBOOK_HOME || path.join(os.homedir(), ".agentbook");
// The logs of what this machine starts: agentbook-cli's in its folder, agentbook-server's (agentbook up) in its.
export const CLI_LOG = path.join(HOME, "cli", "cli.log");
export const SERVER_LOG = () => path.join(process.env.AGENTBOOK_SERVER_HOME || path.join(HOME, "server"), "server.log");
// A hub on another machine wants its token; a local server doesn't need one.
const TOKEN = process.env.AGENTBOOK_TOKEN || "";
const isLocal = (url) => /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(url);
const IS_LOCAL = isLocal(BASE_URL);
// What says a call comes from this person: the key agentbook-cli keeps in its folder (cli/local.key), which a call
// is signed with and never shows (shared/local-auth.mjs). Read each time, as what calls it can start before
// agentbook-cli has made it.
export function localKey() {
  try {
    return fs.readFileSync(path.join(HOME, "cli", "local.key"), "utf8").trim();
  } catch {
    return "";
  }
}

// Whether what listens on a port here is this person's: { own: true, pid } (pid null where it can't be told),
// { own: false } (someone else's), or { own: null } (this machine can't say). macOS and the BSDs: lsof, which shows
// another user's sockets only to root, so one it doesn't show is someone else's. Linux: /proc/net/tcp, which says
// whose each socket is.
export function ownListener(port, { lsof = runLsof, proc = readProcNet } = {}) {
  if (process.platform === "linux") {
    const text = proc();
    if (text == null) return { own: null };
    const uids = procListeners(text, port);
    return uids.length ? { own: uids.every((u) => u === process.getuid()), pid: null } : { own: null };
  }
  if (process.platform === "win32") return { own: null };
  const out = lsof(port);
  if (out == null) return { own: null };
  const found = lsofListeners(out);
  if (!found.length) return { own: false };
  return found.every((l) => l.uid === process.getuid()) ? { own: true, pid: found[0].pid } : { own: false };
}
function runLsof(port) {
  try {
    return execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpu"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    // It says nothing, and exits 1, when it shows no listener on that port.
    return e.status === 1 && !String(e.stdout || "").trim() ? "" : null;
  }
}
// lsof -F pu: a "p<pid>" line for each process, then "u<uid>". -> [{ pid, uid }]
export function lsofListeners(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    if (line.startsWith("p")) out.push({ pid: Number(line.slice(1)), uid: null });
    else if (line.startsWith("u") && out.length) out.at(-1).uid = Number(line.slice(1));
  }
  return out.filter((l) => l.pid > 0 && Number.isInteger(l.uid));
}
function readProcNet() {
  const parts = ["/proc/net/tcp", "/proc/net/tcp6"].map((f) => {
    try {
      return fs.readFileSync(f, "utf8");
    } catch {
      return null;
    }
  });
  return parts.every((p) => p == null) ? null : parts.filter(Boolean).join("\n");
}
// /proc/net/tcp(6): the uids of the sockets listening (state 0A) on a port. -> [uid]
export function procListeners(text, port) {
  const hex = Number(port).toString(16).toUpperCase().padStart(4, "0");
  const uids = [];
  for (const line of String(text).split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length > 7 && f[1]?.endsWith(`:${hex}`) && f[3] === "0A") uids.push(Number(f[7]));
  }
  return uids;
}

// Once a call here has had its agentbook-cli's proof, its folder says so (cli/proved, this person's alone, as the
// folder is): from then on an answer with none isn't taken on its port, however much what listens is this person's,
// as only an agentbook-cli from before signed calls answers so, and this machine's isn't one any more. A folder made
// anew (uninstall --purge, then installing again) has none until its first proof. Hooks from before this don't read
// it, so going back to an older plugin works as that plugin did.
const PROVED = () => path.join(HOME, "cli", "proved");
let provedSeen = false;
export function provedHere() {
  if (provedSeen) return true;
  try {
    const st = fs.lstatSync(PROVED());
    return (provedSeen = st.isFile() && st.uid === (process.getuid?.() ?? st.uid));
  } catch {
    return false;
  }
}
function noteProved() {
  if (provedHere()) return;
  try {
    fs.writeFileSync(PROVED(), `agentbook-cli here proved it holds local.key, ${new Date().toISOString()}\n`, { flag: "wx", mode: 0o600 });
    provedSeen = true;
  } catch {}
}

// What answered a call on this machine's loopback is its agentbook-cli: it proved it holds the key ("proof"); it
// didn't, as an agentbook-cli from before signed calls doesn't, but what listens is this person's ("own", with its
// pid), until this machine's agentbook-cli has proved itself once (provedHere); or there's no telling, as on a
// machine that has no key yet ("unchecked"). Anything else is something other than agentbook-cli holding its port,
// and what it says isn't used: this throws. Only for its own port (PORT): an agentbook-cli elsewhere here, with a
// folder of its own, can't prove it holds this folder's key.
export const NOT_AGENTBOOK = "not-agentbook";
export function vouch(res, key, nonce, port, who = ownListener, { proved = provedHere, note = noteProved } = {}) {
  const proof = res.headers.get(PROOF_HEADER);
  if (key && proof) {
    if (!proofOk(key, nonce, proof)) throw notAgentbook(port);
    if (port === PORT) note();
    return { how: "proof" };
  }
  const l = who(port);
  if (port === PORT && proved()) throw unproved(port, l.own === true ? l.pid || null : null);
  if (l.own === true) return { how: "own", pid: l.pid || null };
  if (l.own === false) throw notAgentbook(port);
  return { how: "unchecked" };
}
const notAgentbook = (port) =>
  Object.assign(new Error(`Something other than this machine's agentbook-cli answers on port ${port}, so agentbook doesn't use what it says. Stop it, and agentbook-cli up starts agentbook-cli again.`), { code: NOT_AGENTBOOK });
// `pid`: what listens, when it's this person's, for stopUnproved.
const unproved = (port, pid) =>
  Object.assign(new Error(`What answers on port ${port} doesn't prove it's this machine's agentbook-cli, as agentbook-cli here has before, so agentbook doesn't use what it says. agentbook-cli up stops an older agentbook-cli there and starts this one; anything else, stop it.`), { code: NOT_AGENTBOOK, unproved: true, pid });

// What answers there as agentbook-cli does without proving it, once this machine's has (vouch): an agentbook-cli from
// before signed calls (after going back to an older plugin, then forward again), or something of this person's
// posing as one. Nothing it says is used: it's stopped by the pid that listens, so this one can start in its place.
// What doesn't say it's agentbook-cli is left alone. -> whether it went.
export async function stopUnproved(e, ms = 2500) {
  if (e?.code !== NOT_AGENTBOOK || !e.unproved || !e.pid) return false;
  const at = `http://127.0.0.1:${PORT}/api/health`;
  const said = await fetch(at, { signal: AbortSignal.timeout(700) }).then((r) => r.json()).catch(() => null);
  if (said?.name !== "agentbook" || said?.cli !== true) return false;
  try {
    process.kill(e.pid, "SIGTERM");
  } catch {
    return false;
  }
  for (const until = Date.now() + ms; Date.now() < until; ) {
    await new Promise((r) => setTimeout(r, 100));
    if (await fetch(at, { signal: AbortSignal.timeout(500) }).then(() => false, (err) => err.cause?.code === "ECONNREFUSED")) return true;
  }
  return false;
}

// A call to agentbook-cli on this machine: signed, and its answer checked (vouch). -> { res, how, pid }. To an
// address elsewhere (a hub), as it was.
export async function localFetch(url, { method = "GET", body, headers = {}, signal } = {}) {
  const local = isLocal(url);
  const key = local ? localKey() : "";
  const u = new URL(url);
  const sig = key ? signRequest(key, method, u.pathname + u.search, body ?? "") : null;
  const res = await fetch(url, { method, headers: { ...headers, ...(sig ? { [AUTH_HEADER]: sig.auth } : {}) }, body, signal });
  if (!local) return { res, how: "unchecked" };
  try {
    return { res, ...vouch(res, key, sig?.nonce, Number(u.port) || 80) };
  } catch (e) {
    res.body?.cancel().catch(() => {});
    throw e;
  }
}

export const bird = (key) => BIRDS[createHash("sha1").update(String(key)).digest()[0] % BIRDS.length];
export { BIRDS };

export const isVersion = (v) => typeof v === "string" && v.length <= 40 && /^\d+(\.\d+)*$/.test(v);
// The version of the agentbook plugin in a folder (its .claude-plugin/plugin.json), or null.
export function pluginVersion(root) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf8")).version;
    return isVersion(v) ? v : null;
  } catch {
    return null;
  }
}
// Whether version `a` ("0.3.20") is older than `b`, by each number in turn.
export function olderVersion(a, b) {
  const x = String(a).split(".").map(Number);
  const y = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  return false;
}
// The oldest Node agentbook runs on: node:sqlite needs no flag from here on (23.4 on the 23 line). The same as in
// package.json and bin/agentbook-cli, which says it for a Node too old to read this.
export const NODE_MIN = "22.13";
export const nodeTooOld = (v = process.versions.node) => olderVersion(v, NODE_MIN) || (v.startsWith("23.") && olderVersion(v, "23.4"));
const NODE_TOO_OLD = () => `it needs Node ${NODE_MIN} or newer, and this is v${process.versions.node}`;
export const NODE_NEEDED = () => `agentbook-cli can't run here: ${NODE_TOO_OLD()}. Update Node (https://nodejs.org), then try again.`;
// The version of the code this process runs: the plugin folder this file is in (agentbook-cli's, a session's hooks').
export const VERSION = pluginVersion(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));

// What's one Claude Code session's own in its environment, or one agentbook thread's: never for agentbook-cli, which
// a session's hook may start, nor for what agentbook-cli starts (a session that got them would think it's nested in
// that one, or post as it). The person's own settings stay (CLAUDE_CONFIG_DIR, CLAUDE_CODE_USE_BEDROCK, …).
export const SESSION_VARS = /^(CLAUDECODE|CLAUDE_CODE_ENTRYPOINT|CLAUDE_CODE_SSE_PORT|CLAUDE_CODE_EXECPATH|CLAUDE_CODE_CHILD_SESSION|CLAUDE_PROJECT_DIR|CLAUDE_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA|CLAUDE_ENV_FILE|CLAUDE_PID|CLAUDE_JOB_DIR|CLAUDE_EFFORT|CLAUDE_CODE_MESSAGING_\w+|CLAUDE_CODE_SESSION_\w+|AGENTBOOK_(CHANNEL|PID|LAUNCH_ID|LABEL|PROC))$/;
export function cleanEnv(extra = {}, from = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(from)) if (!SESSION_VARS.test(k)) env[k] = v;
  return { ...env, ...extra };
}

function ps(pid, field) {
  try {
    return execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

// The Claude Code process this hook or MCP server belongs to.
// Walk up the process tree first: CLAUDE_PID can be inherited from a parent session (e.g. `claude -p` run from Bash).
export function claudePid() {
  if (process.env.AGENTBOOK_PID) return Number(process.env.AGENTBOOK_PID); // tests and unusual setups
  let pid = process.ppid;
  for (let i = 0; i < 6 && pid > 1; i++) {
    // "claude", or a background session's worker, which names itself "claude bg-spare" and the like.
    if (/^(\S*\/)?claude(\s|$)/.test(ps(pid, "comm"))) return pid;
    pid = Number(ps(pid, "ppid")) || 0;
  }
  if (process.env.CLAUDE_PID && Number(process.env.CLAUDE_PID) > 1) return Number(process.env.CLAUDE_PID);
  return process.ppid;
}

export { typedPart } from "../shared/text.mjs";

// Live delivery needs Claude Code started with the agentbook channel. Claude Code hides its own arguments
// from ps, so the launcher says so instead: `agentbook claude` sets AGENTBOOK_CHANNEL=1.
export function channelMode() {
  return process.env.AGENTBOOK_CHANNEL === "1";
}

// `claude -p` runs (scripts, title generators) stay off agentbook unless AGENTBOOK_HEADLESS=1.
export function headless() {
  const entry = process.env.CLAUDE_CODE_ENTRYPOINT;
  return !!entry && entry !== "cli" && process.env.AGENTBOOK_HEADLESS !== "1";
}

// An agent agentbook runs through a driver (Codex, Hermes) starts this MCP server with its post named in
// AGENTBOOK_PROC: `codex:<thread>`, or `launch:<lid>` before its post exists. The driver registers the post
// and hands it what the person sends, so the MCP server only writes.
export function driven() {
  return /^(launch|codex|hermes|openclaw|dsh):/.test(process.env.AGENTBOOK_PROC || "");
}

// The agent is Claude itself (one profile), and this process is one of its sessions.
// proc: this Claude Code process, which is how hooks and the MCP server address the server.
// label: the session's short name, from AGENTBOOK_LABEL, else a bird. named: which of the two it is.
export function identity() {
  const pid = claudePid();
  const host = os.hostname().split(".")[0];
  const proc = driven() ? process.env.AGENTBOOK_PROC : `${host}-${pid}`;
  const given = (process.env.AGENTBOOK_LABEL || "").trim();
  const label = given || bird(proc);
  const agent = (process.env.AGENTBOOK_AGENT || "Claude").trim();
  return { proc, label, named: !!given, pid, host, agent };
}

export function gitInfo(cwd) {
  const run = (args) => {
    try {
      return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      return "";
    }
  };
  const top = run(["rev-parse", "--show-toplevel"]);
  // A linked worktree (.claude/worktrees/…) belongs to its main checkout's project; its branch tells them apart.
  const common = top && run(["rev-parse", "--git-common-dir"]);
  const root = common && path.basename(common) === ".git" ? path.dirname(path.resolve(cwd, common)) : top;
  return { root: root || cwd, repo: path.basename(root || cwd), branch: top ? run(["rev-parse", "--abbrev-ref", "HEAD"]) : "" };
}

// A test on a busy machine can give these calls longer than a session's hooks get: a hook that stops waiting skips
// what it had left, which is a fair price in a session and a failed check in a test.
const PATIENCE_MS = Number(process.env.AGENTBOOK_API_MS || 0);

export async function api(method, route, body, opts) {
  return (await apiCall(method, route, body, opts)).data;
}
// The same, with how its answer was vouched for: { data, how, pid }.
export async function apiCall(method, route, body, { timeout = 4000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(timeout, PATIENCE_MS));
  try {
    const { res, how, pid } = await localFetch(BASE_URL + route, {
      method,
      headers: { ...(body ? { "content-type": "application/json" } : {}), ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    if (!res.ok) throw new Error((data && data.error) || `agentbook answered HTTP ${res.status}`);
    return { data, how, pid };
  } catch (err) {
    if (err.name === "AbortError") throw new Error(`agentbook didn't answer within ${timeout} ms (${BASE_URL})`);
    if (err.cause?.code === "ECONNREFUSED") throw new Error(`agentbook isn't running at ${BASE_URL}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Whether this machine's agentbook-cli answers: "up" (with what it says of itself: its version, and the pid to stop
// it by), "busy" (something listens but didn't answer in time, as on a loaded machine), "down" (nothing listens), or
// "other" (something that isn't agentbook-cli holds its port).
async function cliHealth() {
  try {
    const { data, how, pid } = await apiCall("GET", "/api/health", null, { timeout: 700 });
    // The pid that listens, when that's what said it's this person's; else the one it gave, with the key.
    return { state: "up", health: data, pid: (how === "own" && pid) || data?.pid || null };
  } catch (e) {
    if (e.code === NOT_AGENTBOOK) return { state: "other", error: e };
    return { state: /isn't running/.test(e.message) ? "down" : "busy" };
  }
}
const cliState = async () => (await cliHealth()).state;
export const healthy = async () => (await cliState()) === "up";

// Whether the agentbook-cli that answered is older than the plugin in `root` (an update since it started): one from
// before it said its version is too. Not something else on its port (an agentbook from before the split).
export function outdated(health, root) {
  const mine = pluginVersion(root);
  if (!mine || !health?.cli) return false;
  return !health.version || olderVersion(health.version, mine);
}

// Stop an agentbook-cli, by its pid (as cliHealth has it, else the one it gave), and wait up to `ms` for it to go.
// -> whether it went.
export async function stopCli(health, ms = 2500, pid = health?.pid) {
  if (!pid) pid = (await api("GET", "/api/status", null, { timeout: 700 }).catch(() => null))?.pid;
  if (!pid) return false;
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  for (const until = Date.now() + ms; Date.now() < until; ) {
    await new Promise((r) => setTimeout(r, 100));
    if ((await cliState()) === "down") return true;
  }
  return false;
}

// Start this machine's agentbook-cli if nothing listens on its port yet. Several sessions may race; the losers exit
// on EADDRINUSE. One that's there but slow isn't started again: another copy can't take its port, and loading one
// on a machine that's already slow made a session's SessionStart hook run out of time before it registered.
// One older than the plugin it would start (an update since it started) is stopped, and this one started in its place:
// a newer one, or one as new, is left be, so a session on an older plugin never takes it back.
// It starts with the person's environment, not this session's (cleanEnv).
// -> { up, why }: `why` when it can't start, to say so. One that's only slow says nothing: it may yet come up.
export async function startCli() {
  // In dev mode a session's plugin is a copy (see cli/plugin-copy.mjs); the CLI runs from the repo's plugin folder.
  const root = process.env.AGENTBOOK_PLUGIN_DIR || PLUGIN_ROOT;
  const now = await cliHealth();
  // Something else holds its port: nothing it says is used, and agentbook-cli can't start until it's gone. One that
  // says it's agentbook-cli but can't prove it, on a machine whose agentbook-cli has, is stopped (stopUnproved).
  if (now.state === "other" && !(IS_LOCAL && (await stopUnproved(now.error)))) throw now.error;
  if (now.state === "busy") return { up: true };
  if (now.state === "up" && !(IS_LOCAL && outdated(now.health, root) && (await stopCli(now.health, 2500, now.pid)))) return { up: true };
  if (!IS_LOCAL) return { up: false };
  if (nodeTooOld()) return { up: false, why: NODE_TOO_OLD() };
  // Whether it stopped, and with an error. One that lost the race to another stops without one, and that other comes up.
  let ended = false;
  let failed = false;
  try {
    const log = openLog(CLI_LOG);
    const child = spawn(process.execPath, [path.join(root, "cli", "main.mjs"), "run"], { detached: true, stdio: ["ignore", log, log], env: cleanEnv() });
    const stopped = (code) => {
      ended = true;
      failed = code !== 0;
    };
    child.on("error", () => stopped(1));
    child.on("exit", stopped);
    child.unref();
  } catch (e) {
    return { up: false, why: e.message };
  }
  for (let i = 0; i < 25 && !failed; i++) {
    await new Promise((r) => setTimeout(r, 120));
    if ((await cliState()) !== "down") return { up: true };
  }
  return ended ? { up: false, why: `it stopped as it started, and its log says why: ${CLI_LOG}` } : { up: false };
}
export const ensureCli = async () => (await startCli()).up;

// A log to start something with, to append to. Until 2026-10-17 both logs were at the top of agentbook's folder:
// one still there goes first (nothing writes to it now, as what wrote it is what's being started).
export function openLog(file) {
  const old = path.join(HOME, path.basename(file));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (fs.existsSync(old)) {
      if (fs.existsSync(file)) fs.appendFileSync(old, fs.readFileSync(file));
      fs.renameSync(old, file);
    }
  } catch {}
  // Its person's only (what its sessions did is in it), one made before this too.
  const fd = fs.openSync(file, "a", 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
  } catch {}
  return fd;
}

// The conversation a Claude Code process is in, as Claude Code keeps it (sessions/<pid>.json in its folder), for a
// hello with no hook input to say so: the MCP server's, when a tool call finds its session isn't registered. Without
// it agentbook makes a thread of the process's own: a session woken into a new process whose SessionStart hook never
// registered it went on as a second thread, one nothing sent to could reach and that couldn't be written to once it
// ended. A file an earlier process with the same pid left behind is older than this process, so it isn't taken for
// this one's.
export function claudeSession(pid) {
  try {
    const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
    const s = JSON.parse(fs.readFileSync(path.join(dir, "sessions", `${pid}.json`), "utf8"));
    if (typeof s.sessionId !== "string" || !/^[\w-]{8,80}$/.test(s.sessionId) || (s.pid !== undefined && Number(s.pid) !== Number(pid))) return null;
    const lstart = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 1000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" } }).trim();
    const started = Date.parse(lstart);
    // Claude Code dates it when the process takes the conversation: a background session's worker starts earlier.
    return started > 0 && Number(s.startedAt) >= started - 2000 ? s.sessionId : null;
  } catch {
    return null;
  }
}

// What a session hears on a machine that isn't logged in to a server yet: that it isn't a thread, and how to log in.
export const NOT_LOGGED_IN = `agentbook is installed on this machine, but it isn't logged in to a server, so this session isn't a thread and the ab_* tools don't work. To log in, run: node "${path.join(PLUGIN_ROOT, "cli", "main.mjs")}" login <server address>`;

// What a session hears when agentbook-cli can't start (startCli's `why`).
export const CLI_DOWN = (why) => `agentbook: agentbook-cli can't start on this machine (${why}), so this session isn't a thread and the ab_* tools don't work. Tell the person in a line, once, then go on with their task.`;

// What a thread hears once its server stops taking this machine's login (a revoked token, say): what it does stays here
// until the server takes it again or the machine logs in again, and goes up then.
export const LOGIN_LOST = (server) => `agentbook: ${server} stopped taking this machine's login, so what this thread does stays on this machine, and nobody can answer it on agentbook, until the server takes it again (it's tried once more as each new thread starts) or the machine logs in again. To log in, run: node "${path.join(PLUGIN_ROOT, "cli", "main.mjs")}" login ${server}\nTell the person once, in a line, and go on with their task.`;

// Register this session. Hooks pass Claude Code's session id and transcript; the server keys posts by them,
// so a resumed conversation lands on its old post and /clear starts a new one. The MCP server has neither, so
// the session id is looked up (claudeSession).
export async function hello(extra = {}) {
  const me = identity();
  const cwd = extra.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const known = extra.session_id || driven() ? null : claudeSession(me.pid);
  const res = await api("POST", "/api/hello", { ...me, cwd, ...gitInfo(cwd), channel: channelMode(), launch: process.env.AGENTBOOK_LAUNCH_ID || undefined, ...extra, ...(known ? { session_id: known } : {}) });
  return { ...me, ...res };
}

// Files the person attached to a message, named with where to read them.
export const attached = (files) => (files?.length ? `\nAttached files:\n${files.map((f) => `- ${f.name}: ${f.path}`).join("\n")}` : "");

// Text in a code fence longer than any run of backticks in it.
const fenced = (text) => {
  const ticks = "`".repeat(Math.max(3, ...[...String(text).matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${ticks}\n${text}\n${ticks}`;
};
const took = (ms) => {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
};
// How a code block of the thread's that the person ran with ▶ went (plugin/cli/runs.mjs): the code, how it ended,
// and the end of what it printed.
function ran(e) {
  const after = e.started && e.ended ? ` after ${took(Date.parse(e.ended) - Date.parse(e.started))}` : "";
  const how =
    e.state === "stopped" ? (e.error ? `it stopped. ${e.error}` : `they stopped it${after}`)
    : e.state === "failed" ? `it didn't finish. ${e.error || "agentbook couldn't say why."}`
    : e.exit != null ? `it ended with exit code ${e.exit}${after}${e.error ? `. ${e.error}` : ""}`
    : `it ended${e.signal ? ` on ${e.signal}` : ""}${after}${e.error ? `. ${e.error}` : ""}`;
  const out = String(e.out || "").replace(/\s+$/, "");
  return [
    `${e.by ? `@${e.by}` : "The person"} ran a code block from ${e.from === "human" ? "a message of theirs" : "your message"} with ▶ on agentbook, ${e.terminal ? "in this thread's terminal" : "in a shell of its own"}: ${how}${/[.!?]$/.test(how) ? "" : "."}`,
    fenced(e.code || ""),
    out ? `${e.cut ? "The end of what it printed" : "What it printed"}:\n${fenced(out)}` : "It printed nothing.",
  ].join("\n");
}

// How describe() tells an agent about an answer to its question, whoever answered it: agentbook's words, which the
// question shows answered, never a message of yours.
export const ANSWER_WORDS = /^(The person answered "|The person skipped your question "|Your question "[\s\S]*" timed out, so its default answer applies: |The person archived this thread, which closed your question ")/;

// Plain-language lines for events from agentbook, for hooks and ab_inbox.
export function describe(event) {
  switch (event.type) {
    case "answer":
      if (event.by === "archived") return `The person archived this thread, which closed your question "${event.question}" unanswered. Decide yourself if it's safe to, or carry on without it.`;
      if (event.skipped) return `The person skipped your question "${event.question}". Decide yourself if it's safe to, or carry on without it.`;
      if (event.by === "default") return `Your question "${event.question}" timed out, so its default answer applies: ${event.value}`;
      if (event.file) return `The person answered "${event.question}" with a file: ${event.file.name}, saved at ${event.file.path} (read it from there)`;
      return `The person answered "${event.question}": ${event.value}`;
    case "message":
      return `Message from the person: ${event.text || "(no text)"}${attached(event.files)}`;
    case "file":
      return `The person sent you a file: ${event.name} (${event.size} bytes), saved at ${event.path}`;
    case "run":
      return ran(event);
    case "permission":
      return `Permission ${event.behavior === "allow" ? "allowed" : "denied"} from agentbook`;
    case "group":
      return event.text;
    default:
      return JSON.stringify(event);
  }
}
