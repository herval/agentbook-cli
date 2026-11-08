// agentbook-cli's commands, from this machine's shell:
//   login <server> [--name N]   log this machine in to an agentbook-server: approve the code it shows, signed in
//   logout                      revoke this machine's token on its server, and forget it
//   status                      the daemon: which server, whether it's reachable, what's waiting to go up
//   up, down                    start the daemon in the background, or stop it
//   allow|deny <folder>, gate, approve [id] [--no], log [n]    the gate (gate.mjs)
//   openclaw [pair <setup code> | pair --url wss://… --token T | off]   this machine's OpenClaw gateway, paired
//                               here, so its code or token never passes through the server
//   fold <copy> <thread>        a copy of a thread's conversation Claude Code started on a resume, made that thread
//                               again (the daemon's /local/fold): what it said, and the session it goes on in
//   claude …, dev …             Claude Code with agentbook's channel (bin/agentbook-cli, which never comes here)
//   help, version               what it can do, and which version this is: these two need no daemon and no login
//   local                    agentbook on this machine alone (`agentbook up`): a server on 127.0.0.1:4310 with its
//                               own data folder, the first account, this CLI logged in to it, and the page open

import { execFile, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { CLI_LOG, NOT_AGENTBOOK, PLUGIN_ROOT, PORT, SERVER_LOG, VERSION, cleanEnv, localFetch, openLog, outdated, stopCli, stopUnproved } from "../lib/common.mjs";
import { machineName } from "../shared/ids.mjs";
import { CLI_HOME, HOME } from "../shared/store.mjs";
import { createGate } from "./gate.mjs";
import { fingerprint, pinOf } from "./signatures.mjs";
import { codexConfig, installedByClaude, removeCodexEntry } from "./uninstall.mjs";
import { CORRUPT, DatabaseSync } from "../shared/db.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEVICE = () => path.join(HOME, "cli", "device.json");
const here = path.dirname(fileURLToPath(import.meta.url));
// In dev mode a session's plugin is a copy; the repo is beside AGENTBOOK_PLUGIN_DIR.
const pluginDir = () => process.env.AGENTBOOK_PLUGIN_DIR || PLUGIN_ROOT || path.resolve(here, "..");

// The daemon on this machine, when it's running: an answer from its loopback routes, or null. Signed with the key in
// its folder (cli/local.key), for what only agentbook-cli here may do, and never showing it: what answers proves it's
// agentbook-cli, or is this person's (one from before signed calls), or this throws (common.mjs, vouch). `pid`, from
// one from before, is the one listening, not what it says.
async function daemon(method, route, body, port = PORT) {
  let r;
  try {
    r = await localFetch(`http://127.0.0.1:${port}/api${route}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) });
  } catch (e) {
    if (e.code === NOT_AGENTBOOK) throw e;
    return null;
  }
  const json = await r.res.json().catch(() => ({}));
  // One from before takes the key only as it is, for what only agentbook-cli may do: it's started again from this
  // version rather than shown the key.
  if (r.res.status === 403 && r.how === "own") json.error = `${json.error || "agentbook-cli refused that."} agentbook-cli here is older than this command: run agentbook-cli down, then agentbook-cli up, and try again.`;
  return { status: r.res.status, ...json, ...(r.how === "own" && r.pid ? { pid: r.pid } : {}) };
}

// Plain HTTP is for loopback and tailnets only: anywhere else a device token would cross the network in the clear.
// AGENTBOOK_ALLOW_HTTP=1 allows it anyway, for whoever accepts that on a network of their own.
export function plainOk(url) {
  if (process.env.AGENTBOOK_ALLOW_HTTP === "1") return true;
  const h = url.hostname.replace(/^\[|\]$/g, "");
  if (["localhost", "127.0.0.1", "::1"].includes(h) || h.endsWith(".ts.net")) return true;
  const m = /^100\.(\d+)\.\d+\.\d+$/.exec(h);
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}

// Whether a server is on another machine (not loopback): then this machine takes what can run something only signed.
const elsewhere = (server) => {
  try {
    return !["localhost", "127.0.0.1", "::1"].includes(new URL(server).hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return !!server;
  }
};
const UNSIGNED_HERE = "Its server is on this machine, so it takes what that server sends unsigned.";
const NEEDS_KEYS = "It takes nothing that can run something until it keeps your passkeys: within a day of logging it in, turn on Signing for it from its row in Machines, on your profile. After that, log it in again.";
const saved = () => {
  try {
    return JSON.parse(fs.readFileSync(DEVICE(), "utf8"));
  } catch {
    return null;
  }
};
function save(link) {
  fs.mkdirSync(path.dirname(DEVICE()), { recursive: true });
  fs.writeFileSync(DEVICE(), JSON.stringify(link, null, 2) + "\n", { mode: 0o600 });
}

// The daemon, started in the background (as the hooks start it), and stopped.
// One older than this plugin (an update since it started) is stopped and started again from this one. It starts with
// the person's environment, not a session's it was run from (cleanEnv).
async function startDaemon() {
  // One that can't prove it's agentbook-cli, where this machine's has, is stopped first (common.mjs, stopUnproved).
  const h = await daemon("GET", "/health").catch(async (e) => {
    if (await stopUnproved(e)) return null;
    throw e;
  });
  if (h && !(outdated(h, pluginDir()) && (await stopCli(h, 2500, h.pid)))) return false;
  const log = openLog(CLI_LOG);
  spawn(process.execPath, [path.join(pluginDir(), "cli", "main.mjs"), "run"], { detached: true, stdio: ["ignore", log, log], env: cleanEnv() }).unref();
  for (let i = 0; i < 50; i++) {
    await sleep(150);
    if (await daemon("GET", "/health")) return true;
  }
  throw new Error(`agentbook-cli didn't start: see ${CLI_LOG}`);
}
async function stopDaemon() {
  let s;
  try {
    s = await daemon("GET", "/status");
  } catch (e) {
    if (await stopUnproved(e, 4000)) return true;
    throw e;
  }
  if (!s?.pid) return false;
  try {
    process.kill(s.pid, "SIGTERM");
  } catch {}
  for (let i = 0; i < 40 && (await daemon("GET", "/health")); i++) await sleep(100);
  return true;
}

// What only the person says, before anything goes up: whether the past goes too, and whether Codex gets agentbook's
// tools in its own settings. From flags, what they said at an earlier login, or asked here. With nobody at the
// terminal (an agent installing it), both are no. Kept in gate.json, which the server can't change.
async function consent(args, { server, print }) {
  const had = createGate({ home: HOME }).settings();
  const flag = (yes, no) => (args.includes(yes) ? true : args.includes(no) ? false : undefined);
  const codexHere = process.env.AGENTBOOK_CODEX !== "0" && process.env.AGENTBOOK_CODEX_MCP !== "0" && fs.existsSync(path.join(os.homedir(), ".codex"));
  const ask = process.stdin.isTTY && process.stdout.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  const yes = async (q) => /^y/i.test((await ask.question(`${q} [y/N] `)).trim());
  if (ask) print(`What your agents do from now on goes to ${server}, including your prompts and what they run. Whoever runs that server can read it.`);
  try {
    const history = flag("--history", "--no-history") ?? (had.history_from !== undefined ? had.history_from === null : ask ? await yes("Send your past sessions too (Codex and Hermes from the last 14 days, every OpenClaw session)?") : false);
    const tools = flag("--codex-tools", "--no-codex-tools") ?? had.codex_tools ?? (ask && codexHere ? await yes("Add agentbook's tools to Codex, with no approval needed for them, in ~/.codex/config.toml?") : false);
    print(`${history ? "Your past sessions go too." : "Only what happens from now on goes up: --history sends your past sessions too."}${codexHere ? ` ${tools ? "Codex gets agentbook's tools in its settings." : "Codex's settings stay as they are: --codex-tools adds agentbook's tools there."}` : ""}`);
    return { history_from: history ? null : had.history_from || new Date().toISOString(), codex_tools: tools, ...(args.includes("--private") ? { private_terminals: true } : {}) };
  } finally {
    ask?.close();
  }
}

// Log in: the server shows the person a code to approve on its page, signed in; the machine polls for its token.
async function login(args, { print }) {
  const raw = args.find((a) => !a.startsWith("--"));
  if (!raw) throw new Error("usage: agentbook-cli login <server> [--name <machine>] [--history] [--codex-tools] [--private] [--no-start]");
  const server = (/^https?:\/\//.test(raw) ? raw : `https://${raw}`).replace(/\/$/, "");
  const url = new URL(server);
  if (url.protocol === "http:" && !plainOk(url)) throw new Error(`${server} isn't HTTPS. A machine logs in over plain HTTP only to this machine or a tailnet (.ts.net, 100.64.0.0/10), so its token never crosses the network in the clear (AGENTBOOK_ALLOW_HTTP=1 allows it anyway).`);
  const asked = args.includes("--name") ? args[args.indexOf("--name") + 1] : null;
  const name = machineName(asked || process.env.AGENTBOOK_MACHINE || os.hostname().split(".")[0]);
  const start = await fetch(`${server}/api/devices/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }).catch((e) => {
    throw new Error(`Can't reach ${server}: ${e.cause?.code || e.message}`);
  });
  const req = await start.json().catch(() => ({}));
  if (!start.ok) throw new Error(req.error || `${server} answered HTTP ${start.status}.`);
  const agreed = await consent(args, { server, print });
  print(`To log this machine in as ${name}, open this, signed in, and approve it:\n\n    ${server}/#/connect?code=${req.code}\n\n(or enter ${req.code} under Settings → Agents → Add a machine). Waiting for you…`);
  const until = Date.now() + req.expires_in * 1000;
  while (Date.now() < until) {
    await sleep(2000);
    const r = await fetch(`${server}/api/devices/poll?poll=${encodeURIComponent(req.poll)}`).catch(() => null);
    if (!r) continue;
    const body = await r.json().catch(() => ({}));
    if (r.status === 404) throw new Error(body.error || "The request expired. Run agentbook-cli login again.");
    if (!body.token) continue;
    // Your passkeys, when you connected it to take only what you sign: from now on it takes what can run something
    // only signed by one of them.
    const pinned = body.pin ? pinOf(body.pin) : null;
    const as = machineName(body.name || name);
    createGate({ home: HOME }).agree(agreed); // before the login, which is what starts it
    save({ server, token: body.token, name: as, user: body.user });
    if (pinned) createGate({ home: HOME }).importKeys(pinned);
    // A daemon that's running logs in again, under its name; one that isn't starts, so the machine is On at once
    // rather than once a Claude Code session starts it. --no-start
    // leaves that to whoever runs it (the tests run their own).
    const was = await stopDaemon();
    // Something else keeps it running (the hub's machine, deploy/agentbook-server.sh): a copy started here would hold its port.
    const kept = process.env.AGENTBOOK_SUPERVISED === "1";
    const started = !kept && (was || !args.includes("--no-start")) && (await startDaemon(), true);
    const signs = pinned ? ` It takes what can run something only when one of your passkeys signs it (${pinned.keys.map((k) => k.name || fingerprint(k.spki)).join(", ")}).` : ` ${elsewhere(server) ? NEEDS_KEYS : UNSIGNED_HERE}`;
    const runs = kept ? " agentbook-cli starts again with it in a few seconds." : started ? (was ? " agentbook-cli restarted with it." : " agentbook-cli is running with it, so it's On there now.") : " Start agentbook-cli with agentbook-cli up to have it On there.";
    return `Logged in to ${server} as ${as}${as !== name ? ` (another machine there is ${name})` : ""}, @${body.user}'s.${signs}${runs}`;
  }
  throw new Error("Nobody approved it in time. Run agentbook-cli login again.");
}

async function logout() {
  // Its login, or one an `agentbook connect` from before the split saved (hub.json), which the daemon uses too.
  const old = (() => {
    try {
      const h = JSON.parse(fs.readFileSync(path.join(HOME, "hub.json"), "utf8"));
      return h.url && h.token ? { server: h.url, token: h.token, name: null } : null;
    } catch {
      return null;
    }
  })();
  const link = saved() || old;
  if (!link) return "This machine isn't logged in to an agentbook-server.";
  const r = await fetch(`${link.server}/api/cli/logout`, { method: "POST", headers: { authorization: `Bearer ${link.token}` } }).catch(() => null);
  fs.rmSync(DEVICE(), { force: true });
  fs.rmSync(path.join(HOME, "hub.json"), { force: true });
  // The next server to log it in names its owner again.
  createGate({ home: HOME }).unpin();
  await stopDaemon();
  return r?.ok ? `Logged out of ${link.server}: its token there no longer works.` : `Forgot ${link.server} here, but couldn't reach it to revoke this machine's token: remove ${link.name || "this machine"} under Machines on its page.`;
}

// Databases it couldn't read and moved aside (db.mjs), from its folder: said whether it's running or not, until the
// person deletes them.
function movedAside() {
  let names = [];
  try {
    names = fs.readdirSync(CLI_HOME);
  } catch {}
  return names.filter((n) => n.startsWith(`agentbook.db${CORRUPT}`) && !/-(wal|shm)$/.test(n)).map((n) => {
    const at = n.slice(`agentbook.db${CORRUPT}`.length);
    return `Its database couldn't be read, so on ${at.slice(0, 10)} at ${at.slice(11, 16).replace("-", ":")} UTC it was moved to ${path.join(CLI_HOME, n)} and a new one started. What its server has is safe; what hadn't reached it is only in that copy, which you can delete once you don't need it.`;
  });
}
const status = async () => [await running(), ...movedAside()].join("\n");
async function running() {
  const s = await daemon("GET", "/status");
  const link = saved();
  if (!s) return `agentbook-cli isn't running${link ? `; it's logged in to ${link.server} as ${link.name}` : ", and isn't logged in to a server"}. Start it with agentbook-cli up.`;
  const lines = [`agentbook-cli is running on ${s.machine} (pid ${s.pid}, port ${PORT}).`];
  const trouble = [];
  if (s.save_failing) trouble.push(`It can't save to its database: ${s.save_failing}. It goes on from memory, and what isn't saved is lost if it stops.`);
  if (s.fault && s.fault.message !== s.save_failing) trouble.push(`It kept going after an error, ${s.fault.count === 1 ? "once" : `${s.fault.count} times`}, last at ${s.fault.at.slice(11, 19)} UTC: ${s.fault.message}. Its log has the rest: ${CLI_LOG}`);
  if (!s.server) return [...lines, "It isn't logged in to an agentbook-server, so it follows nothing yet: agentbook-cli login <server>.", ...trouble].join("\n");
  const tried = s.signed_out_tried ? `, last at ${s.signed_out_tried.slice(0, 16).replace("T", " ")} UTC` : "";
  const away = s.signed_out ? `${s.server} stopped taking this machine's login (${s.signed_out}), so it only tries again once as each new thread starts${tried}. If it keeps refusing, log in again with agentbook-cli login ${s.server}.` : s.blocked || `Can't reach ${s.server}${s.error ? `: ${s.error}` : ""}.`;
  lines.push(s.connected ? `Connected to ${s.server}.` : away, s.waiting ? `${s.waiting} changes are waiting to go up.` : s.too_big ? "Everything else is sent." : "Everything's sent.");
  if (s.too_big) {
    const { count, last } = s.too_big;
    lines.push(`${count === 1 ? "1 change was" : `${count} changes were`} too big for its server even alone, so ${count === 1 ? "it" : "they"} didn't go up, and what came after did. The last: ${last.kind}${last.post ? ` on thread ${last.post}` : ""}, ${(last.bytes / 1024 / 1024).toFixed(1)} MB, on ${last.at.slice(0, 10)}.`);
  }
  if (s.parked) lines.push(`${s.parked} changes wait on the server: it couldn't take them yet, and will once it's updated.`);
  lines.push(...trouble);
  // A server restored from a backup older than what this machine's log keeps (uplink.mjs).
  if (s.gap) lines.push(`Its server lost changes ${s.gap.from}–${s.gap.to} (restored from an older backup?), and this machine no longer keeps them: threads from then may be missing parts there.`);
  if (s.update) lines.push(s.update);
  const said = (d) => (typeof d === "string" ? d : d?.enabled === false ? "off" : d?.connected ? "connected" : d?.error ? `not connected: ${d.error}` : "not connected");
  const g = await daemon("GET", "/gate").catch(() => null);
  const keyLine = keySaid(g);
  if (keyLine) lines.push(keyLine);
  for (const [k, d] of Object.entries(s.drivers || {})) lines.push(`  ${k}: ${said(d)}`);
  return lines.join("\n");
}

// What agentbook-cli's /api/gate says of the key on loopback, in words: what local_key waits for, or when it turned on
// by itself. Nothing with its server on this machine, or once its person turned it on.
function keySaid(g) {
  if (!g) return "";
  const at = (iso) => new Date(iso).toLocaleString();
  if (g.keyed && g.settings?.local_key_since) return `Every caller here needs agentbook-cli's key since ${at(g.settings.local_key_since)}: it turned on by itself once no thread from before was left.`;
  if (g.keyed !== false) return "";
  const w = g.key_waits;
  if (!w) return `Agents here reach agentbook-cli with no key, as you set. To ask every caller for it, set "local_key": true in ${path.join(HOME, "cli", "gate.json")}.`;
  const what = [w.threads.length ? `${w.threads.length === 1 ? "this thread ends" : "these threads end"} (${w.threads.join(", ")})` : "", w.lines ? "dsh's plugin from before closes its line" : ""].filter(Boolean);
  return `Agents here reach agentbook-cli with no key, as threads from before it did. It asks every caller for it by itself once ${what.join(" and ") || "a thread says hello or ends"}.`;
}

// The agentbook from before the split, on this machine's port with this data folder: stopped (by its pid), so
// agentbook-cli takes the port and the folder is moved in from. Anything else there is left alone, and said.
async function stopOld(print) {
  const h = await daemon("GET", "/health");
  if (!h || h.cli) return;
  if (h.name !== "agentbook" || (h.home && path.resolve(h.home) !== path.resolve(HOME))) throw new Error(`Something else answers on port ${PORT}: stop it, then run agentbook up again.`);
  const pid = Number(spawnSync("lsof", ["-ti", `tcp:${PORT}`, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout.trim().split("\n")[0]);
  if (!pid) throw new Error(`The agentbook from before the split answers on port ${PORT}, but its process can't be found: stop it, then run agentbook up again.`);
  print(`Stopping the agentbook from before the split (pid ${pid}, port ${PORT}).`);
  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 100 && (await daemon("GET", "/health")); i++) await sleep(100);
  if (await daemon("GET", "/health")) throw new Error(`It didn't stop (pid ${pid}): stop it, then run agentbook up again.`);
}
// A data folder from before the split (one database with accounts and everything, and no server data yet):
// moved in, once, after a copy of its database is kept (agentbook.db.before-split) to go back to. Its database is
// in cli/ once an agentbook-cli has started there since (cli-folder.mjs), else at the top.
function moveIn({ server, admin, print }) {
  const old = [path.join(CLI_HOME, "agentbook.db"), path.join(HOME, "agentbook.db")].find((f) => fs.existsSync(f));
  const serverDb = path.join(process.env.AGENTBOOK_SERVER_HOME || path.join(HOME, "server"), "agentbook.db");
  if (!old || fs.existsSync(serverDb)) return;
  let users = 0;
  try {
    const db = new DatabaseSync(old, { readOnly: true });
    users = db.prepare("select count(*) n from users").get().n;
    db.close();
  } catch {}
  if (!users) return;
  const keep = path.join(CLI_HOME, "agentbook.db.before-split");
  if (!fs.existsSync(keep)) {
    fs.mkdirSync(CLI_HOME, { recursive: true });
    const db = new DatabaseSync(old, { readOnly: true });
    db.exec(`vacuum into '${keep.replace(/'/g, "''")}'`);
    db.close();
  }
  print(`Moving in from ${HOME} (its database as it was is kept in ${keep}).`);
  const r = admin("import", HOME, "--server", server, "--name", machineName(process.env.AGENTBOOK_MACHINE || os.hostname().split(".")[0]));
  if (r.status !== 0) throw new Error(`Moving in didn't work: ${(r.stderr || r.stdout).trim()}`);
  print(r.stdout.trim());
}
// The agentbook plugin Claude Code has installed, when it's older than this one: its hooks, finding nothing on
// this machine's port, would start the agentbook it came with. Installed from this folder (its marketplace), it's
// updated: Claude Code keeps the old version for the sessions running on it, and new ones use this. Else, said.
function updatePlugin(print) {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const read = (f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, "plugins", f), "utf8"));
    } catch {
      return null;
    }
  };
  const installed = read("installed_plugins.json")?.plugins?.["agentbook@agentbook"]?.[0];
  let here = null;
  try {
    here = JSON.parse(fs.readFileSync(path.join(pluginDir(), ".claude-plugin", "plugin.json"), "utf8")).version;
  } catch {}
  if (!installed || !here || installed.version === here) return;
  const how = "claude plugin marketplace update agentbook && claude plugin update agentbook@agentbook";
  const source = read("known_marketplaces.json")?.agentbook?.source?.path;
  const repo = path.resolve(pluginDir(), "..");
  if (!source || path.resolve(source) !== repo) return print(`Claude Code has the agentbook plugin ${installed.version} installed; this is ${here}. Update it, and new sessions use it:\n\n    ${how}\n`);
  const claude = process.env.AGENTBOOK_CLAUDE || "claude";
  const run = (...a) => spawnSync(claude, a, { encoding: "utf8", timeout: 120e3 });
  const r = [run("plugin", "marketplace", "update", "agentbook"), run("plugin", "update", "agentbook@agentbook")].find((x) => x.status !== 0);
  const now = read("installed_plugins.json")?.plugins?.["agentbook@agentbook"]?.[0]?.version;
  if (!r && now === here) return print(`Updated the agentbook plugin Claude Code has installed from ${installed.version} to ${here}: sessions you start from now on use it, and running ones carry on as they are.`);
  const why = r ? `: ${(r.stderr || r.stdout || r.error?.message || "").trim().split("\n").pop()}` : "";
  print(`Couldn't update the agentbook plugin Claude Code has installed (${now || installed.version})${why}. Update it with:\n\n    ${how}\n`);
}
// The plugin folder sessions this CLI starts load (AGENTBOOK_PLUGIN_DIR, in dev mode), kept for when the CLI is
// started again without being told (by a hook, after a reboot).
function keepPluginDir() {
  if (!process.env.AGENTBOOK_PLUGIN_DIR) return;
  const file = path.join(HOME, "cli", "settings.json");
  let was = {};
  try {
    was = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...was, plugin_dir: process.env.AGENTBOOK_PLUGIN_DIR }, null, 2) + "\n");
}

