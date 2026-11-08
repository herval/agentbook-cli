// Claude Code sessions agentbook starts and steers. They run in the background under Claude Code's own
// supervisor (`claude --bg`): the same sessions `claude agents` lists, with no terminal of their own.
// `claude attach <id>` opens one in a terminal whenever you want to watch it or type to it.
//
// What Claude Code gives a background session, and how agentbook uses it:
// - start:  claude "<prompt>" --bg                    → "backgrounded · <id>"
// - list:   claude agents --json --all                → id, sessionId, kind, state, status, pid…
// - stop:   claude stop <id>                          ends its process (it sleeps); its conversation is kept
// - interrupt: claude attach <id>, then Esc           cancels its turn, as Esc does in its terminal
// - wake:   claude "<message>" --resume <session> --bg  continues a stopped session under the same id,
//           with the message as its next prompt. A session that's still running would be copied instead,
//           so an idle one is stopped first. A session keeps the options it started with, so passing them
//           again would start a copy too.
//
// Where a session works is picked when it's posted: in the folder, or in a worktree agentbook makes. Left
// alone, Claude Code has a background session move into a worktree of its own before its first edit
// (`worktree.bgIsolation`), so each one starts with `--settings` saying to work where it is. The session keeps
// it with its other options, so it still holds when it's woken.
//
// Channels don't reach background sessions, so they run without one: what you send waits for the end of
// the session's turn (the Stop hook hands it over), and an idle session is woken with it.
//
// Models: a new session starts with `--model <model>` (and `--effort <level>`). A background session keeps the options it started
// with in its saved state (~/.claude/jobs/<id>/state.json, "respawnFlags"), and wakes with them, so to switch
// its model agentbook changes the saved `--model` while it's stopped, then wakes it. (`/model` as the wake
// prompt stops at a confirmation nobody can answer in the background.)

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLI_HOME } from "../../shared/store.mjs";
import { isPluginDir, pluginCopy } from "../plugin-copy.mjs";
import { cleanEnv as cleanEnvOf } from "../../lib/common.mjs";

const claudeBin = () => process.env.AGENTBOOK_CLAUDE || "claude";
// Node says ENOENT both when there's no `claude` and when the folder it's run in is gone (a worktree removed
// since the thread started), so look before blaming the install.
export const goneOrMissing = (cwd, missing) => (cwd && !fs.existsSync(cwd) ? new Error(`Its folder is gone (${cwd}).`) : new Error(missing));
const configDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");

// What you can pick: Claude Code's aliases for the latest of each model. `default` is your settings' model.
// Each takes every effort level (`--effort`); `effort` is the one it starts on: your settings' level for that
// model (`modelSettings`, keyed by full model id), else your settings' level.
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export function claudeModels() {
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(path.join(configDir(), "settings.json"), "utf8")) || {};
  } catch {}
  const level = (v) => (EFFORTS.includes(v) ? v : null);
  const effortOf = (alias) => {
    const key = Object.keys(settings.modelSettings || {}).filter((k) => k === alias || k.includes(`-${alias}-`)).sort().at(-1);
    return level(key && settings.modelSettings[key]?.effortLevel) || level(settings.effortLevel);
  };
  const preferred = settings.model || null;
  const list = ["fable", "opus", "sonnet", "haiku"].map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1), efforts: EFFORTS, effort: effortOf(id) }));
  return { list, default: preferred, efforts: EFFORTS, effort: preferred ? effortOf(preferred) : level(settings.effortLevel) };
}