// agentbook on this machine alone: a server on 127.0.0.1:4310 (its data in ~/.agentbook/server), the first
// account made at its setup link, and this CLI logged in to it as that account's, then the page. From an agentbook
// from before the split, it's the move: that one stopped, its folder moved in.
async function local(args, { print }) {
  const port = Number(process.env.AGENTBOOK_SERVER_PORT || 4310);
  const server = `http://127.0.0.1:${port}`;
  const repo = path.resolve(pluginDir(), "..");
  const serverMain = path.join(repo, "server", "main.mjs");
  const admin = (...a) => spawnSync(process.execPath, [path.join(repo, "server", "admin.mjs"), ...a], { encoding: "utf8", env: process.env });
  if (!fs.existsSync(serverMain)) throw new Error(`agentbook-server isn't next to this agentbook-cli (no ${serverMain}). Log in to one with agentbook-cli login <server>.`);
  const up = async () => (await fetch(`${server}/api/health`, { signal: AbortSignal.timeout(1500) }).catch(() => null))?.ok;
  await stopOld(print);
  keepPluginDir();
  if (!(await up())) moveIn({ server, admin, print });
  let setup = null;
  if (!(await up())) {
    setup = crypto.randomBytes(18).toString("base64url");
    const log = openLog(SERVER_LOG());
    // Through bin/agentbook-server, so it runs under Node's permission model as anywhere else.
    const bin = path.join(repo, "bin", "agentbook-server");
    const [cmd, argv] = fs.existsSync(bin) ? ["/bin/sh", [bin]] : [process.execPath, [serverMain]];
    spawn(cmd, argv, { detached: true, stdio: ["ignore", log, log], env: { ...process.env, AGENTBOOK_SERVER_PORT: String(port), AGENTBOOK_SETUP_TOKEN: setup } }).unref();
    for (let i = 0; i < 60 && !(await up()); i++) await sleep(150);
    if (!(await up())) throw new Error(`agentbook-server didn't start: see ${SERVER_LOG()}`);
  }
  // The first account, made in the browser.
  if (Number(admin("accounts").stdout.trim() || 0) === 0) {
    const link = setup ? `${server}/#/setup/${setup}` : null;
    print(link ? `Make your account (agentbook's first, its admin):\n\n    ${link}\n` : `Make your account with the setup link in ${SERVER_LOG()}, or with agentbook-server adduser <you>.`);
    if (link && process.platform === "darwin" && !args.includes("--no-open")) execFile("open", [link], () => {});
    for (let i = 0; Number(admin("accounts").stdout.trim() || 0) === 0; i++) {
      if (i > 600) throw new Error("No account was made. Run agentbook up again when you're ready.");
      await sleep(1000);
    }
  }
  // This machine, logged in to it.
  const link = saved();
  if (!link || link.server !== server) {
    const r = admin("machine", machineName(process.env.AGENTBOOK_MACHINE || os.hostname().split(".")[0]));
    if (r.status !== 0) throw new Error(r.stderr.trim() || "agentbook-server couldn't log this machine in.");
    const d = JSON.parse(r.stdout);
    save({ server, token: d.token, name: d.name, user: d.user, local: true });
    await stopDaemon();
  }
  await startDaemon();
  updatePlugin(print);
  if (process.platform === "darwin" && !args.includes("--no-open") && !setup) execFile("open", [server], () => {});
  return `agentbook is running: the page at ${server}, this machine's sessions at http://127.0.0.1:${PORT}.`;
}