// The slash commands a background session can run from agentbook: Claude Code's own
// list, as it gives it to its SDK (`initialize`), asked of a `claude -p` in the session's folder, on agentbook's
// plugin and the folders it has. That one calls no model, keeps no transcript, runs no hooks and starts no MCP
// server, and ends once it answers (under a second). Kept per folder until what the list comes from changes: the
// skills and commands folders, the plugins installed, the settings. [{ name, hint, description, from, plugin?, takes }]
// - from: "built-in", "skill" (yours), "project" (the folder's), "plugin" (with `plugin`, its name).
// - takes: "" (nothing), "opt" (it may take something), "req" (it needs something).
// Left out (`off`, each with why, for when you type one): what only shows in a terminal, what opens a panel a
// background session can't show, and what agentbook does another way.
const NOT_HERE = {
  clear: "would end this thread and start another: start a new thread instead",
  resume: "picks a conversation in a panel only a terminal shows: each conversation is a thread here",
  exit: "would end the session: Stop, or archive the thread",
  usage: "opens a panel only its terminal shows",
  "usage-credits": "opens a panel only its terminal shows",
  "extra-usage": "opens a panel only its terminal shows",
  status: "opens a panel only its terminal shows",
  permissions: "opens a panel only its terminal shows",
  login: "signs in in a panel only a terminal shows",
  logout: "signs out of Claude Code on this machine",
  memory: "opens an editor only its terminal shows",
  hooks: "opens a panel only its terminal shows",
  plugin: "opens a panel only its terminal shows",
  agents: "opens a panel only its terminal shows",
  "add-dir": "picks a folder in a panel only its terminal shows",
  "install-github-app": "sets up in a panel only a terminal shows",
  import: "opens a panel only its terminal shows",
  doctor: "checks the install in its terminal",
  color: "colors its terminal's prompt bar",
  focus: "changes what its terminal shows",
  theme: "changes its terminal's colors",
  "reload-plugins": "reloads plugins in its terminal",
  heapdump: "writes a file for debugging Claude Code itself",
  "__remote-workflow": "is Claude Code's own",
  "workflow-launch-exec": "is Claude Code's own",
};
// Bare, these open a picker nobody can answer in the background: they need what they take.
const NEEDS = new Set(["model", "effort", "advisor", "goal", "mcp", "config", "output-style", "fast", "autocompact", "design"]);
// Learned on this machine: commands that opened a panel anyway (`learnCommand`), bare or with what they took.
const LEARNED = () => path.join(CLI_HOME, "commands.json");
const learned = () => {
  try {
    return JSON.parse(fs.readFileSync(LEARNED(), "utf8")) || {};
  } catch {
    return {};
  }
};
export function learnCommand(name, { bare }) {
  const all = learned();
  if (all[name] === "panel" || (bare && all[name] === "bare")) return;
  all[name] = bare ? "bare" : "panel";
  fs.mkdirSync(path.dirname(LEARNED()), { recursive: true });
  fs.writeFileSync(LEARNED(), JSON.stringify(all, null, 2));
}
const listedCommands = new Map(); // key -> { sig, at, list }
const COMMANDS_MAX_MS = 30 * 60e3;
// What the list comes from, changed when any of it changes.
function commandSources(cwd) {
  const conf = configDir();
  const plugin = process.env.AGENTBOOK_PLUGIN_DIR;
  const paths = [
    path.join(conf, "commands"),
    path.join(conf, "skills"),
    path.join(conf, "settings.json"),
    path.join(conf, "plugins", "installed_plugins.json"),
    path.join(cwd, ".claude", "commands"),
    path.join(cwd, ".claude", "skills"),
    path.join(cwd, ".claude", "settings.json"),
    ...(plugin ? [path.join(plugin, "skills"), path.join(plugin, ".claude-plugin", "plugin.json")] : []),
  ];
  return paths
    .map((p) => {
      try {
        return fs.statSync(p).mtimeMs;
      } catch {
        return 0;
      }
    })
    .join(",");
}
function askCommands({ cwd, dirs = [] }) {
  const plugin = process.env.AGENTBOOK_PLUGIN_DIR;
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--strict-mcp-config", "--settings", JSON.stringify({ disableAllHooks: true }), ...(plugin ? ["--plugin-dir", plugin] : []), ...dirArgs(dirs)];
  return new Promise((resolve, reject) => {
    const child = spawn(claudeBin(), args, { cwd, env: cleanEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    let err = "";
    let done = false;
    const finish = (e, list) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      if (e) reject(e);
      else resolve(list);
    };
    const timer = setTimeout(() => finish(new Error("Claude Code didn't list its commands in time.")), 20000);
    child.stdout.on("data", (d) => {
      buf += d.toString("utf8");
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.type !== "control_response") continue;
        const r = m.response || {};
        if (r.subtype === "error") return finish(new Error(r.error || "Claude Code wouldn't list its commands."));
        finish(null, Array.isArray(r.response?.commands) ? r.response.commands : []);
      }
    });
    child.stderr.on("data", (d) => (err = (err + d).slice(-4000)));
    child.stdin.on("error", () => {});
    child.on("error", (e) => finish(e.code === "ENOENT" ? goneOrMissing(cwd, "Claude Code isn't installed here (no `claude` command).") : e));
    child.on("exit", () => finish(new Error(reason(err) || "Claude Code ended before listing its commands.")));
    child.stdin.write(JSON.stringify({ type: "control_request", request_id: "agentbook-commands", request: { subtype: "initialize" } }) + "\n");
  });
}
// One of Claude Code's rows as the page shows it: where it's from, said by a chip, not in its description.
function commandOf(c, known) {
  const name = String(c.name || "");
  let description = String(c.description || "").trim();
  let from = c.builtin ? "built-in" : "skill";
  let plugin = null;
  let shown = name;
  if (name.includes(":")) {
    from = "plugin";
    plugin = name.split(":")[0];
    description = description.replace(new RegExp(`^\\(${plugin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)\\s*`), "");
    // Its short name, when that's how it's known (`frontend-design` for `frontend-design:frontend-design`).
    const alias = (c.aliases || []).find((a) => !a.includes(":"));
    if (alias) shown = alias;
  }
  const tag = /\s*\((project|user|claude\.ai sync|dynamic workflow)\)$/.exec(description);
  if (tag) {
    if (tag[1] === "project") from = "project";
    description = description.slice(0, tag.index);
  }
  const hint = String(c.argumentHint || "").trim();
  // `[name]` may be left out, and so may what says it's optional (/compact's `<optional custom summarization instructions>`).
  let takes = !hint ? "" : hint.startsWith("[") || /^<optional\b/i.test(hint) ? "opt" : "req";
  if ((NEEDS.has(name) || known[name] === "bare") && from === "built-in") takes = "req";
  return { name: shown, hint, description, from, ...(plugin ? { plugin } : {}), takes };
}
export async function claudeCommands({ cwd, dirs = [] }) {
  const key = JSON.stringify([cwd, dirs, process.env.AGENTBOOK_PLUGIN_DIR || ""]);
  const sig = commandSources(cwd);
  const have = listedCommands.get(key);
  let raw = have && have.sig === sig && Date.now() - have.at < COMMANDS_MAX_MS ? have.list : null;
  if (!raw) {
    raw = await askCommands({ cwd, dirs });
    listedCommands.set(key, { sig, at: Date.now(), list: raw });
  }
  const known = learned();
  const off = (n) => NOT_HERE[n] || (known[n] === "panel" ? "opened a panel only its terminal shows" : null);
  const list = raw.filter((c) => c?.name && !off(c.name)).map((c) => commandOf(c, known));
  const names = new Set(raw.map((c) => c?.name));
  return { list, off: [...names].filter(off).map((name) => ({ name, why: off(name) })) };
}