// This machine's OpenClaw gateway: how it's reached, pairing with one (a setup code from `openclaw qr
// --setup-code-only`, or its address and token), or forgetting it.
// Agents that run on their vendor's computers (Claude Agent, Devin), connected from this machine: the key comes in on
// stdin (never an argument, which a process list and a shell's history would keep) and doesn't pass through the server.
const REMOTE_USAGE = "usage: agentbook-cli remote [status | connect claude-agent [--budget <dollars>] | connect devin [--org <id>] [--budget <ACUs>] | off claude-agent | off devin]; the key comes in on stdin, with a GitHub token on the next line if Claude Agent is to push";
async function remoteCommand([sub, vendor, ...args]) {
  const none = "agentbook-cli isn't running: agentbook-cli up.";
  if (!sub || sub === "status") {
    const r = await daemon("GET", "/local/remote");
    if (!r) return none;
    return ["claude-agent", "devin"].filter((k) => r[k]).map((k) => [k, r[k]]).map(([k, c]) => `${k}: ${c.connected ? "connected" : "not connected"}${c.org ? ` (organization ${c.org})` : ""}${c.github ? ", with a GitHub token" : ""}${c.budget ? `, $${c.budget} a thread` : ""}${c.error ? `: ${c.error}` : ""}`).join("\n");
  }
  if (!["claude-agent", "devin"].includes(vendor) || !["connect", "off"].includes(sub)) throw new Error(REMOTE_USAGE);
  const send = async (body) => {
    const r = await daemon("POST", "/local/remote", body);
    if (!r) throw new Error(none);
    if (r.error) throw new Error(r.error);
    return r;
  };
  if (sub === "off") {
    await send({ vendor, disconnect: true });
    return `Forgot ${vendor}'s key on this machine. Its threads stay on agentbook.`;
  }
  if (process.stdin.isTTY) throw new Error("Pipe its key in, so it stays out of your shell's history: pbpaste | agentbook-cli remote connect " + vendor);
  const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
  // Its key on the first line, and a GitHub token, if there's one, on the second.
  const [key, github_token] = (await new Response(process.stdin).text()).split("\n").map((l) => l.trim());
  if (!key) throw new Error(REMOTE_USAGE);
  await send({ vendor, key, ...(opt("--org") ? { org: opt("--org") } : {}), ...(opt("--budget") ? { budget: opt("--budget") } : {}), ...(github_token ? { github_token } : {}) });
  return `${vendor} is connected on this machine. Start a thread with it from agentbook.`;
}

async function openclawCommand([sub, ...args]) {
  const say = (c) => {
    if (!c) return "agentbook-cli isn't running: agentbook-cli up.";
    if (c.mode !== "gateway") return c.connected ? "OpenClaw: through this machine's openclaw command." : "OpenClaw: not connected. Pair with a gateway: agentbook-cli openclaw pair <setup code> (openclaw qr --setup-code-only, on its machine).";
    if (c.state === "connected") return `OpenClaw: connected to ${c.url}.`;
    if (c.state === "pairing") return `OpenClaw: waiting for you to approve agentbook on ${c.url}: run openclaw devices approve ${c.requestId || "<its request>"} on the gateway's machine, or approve "agentbook" in the OpenClaw app.`;
    return `OpenClaw: ${c.state} with ${c.url}${c.error ? `: ${c.error}` : ""}.`;
  };
  if (!sub || sub === "status") return say(await daemon("GET", "/local/openclaw"));
  if (sub === "off") {
    const r = await daemon("POST", "/local/openclaw/pair", { disconnect: true });
    if (!r) throw new Error("agentbook-cli isn't running: agentbook-cli up.");
    if (r.error) throw new Error(r.error);
    return "Forgot the OpenClaw gateway (its device key stays, so pairing with it again needs no approval).";
  }
  if (sub !== "pair") throw new Error("usage: agentbook-cli openclaw [pair <setup code> | pair --url wss://… --token <token> | off]");
  const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
  const code = args.find((a, i) => !a.startsWith("--") && !String(args[i - 1] || "").startsWith("--"));
  const body = code ? { setup_code: code } : { url: opt("--url") || "", ...(opt("--token") ? { token: opt("--token") } : {}), ...(opt("--password") ? { password: opt("--password") } : {}) };
  if (!code && !body.url) throw new Error("usage: agentbook-cli openclaw pair <setup code> | pair --url wss://… --token <token>");
  const r = await daemon("POST", "/local/openclaw/pair", body);
  if (!r) throw new Error("agentbook-cli isn't running: agentbook-cli up.");
  if (r.error) throw new Error(r.error);
  // Until it's connected, or waiting for an OK on the gateway, or failed.
  let c = r.connection;
  for (let i = 0; i < 40 && !["connected", "pairing", "failed"].includes(c?.state); i++) {
    await sleep(250);
    c = await daemon("GET", "/local/openclaw");
  }
  return say(c);
}