// Change the options a stopped background session wakes with.
function saveFlags(id, change) {
  const file = path.join(configDir(), "jobs", id, "state.json");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(saved.respawnFlags)) throw new Error("Claude Code didn't save this session's options.");
  const flags = change(saved.respawnFlags);
  if (JSON.stringify(flags) === JSON.stringify(saved.respawnFlags)) return;
  saved.respawnFlags = flags;
  fs.writeFileSync(file, JSON.stringify(saved, null, 2));
}
function saveModel(id, model) {
  saveFlags(id, (saved) => {
    const flags = [];
    for (let i = 0; i < saved.length; i++) {
      const f = saved[i];
      if (f === "--model") i++;
      else if (!String(f).startsWith("--model=")) flags.push(f);
    }
    return [...flags, "--model", model];
  });
}
// A session in a group can write the group's folder (`dirs`), however it started: one that's woken gets it added.
const dirArgs = (dirs = []) => dirs.flatMap((d) => ["--add-dir", d]);
function saveDirs(id, dirs) {
  if (!dirs?.length) return;
  saveFlags(id, (saved) => [...saved, ...dirArgs(dirs.filter((d) => !saved.some((f, i) => saved[i - 1] === "--add-dir" && f === d)))]);
}
// A session on agentbook's plugin folder, or on a copy of it, wakes on a copy of it as it is now.
function savePlugin(id) {
  if (!process.env.AGENTBOOK_PLUGIN_DIR) return;
  saveFlags(id, (saved) => saved.map((f, i) => (saved[i - 1] === "--plugin-dir" && isPluginDir(f) ? pluginCopy() : f)));
}