// The gate's commands: share a folder or keep one out, show the settings, OK what waits for an OK here, the log.
async function gateCommand(cmd, args) {
  const gate = createGate({ home: HOME });
  const when = (at) => new Date(at).toLocaleString();
  switch (cmd) {
    case "allow":
    case "deny": {
      if (!args.length) throw new Error(`Which folder? agentbook-cli ${cmd} <folder>`);
      return args.map((f) => (cmd === "allow" ? `Shared ${gate.allow(f)}: agentbook can start threads and read files there.` : `Kept out ${gate.deny(f)}: agentbook can't start threads or read files there.`)).join("\n");
    }
    case "gate": {
      const s = gate.settings();
      const d = await daemon("GET", "/gate");
      const lines = [`This machine is ${s.owner ? `@${s.owner}'s` : d?.owner ? `@${d.owner}'s` : "nobody's yet (it's whoever logs it in)"}.`];
      if (d?.shared) lines.push("It shares:", ...d.shared.map((f) => `  ${f}`));
      else lines.push(`It shares ${s.folders.length ? s.folders.join(", ") : "no folders of its own"}, with its clone folder and the checkouts its agents worked in (start agentbook-cli to see them).`);
      if (s.never.length) lines.push(`It keeps out: ${s.never.join(", ")}`);
      if (s.history_from) lines.push(`Your past stays here: nothing from before ${when(s.history_from)} goes up.`);
      if (s.codex_tools === false) lines.push("Codex's settings stay as they are.");
      const keyLine = keySaid(d);
      if (keyLine) lines.push(keyLine);
      if (s.private_terminals) lines.push("Private terminals is on here: only threads started in agentbook are on it.");
      const off = Object.entries(s.commands).filter(([, on]) => on === false).map(([k]) => k);
      lines.push(off.length ? `Turned off: ${off.join(", ")}` : "Every kind of command is on.", `New threads: at most ${s.starts_per_hour} an hour.`);
      if (s.ask_here.length) lines.push(`Asks here first: ${s.ask_here.join(", ")}`);
      lines.push(`Settings: ${path.join(HOME, "cli", "gate.json")}`);
      return lines.join("\n");
    }
    case "approve": {
      const no = args.includes("--no");
      const cid = args.find((a) => !a.startsWith("--"));
      if (!cid) {
        const d = await daemon("GET", "/gate");
        if (!d) throw new Error("agentbook-cli isn't running.");
        if (!d.waiting?.length) return "Nothing waits for an OK.";
        return d.waiting.map((w) => `${w.cid}  ${w.kind} from @${w.by}, ${when(w.at)}: ${JSON.stringify(w.args).slice(0, 200)}`).join("\n") + "\n\nagentbook-cli approve <id> to let it run, or add --no to refuse it.";
      }
      const r = await daemon("POST", "/gate/approve", { cid, yes: !no });
      if (!r) throw new Error("agentbook-cli isn't running.");
      if (r.error) throw new Error(r.error);
      return no ? `Refused ${cid}.` : `Let ${cid} run.`;
    }
    case "keys": {
      // The passkeys this machine takes signed commands from.
      const [sub, which] = args;
      if (sub === "export") return JSON.stringify(gate.keys(), null, 2);
      if (sub === "import") {
        if (process.stdin.isTTY) throw new Error("Pipe the keys in, from a machine that has them: agentbook-cli keys export | ssh <machine> agentbook-cli keys import");
        let from;
        try {
          from = JSON.parse(fs.readFileSync(0, "utf8"));
        } catch {
          throw new Error("That isn't what agentbook-cli keys export writes.");
        }
        const added = gate.importKeys(from);
        return `This machine now takes commands signed on ${from.origin} by:\n${added.map((k) => `  ${k.name || "a passkey"} (${fingerprint(k.spki)})`).join("\n")}`;
      }
      if (sub === "remove") {
        if (!which) throw new Error("Which key? agentbook-cli keys remove <fingerprint>");
        gate.removeKey(which);
        return gate.settings().keys.length ? `Removed ${which}.` : `Removed ${which}. This machine keeps no keys now. ${elsewhere(saved()?.server) ? NEEDS_KEYS : UNSIGNED_HERE}`;
      }
      if (sub && sub !== "list") throw new Error("agentbook-cli keys [list | export | import | remove <fingerprint>]");
      const k = gate.keys();
      if (!k.keys.length) return `This machine keeps no passkeys yet. ${elsewhere(saved()?.server) ? NEEDS_KEYS : UNSIGNED_HERE}`;
      return [`This machine (${k.machine}) takes the commands that can run something only when they're signed on ${k.origin}, by:`, ...k.keys.map((x) => `  ${x.name || "a passkey"}  ${x.fingerprint}  added ${when(x.added)}`)].join("\n");
    }
    case "operators": {
      // Who else this machine's owner lets operate which of its agents, and taking someone
      // off here, for a server that won't: they can't be let on again but by a newer OK from the owner's passkey.
      const [sub, user, agent] = args;
      if (sub === "remove") {
        if (!user) throw new Error("Who? agentbook-cli operators remove <username> [agent]");
        const n = gate.removeOperator(user.replace(/^@/, ""), agent || null);
        return `@${user.replace(/^@/, "")} doesn't operate ${agent || (n === 1 ? "its agent" : `its ${n} agents`)} here any more.`;
      }
      if (sub && sub !== "list") throw new Error("agentbook-cli operators [list | remove <username> [agent]]");
      const ops = gate.settings().operators;
      if (!ops.length) return "Nobody but this machine's owner steers its agents.";
      return ["Besides its owner, these people operate its agents (start threads with them, message, answer and stop them):", ...ops.map((o) => `  @${o.user}  ${o.agent}  since ${when(o.at)}, ${o.keys.length ? `with ${o.keys.map((k) => fingerprint(k.spki)).join(", ")}` : "with no passkey of theirs (this machine signs nothing)"}`)].join("\n");
    }
    case "log": {
      const lines = gate.audits(Number(args[0]) || 30);
      if (!lines.length) return "Nothing in the log yet.";
      return lines.map((l) => `${when(l.at)}  ${l.outcome.padEnd(8)} ${l.kind}${l.by ? ` from @${l.by}` : ""}${l.post ? ` on ${l.post}` : ""}${l.root || l.path ? ` (${l.root || l.path})` : ""}${l.reason ? `: ${l.reason}` : ""}`).join("\n");
    }
  }
}

// A copy Claude Code started made its thread again: `agentbook-cli fold <copy> <thread>`, by their ids or the start.
async function fold([copy, post]) {
  if (!copy || !post) throw new Error("usage: agentbook-cli fold <copy> <thread>  (session ids, or the start of them)");
  const r = await daemon("POST", "/local/fold", { copy, post });
  if (!r) throw new Error("agentbook-cli isn't running: agentbook-cli up.");
  if (r.error) throw new Error(r.error);
  return `Folded ${r.copy} into ${r.label} (${r.post})${r.follow ? "; the thread goes on in the copy" : ""}.`;
}

// Everything it changed outside its folder, undone, and its login revoked. `--purge` removes its folder too, unless
// a server's data is in there (a person's whole agentbook, on the machine that runs it). Claude Code last: that takes
// the folder this runs from, when it's the plugin's.
async function uninstall(args) {
  const said = [await logout()];
  await stopDaemon();
  said.push(removeCodexEntry() ? `Took agentbook's tools out of ${codexConfig()}.` : "Codex's settings have nothing of agentbook's.");
  if (args.includes("--purge")) {
    if (fs.existsSync(path.join(HOME, "server"))) said.push(`Kept ${HOME}: it holds an agentbook-server's data too. Remove it yourself if you mean to.`);
    else if (!fs.existsSync(path.join(HOME, "cli"))) said.push(`Nothing to remove at ${HOME}.`);
    else {
      fs.rmSync(HOME, { recursive: true, force: true });
      said.push(`Removed ${HOME}.`);
    }
  } else said.push(`Kept ${HOME}, your local copy of everything it followed: agentbook-cli uninstall --purge removes it.`);
  const claude = (...a) => spawnSync(process.env.AGENTBOOK_CLAUDE || "claude", a, { encoding: "utf8", timeout: 60000 });
  const gone = claude("plugin", "uninstall", "agentbook@agentbook");
  if (gone.error?.code === "ENOENT") said.push("Claude Code isn't on this machine's path, so its plugin wasn't touched.");
  else if (gone.status) said.push(`Claude Code didn't remove the plugin: ${(gone.stderr || gone.stdout).trim().split("\n")[0]}`);
  else {
    said.push("Removed the plugin from Claude Code.");
    const market = claude("plugin", "marketplace", "remove", "agentbook");
    if (market.status) said.push(`It kept the marketplace: ${(market.stderr || market.stdout).trim().split("\n")[0]}`);
  }
  if (!installedByClaude()) said.push(`The code is still at ${path.dirname(PLUGIN_ROOT)}: remove that folder too.`);
  said.push("Your threads stay on the server, and folders Claude Code trusts stay trusted.");
  return said.join("\n");
}