// agentbook-cli may have been started by a session's hook, with that session's variables (an older one, or by hand). A
// session it starts must not inherit them: it would think it's nested in that session, or post as it.
export const cleanEnv = (extra = {}) => cleanEnvOf(extra);

const plain = (s) => String(s || "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");
// The line worth showing from what Claude Code printed when something went wrong.
const reason = (out) =>
  plain(out)
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !/^(claude (agents|attach|logs|stop)|usage:)/i.test(l)) || "";

function run(args, { cwd, env, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(claudeBin(), args, { cwd, env: env || cleanEnv(), timeout, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
      const out = plain(`${stdout}\n${stderr}`);
      if (err) {
        if (err.code === "ENOENT") return reject(goneOrMissing(cwd, "Claude Code isn't installed here (no `claude` command)."));
        return reject(new Error(reason(out) || err.message));
      }
      resolve(out);
    });
  });
}

// A prompt that starts with a dash would read as a flag.
const asArg = (prompt) => (String(prompt).startsWith("-") ? ` ${prompt}` : String(prompt));

// In dev mode (`agentbook dev`) the plugin loads from its folder rather than from the installed copy: from
// a copy of the folder as it is when the session starts, so it can edit agentbook (see plugin-copy.mjs).
const pluginArgs = () => (process.env.AGENTBOOK_PLUGIN_DIR ? ["--plugin-dir", pluginCopy()] : []);
// agentbook's own tools, allowed up front: a background session has nobody to ask, and in auto mode its
// classifier can turn them away as writes to another system.
const toolArgs = () => ["--allowedTools", "mcp__plugin_agentbook_agentbook__*"];

// Work in the folder it was started in, rather than in a worktree of its own (see the top of this file).
const IN_PLACE = ["--settings", JSON.stringify({ worktree: { bgIsolation: "none" } })];

function backgrounded(out) {
  const id = out.match(/backgrounded\s*·\s*(\S+)/i)?.[1];
  if (!id) throw new Error(reason(out) || "Claude Code didn't start the session.");
  // A copy: what Claude Code said of why ("note: session … is already running in the background, so this started a copy as …").
  const copy = /started a (restricted )?copy/i.test(out) ? plain(out).split("\n").find((l) => /started a (restricted )?copy/i.test(l))?.trim() || "a copy" : false;
  return { id, copy };
}

// What Claude Code saved about a background session (~/.claude/jobs/<id>/state.json).
function savedState(id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(configDir(), "jobs", id, "state.json"), "utf8"));
  } catch {
    return null;
  }
}