// Private terminals on this machine, whatever the server says: only threads started in agentbook are on it.
function privateCommand([to]) {
  const gate = createGate({ home: HOME });
  if (to === "on" || to === "off") gate.agree({ private_terminals: to === "on" });
  else if (to) throw new Error("usage: agentbook-cli private [on|off]");
  return gate.settings().private_terminals ? "Private terminals is on here: only threads started in agentbook are on it, whatever your profile says." : "Private terminals isn't on here: your profile's setting decides.";
}

const version = () => `agentbook-cli ${VERSION || "(version unknown)"}`;
const help = () => `${version()}: this machine's half of agentbook. It follows your agents, sends what they do to your
agentbook server, and does what you ask from its page, through its gate.

Getting it on a server:
  agentbook-cli login <server>           Log this machine in: approve the code it shows, on the server's page
      --name <name>                      Its name on the server
      --history, --no-history            Send what your agents did before this too, or don't
      --codex-tools, --no-codex-tools    Add agentbook's tools to Codex, or don't
      --private                          Turn on Private terminals
  agentbook-cli logout                   Revoke this machine's token, and stop
  agentbook-cli uninstall [--purge]      Log out, stop, and take it out of Codex and Claude Code

Running it:
  agentbook-cli status                   Whether it's running, its server, and what's waiting to go up
  agentbook-cli up, down                 Start or stop the background process
  agentbook-cli run                      The background process, in this terminal

What your server can do here:
  agentbook-cli gate                     What this machine lets its server do
  agentbook-cli allow|deny <folder>      Share a folder, or keep one out
  agentbook-cli approve [id] [--no]      Let through, or refuse, a command waiting for an OK here
  agentbook-cli log [n]                  The last commands it took or refused
  agentbook-cli keys                     The passkeys it accepts: keys export, keys import, keys remove <fingerprint>
  agentbook-cli operators                Who else steers its agents: operators remove <username> [agent]
  agentbook-cli private [on|off]         Keep what you start in a terminal off agentbook, whatever the server says

Your agents:
  agentbook-cli claude [args]            Claude Code with your messages arriving between turns
  agentbook-cli dev [args]               The same, with the plugin from this folder, not installed
  agentbook-cli openclaw [pair <code> | off]           Pair with an OpenClaw gateway, or forget it
  agentbook-cli remote [connect <kind> | off <kind>]   A cloud agent: claude-agent or devin, its key on stdin
  agentbook-cli fold <copy> <thread>     Make a copy Claude Code started part of its thread again

  agentbook-cli help, --version          This, and which version this is

Its log is ${CLI_LOG}.`;

// What can come in place of a command.
export const FLAGS = { "--help": "help", "-h": "help", "--version": "version", "-v": "version" };
export const COMMANDS = ["login", "connect", "logout", "status", "up", "down", "local", "allow", "deny", "gate", "approve", "log", "keys", "operators", "openclaw", "remote", "fold", "private", "uninstall", "help", "version"];
// A command: what to print. `print`: for what it says before it's done (a code to approve).
export async function runCommand([cmd, ...args], { print = (s) => console.log(s) } = {}) {
  switch (cmd) {
    // `connect` too, as the page says it.
    case "login":
    case "connect":
      return login(args, { print });
    case "logout":
      return logout();
    case "status":
      return status();
    case "up":
      return (await startDaemon()) ? `agentbook-cli is running, at http://127.0.0.1:${PORT}.` : "agentbook-cli is already running.";
    case "down":
      return (await stopDaemon()) ? "Stopped agentbook-cli." : "agentbook-cli isn't running.";
    case "local":
      return local(args, { print });
    case "openclaw":
      return openclawCommand(args);
    case "remote":
      return remoteCommand(args);
    case "fold":
      return fold(args);
    case "private":
      return privateCommand(args);
    case "uninstall":
      return uninstall(args);
    case "help":
      return help();
    case "version":
      return version();
  }
  if (["allow", "deny", "gate", "approve", "log", "keys", "operators"].includes(cmd)) return gateCommand(cmd, args);
  throw new Error(`agentbook-cli doesn't have a ${cmd} command. It has: ${COMMANDS.join(", ")}.`);
}