// What a background session has going between its turns (a shell watching a CI run, a monitor, a subagent),
// each as Claude Code lists it ("fan"), while it counts some in flight: [{ id, kind, label, started }]. The list
// has its to-dos too, and during a turn the command the turn is on, so it's read only between turns (goingOf),
// as agentbook knows them: Claude Code's "tempo" stays "active" after a turn while a subagent works on.
function workIn(saved) {
  const f = saved?.inFlight || {};
  if (!((f.tasks || 0) + (f.queued || 0))) return [];
  return (Array.isArray(saved.fan) ? saved.fan : [])
    .filter((x) => x?.id && x.kind !== "todo" && !x.doneAt)
    .map((x) => ({ id: String(x.id), kind: String(x.kind || ""), label: String(x.label || "").slice(0, 300), started: x.startedAt ? new Date(x.startedAt).toISOString() : null }));
}

export function createClaude({ log = () => {} } = {}) {
  let sessions = new Map(); // Claude Code session id -> what `claude agents` says about it
  let works = new Map(); // Claude Code session id -> what it has going between its turns (workIn), when it has some
  let listed = 0;
  let listAsked = 0; // when the list in hand was asked for
  let listing = null;
  let version = null; // `claude --version`'s ("2.1.316"), read again every few minutes as Claude Code updates itself
  let versionAt = 0;

  // Every session the supervisor knows on this machine: running in the background, in a terminal, or
  // finished, and what the running background ones have going between turns. Coalesces concurrent calls.
  function refresh() {
    // A machine with no Claude Code to look for (the hub's agentbook-cli, deploy/agentbook-cli.sh): nothing to ask, every few seconds, forever.
    if (process.env.AGENTBOOK_CLAUDE_CODE === "0") return Promise.resolve(false);
    const asked = Date.now();
    // A listing has no use for the network. Without this, one that starts near a token's renewal can take the login's
    // refresh lock and exit 150 ms later, which may be what loses a login (not proven).
    listing ||= run(["agents", "--json", "--all"], { timeout: 10000, env: cleanEnv({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" }) })
      .then(async (out) => {
        const list = JSON.parse(out.slice(out.indexOf("[")));
        const next = new Map();
        for (const a of Array.isArray(list) ? list : []) if (a.sessionId) next.set(a.sessionId, a);
        const work = new Map();
        for (const a of next.values()) {
          const w = a.kind === "background" && running(a) ? workIn(savedState(a.id)) : [];
          if (w.length) work.set(a.sessionId, w);
        }
        const changed = JSON.stringify([...sessions]) !== JSON.stringify([...next]) || JSON.stringify([...works]) !== JSON.stringify([...work]);
        sessions = next;
        works = work;
        listed = Date.now();
        listAsked = asked;
        if (listed - versionAt > 10 * 60e3) {
          versionAt = listed;
          version = /\d+\.\d+\.\d+\S*/.exec(await run(["--version"], { timeout: 10000 }).catch(() => ""))?.[0] || version;
        }
        return changed;
      })
      .catch((e) => {
        log(`claude agents: ${e.message}`);
        return false;
      })
      .finally(() => (listing = null));
    return listing;
  }

  const info = (sessionId) => (sessionId && sessions.get(sessionId)) || null;
  const background = (sessionId) => info(sessionId)?.kind === "background";
  // A session that's running has a process; a stopped one is listed without one (and as "done").
  const running = (a) => !!a?.pid && !["stopped", "failed"].includes(a.state);

  async function start({ cwd, prompt, lid, label, model, effort, dirs = [] }) {
    if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`No folder at ${cwd}`);
    const env = cleanEnv({ AGENTBOOK_LAUNCH_ID: lid, ...(label ? { AGENTBOOK_LABEL: label } : {}) });
    const flags = [...IN_PLACE, ...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : []), ...dirArgs(dirs)];
    const r = backgrounded(await run([asArg(prompt), "--bg", ...pluginArgs(), ...flags, ...toolArgs()], { cwd, env }));
    refresh();
    return r;
  }

  // End a background session's process. Its conversation is kept: it sleeps until it's woken (`resume`).
  async function stop(sessionId) {
    const a = info(sessionId);
    if (!a) throw new Error("Claude Code doesn't list this session.");
    await run(["stop", a.id], { timeout: 15000 });
    await refresh();
  }

  // Cancel a background session's turn, as Esc does in its terminal: open it in a pseudo-terminal (`script`
  // runs `claude attach` in one), press Esc once its screen draws, and leave. The session stays up, waiting
  // for its next prompt. Resolves whether Claude Code said it was interrupted.
  function interrupt(sessionId) {
    const a = info(sessionId);
    if (!a || !running(a)) return Promise.reject(new Error("It isn't running."));
    // `script` wants a pipe for its input, not the socket Node gives a child, so `cat` hands the keys over.
    const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    const attach = `${q(claudeBin())} attach ${q(a.id)}`;
    const cmd = process.platform === "linux" ? `cat | script -qfc ${q(attach)} /dev/null` : `cat | script -q /dev/null ${attach}`;
    return new Promise((resolve, reject) => {
      const child = spawn("/bin/sh", ["-c", cmd], { env: cleanEnv({ TERM: "xterm-256color" }), stdio: ["pipe", "pipe", "ignore"], detached: true });
      let out = "";
      let pressed = false;
      let done = false;
      const timers = [];
      const finish = (err, interrupted = false) => {
        if (done) return;
        done = true;
        timers.forEach(clearTimeout);
        try {
          process.kill(-child.pid, "SIGTERM"); // `cat` and `script`; closing the terminal detaches `claude attach`
        } catch {}
        if (err) reject(err);
        else resolve(interrupted);
      };
      const press = () => {
        if (pressed || done) return;
        pressed = true;
        child.stdin.write("\x1b");
        timers.push(setTimeout(() => finish(null, false), 4000));
      };
      child.stdout.on("data", (d) => {
        if (!out) timers.push(setTimeout(press, 800)); // its screen is drawing: it takes keys now
        out = (out + d.toString("utf8")).slice(-65536);
        if (pressed && /Interrupted/.test(plain(out))) finish(null, true);
      });
      child.stdin.on("error", () => {});
      child.on("error", (e) => finish(e.code === "ENOENT" ? new Error("This machine has no `script` command to open the session with.") : e));
      child.on("exit", () => finish(pressed ? null : new Error(reason(out) || "Claude Code couldn't open the session."), /Interrupted/.test(plain(out))));
      timers.push(setTimeout(() => finish(new Error("Claude Code didn't open the session in time.")), 12000));
    });
  }

  // Work a background session has going on its own, outside its turn: background shells, monitors, subagents,
  // scheduled wakeups. Claude Code counts it in the session's saved state.
  function backgroundWork(sessionId) {
    const a = info(sessionId);
    if (!a) return 0;
    const f = savedState(a.id)?.inFlight || {};
    return Math.max((f.tasks || 0) + (f.queued || 0), f.kinds?.length || 0);
  }
  // The same work by name, between turns, as of the last refresh (workIn).
  const workOf = (sessionId) => (sessionId && works.get(sessionId)) || [];

  // Continue a conversation in the background with `prompt` as its next message. A background session
  // that's still running (idle between turns) is stopped first, so it continues rather than being copied.
  // What it had going keeps going: Claude Code hands its background shells to the new process, which hears
  // when they finish.
  // `model`: switch to it. If that fails, it continues on its model, and `modelError` says why.
  async function resume({ sessionId, cwd, prompt, lid, label, model, dirs = [] }) {
    let a = info(sessionId);
    if (a?.kind === "background" && running(a)) await run(["stop", a.id], { timeout: 15000 });
    // Claude Code lists it as stopped while its process is still on its way out (for seconds, at times, and a frozen
    // one takes about 5, so one that Force stop just ended is too), and a resume meanwhile starts a copy: a
    // conversation of its own, a thread of its own, with what you sent. So it waits until Claude Code lists no
    // process for it.
    if (a?.kind === "background" && a.pid && a.state !== "failed") {
      const until = Date.now() + 20e3;
      for (;;) {
        await refresh();
        a = info(sessionId);
        if (!a?.pid) break;
        if (Date.now() > until) throw new Error("Claude Code is still stopping it. Send that again in a moment.");
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    if (a?.kind === "interactive" && running(a)) throw new Error("It's open in a terminal. Write to it there, or wait until it ends.");
    const env = cleanEnv({ AGENTBOOK_LAUNCH_ID: lid, ...(label ? { AGENTBOOK_LABEL: label } : {}) });
    // A session the supervisor ran keeps its options; one that ran in a terminal needs the plugin passed again,
    // and to keep working where it was.
    const flags = a?.kind === "background" ? [] : [...pluginArgs(), ...IN_PLACE, ...toolArgs(), ...dirArgs(dirs)];
    if (a?.kind === "background") {
      try {
        savePlugin(a.id);
        saveDirs(a.id, dirs);
      } catch (e) {
        if (e.code !== "ENOENT") log(`claude: couldn't wake ${a.id} on the plugin as it is now: ${e.message}`);
      }
    }
    let modelError = null;
    if (model && a?.kind === "background") {
      try {
        saveModel(a.id, model);
      } catch (e) {
        modelError = e.code === "ENOENT" ? "Claude Code didn't save this session's options." : e.message;
        log(`claude: couldn't switch ${a.id} to ${model}: ${modelError}`);
      }
    } else if (model) flags.push("--model", model);
    const r = backgrounded(await run([asArg(prompt), "--resume", sessionId, "--bg", ...flags], { cwd, env }));
    if (r.copy) log(`claude --resume ${sessionId} started a copy as ${r.id}: ${r.copy}`);
    refresh();
    return { ...r, modelError };
  }

  // Why a background session failed, as Claude Code saved it ("source session … not found").
  const failure = (id) => savedState(id)?.detail || null;

  // The background session Claude Code started in `cwd` with `prompt` since `since` (ms), by what it saved of it: its
  // id, or null. For a start whose answer was lost (agentbook-cli stopped while `claude --bg` ran).
  function startedWith({ prompt, cwd, since }) {
    const jobs = path.join(configDir(), "jobs");
    const real = (p) => {
      try {
        return fs.realpathSync(p);
      } catch {
        return p;
      }
    };
    const head = String(prompt).trim().slice(0, 200);
    let ids = [];
    try {
      ids = fs.readdirSync(jobs).filter((id) => fs.statSync(path.join(jobs, id)).mtimeMs >= since - 60e3);
    } catch {
      return null;
    }
    for (const id of ids) {
      const s = savedState(id);
      if (!s?.sessionId || !(Date.parse(s.createdAt) >= since - 5000) || real(s.cwd) !== real(cwd)) continue;
      if (String(s.intent || "").trim().slice(0, 200) === head) return s.sessionId;
    }
    return null;
  }
  return { refresh, info, background, running, start, stop, interrupt, backgroundWork, workOf, resume, failure, startedWith, listedAt: () => listed, listAsked: () => listAsked, version: () => version };
}

// Open a terminal window running `cmd` in `cwd`. Only macOS's Terminal for now; elsewhere the page offers
// the command to copy.
export function openTerminal(cmd, cwd) {
  if (process.platform !== "darwin" || process.env.AGENTBOOK_TERMINAL === "0") return Promise.reject(new Error(`Run this in a terminal: ${cmd}`));
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const script = `${cwd ? `cd ${q(cwd)} && ` : ""}${cmd}`.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return new Promise((resolve, reject) =>
    execFile("osascript", ["-e", `tell application "Terminal" to do script "${script}"`, "-e", 'tell application "Terminal" to activate'], { timeout: 8000 }, (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve())),
  );
}
