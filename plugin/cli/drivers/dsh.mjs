// DeepSeek Harness (dsh) sessions, which agentbook runs through dsh's Agent Client Protocol server
// (`dsh --profile acp`: JSON-RPC over stdio), as a child.
//
// - DeepSeek is a profile ("dsh"), and each session agentbook starts with it is a post. Sessions from dsh's own apps
//   (its web and desktop apps, its terminal) are posts too, once agentbook's plugin is added to them (plugin/dsh):
//   it connects here (/api/dsh/ws) and says what they do as they do it, and takes what you write on them, Stop,
//   Allow/Deny and answers back to dsh (see "dsh's plugin").
// - What dsh sends over ACP while a turn runs is the post's steps: what it says, the tools it calls and how they went.
//   Its reply is the last thing it said in a turn, when no tool call followed it.
// - dsh keeps each session in a log of its own ($DSH_HOME/sessions/--<folder>--/<id>/session.vN.jsonl.zstd), which
//   agentbook reads, read-only, for a post's steps once a turn ends (its title too) and after a restart.
// - Writing on a post sends a prompt, resuming the session first after a restart. dsh takes one prompt at a time, so
//   what you write while a turn runs waits for it to end. Stop cancels the turn.
// - dsh's permission requests are Allow/Deny on the post.
// - Its model and reasoning effort are ACP config options: picked for a post, they're set before its next prompt. The
//   models it lists are kept (dsh-models.json), for the composer's picker before any session has started.
// - The sessions agentbook starts or resumes have agentbook's tools (ab_post, ab_ask…), at its /api/mcp address, and
//   what Codex gets as developer instructions (context.mjs) follows the first prompt.
// - A session starts on the model you pick, else the one you picked in dsh's own apps (defaultModel).
// - While dsh's web or desktop app runs with agentbook's plugin (0.3.0 and up), a thread you start on agentbook starts
//   there instead (startThere): its session shows in that app too, on the app's models and keys, and the app's picker
//   lists them here. ACP is for when none is running (or AGENTBOOK_DSH_APP=0).

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { CLI_HOME } from "../../shared/store.mjs";
import { going, settle, stateOf } from "../workers.mjs";
import { addSay, addTool, blank, deliverer, iso, liveOf, short, summaryOf, toolDone, toolTitle } from "./steps.mjs";
import { SEEN_TOOL } from "../transcript.mjs";

const AGENT = "dsh";
const NAME = "DeepSeek";
const HOME_DIR = () => process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const MODELS_FILE = () => path.join(CLI_HOME, "dsh-models.json");
const BRIDGE = fileURLToPath(new URL("../../mcp/http-bridge.mjs", import.meta.url));

// A command on the PATH (or a path to one), or null.
function onPath(cmd) {
  const runs = (p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (cmd.includes("/")) return runs(cmd) ? cmd : null;
  for (const dir of (process.env.PATH || "").split(path.delimiter)) if (dir && runs(path.join(dir, cmd))) return path.join(dir, cmd);
  return null;
}
const readdir = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};

/* ---------- dsh's session logs ---------- */

// A log is Zstandard frames one after another (one per batch dsh appended), or plain lines. A frame cut short (dsh
// writing it now) ends the read.
const MAGIC = 0xfd2fb528;
function framesOf(buf) {
  const out = [];
  let o = 0;
  while (o + 5 <= buf.length && buf.readUInt32LE(o) === MAGIC) {
    const start = o;
    const d = buf[o + 4];
    o += 5;
    const fcs = d >>> 6;
    const single = (d & 0x20) !== 0;
    const dict = d & 3;
    o += (single ? 0 : 1) + (dict === 3 ? 4 : dict) + (fcs === 0 ? (single ? 1 : 0) : 1 << fcs);
    for (;;) {
      if (o + 3 > buf.length) return out;
      const h = buf.readUIntLE(o, 3);
      o += 3 + (((h >>> 1) & 3) === 1 ? 1 : h >>> 3);
      if (o > buf.length) return out;
      if (h & 1) break;
    }
    if (d & 4) o += 4;
    if (o > buf.length) return out;
    out.push(buf.subarray(start, o));
  }
  return out;
}
// A session's log: the newest format's file in its folder, wherever dsh put that folder.
function logFile(id) {
  const root = path.join(HOME_DIR(), "sessions");
  for (const dir of readdir(root))
    for (const name of [id, `session-${id}`]) {
      const files = readdir(path.join(root, dir, name)).filter((f) => /^session(\.v\d+)?\.jsonl(\.zstd)?$/.test(f));
      const v = (f) => Number(/\.v(\d+)\./.exec(f)?.[1] || 0);
      if (files.length) return path.join(root, dir, name, files.sort((a, b) => v(a) - v(b)).at(-1));
    }
  return null;
}
export function readLog(id) {
  const file = logFile(id);
  if (!file) return null;
  const buf = fs.readFileSync(file);
  const text = file.endsWith(".zstd") ? (zlib.zstdDecompressSync ? framesOf(buf).map((f) => zlib.zstdDecompressSync(f).toString()).join("\n") : null) : buf.toString();
  if (text == null) return null;
  const events = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {}
  }
  return events;
}

// agentbook's own tools show on the thread anyway (its headline, its results), so they aren't steps, as in Claude's,
// but for going through other threads, which you should see.
const quiet = (name) => /^mcp__agentbook__/.test(String(name || "")) && !SEEN_TOOL.test(String(name));
const textOf = (blocks) => (Array.isArray(blocks) ? blocks.filter((b) => b?.type === "text").map((b) => b.text || "") : []).join("\n").trim();
const contextOf = (u) => (u ? (u.inputTokens || 0) + (u.cacheReadTokens || 0) + (u.cacheWriteTokens || 0) : 0);

// One record of a session's log on its post's digest: a turn begun or ended, what it said, the tools it called and
// how they went, its title, model and how much context it used. The same whether it's read from the log or comes as
// it's written (dsh's plugin). `seq`: the last record folded.
export function foldEvent(d, e, cwd) {
  const at = iso(e.time) || new Date().toISOString();
  const x = e.data || {};
  if (Number.isFinite(e.seq)) d.seq = Math.max(d.seq || 0, e.seq);
  switch (e.type) {
    case "turn/start":
      d.turn = Math.max(d.turn + 1, Number(x.turn) || 0);
      d.turnAt = e.time;
      break;
    case "turn/end":
      if (d.turnAt != null && e.time >= d.turnAt) d.worked += e.time - d.turnAt;
      d.turnAt = null;
      break;
    case "assistant/message": {
      const blocks = x.message?.content || [];
      blocks.forEach((b, i) => b?.type === "text" && addSay(d, { id: `${x.message?.id || e.seq}-${i}`, at, text: b.text }));
      if (x.usage) d.context = contextOf(x.usage);
      if (x.message?.source?.model) d.model = x.message.source.model;
      break;
    }
    case "tool/call":
      if (!quiet(x.name)) addTool(d, { id: x.callId, at, name: x.name, args: x.arguments, cwd });
      break;
    case "tool/result": {
      const out = textOf(x.message?.content);
      toolDone(d, x.message?.toolCallId, { at, error: x.message?.isError ? out || "Failed" : null, output: out });
      break;
    }
    case "session/title":
      if (x.title) d.ai_title = short(x.title, 120);
      break;
    case "subagent/descriptor":
      if (x.label) d.label = short(x.label, 120);
      break;
    case "request/header":
      if (x.header?.config?.model) d.model = x.header.config.model;
      break;
  }
  return d;
}
// A post's steps from its session's log.
export function digestOf(events, cwd) {
  const d = blank();
  d.whole = true;
  for (const e of events) foldEvent(d, e, cwd);
  return d;
}

/* ---------- models ---------- */

// dsh's model option values are [provider, model] as JSON; agentbook's model ids are "provider/model".
const pairOf = (v) => {
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) && a.length === 2 && a.every((s) => typeof s === "string" && s) ? a : null;
  } catch {
    return null;
  }
};
// What dsh's config options say: the models to pick from, as agentbook's pickers list them, and the reasoning efforts
// it takes (dsh lists those of its current model; another that takes none says so when it's picked).
export function modelsOf(options) {
  const m = (options || []).find((o) => o.id === "model");
  if (!m) return null;
  const effort = options.find((o) => o.id === "reasoning_effort");
  const efforts = (effort?.options || []).map((o) => o.value).filter(Boolean);
  const flat = (m.options || []).flatMap((g) => (Array.isArray(g.options) ? g.options : [g]));
  const list = [];
  for (const o of flat) {
    const p = pairOf(o.value);
    if (p && !list.some((x) => x.id === p.join("/"))) list.push({ id: p.join("/"), name: o.name || p[1], efforts, effort: effort?.currentValue || null });
  }
  const current = pairOf(m.currentValue)?.join("/") || list[0]?.id || null;
  return list.length ? { list, default: current, efforts, effort: effort?.currentValue || null } : null;
}
// The model you picked in dsh's own apps (their Models page writes it to that profile's patch layer,
// $DSH_HOME/profiles/<profile>/cordis.patch.yml), the most recent one: what agentbook's sessions start on, since dsh's
// ACP profile starts on its built-in route (one you may have no key for). None when you gave the ACP profile one.
export function defaultModel(home = HOME_DIR()) {
  const of = (profile) => {
    const file = path.join(home, "profiles", profile, "cordis.patch.yml");
    try {
      const text = fs.readFileSync(file, "utf8");
      const block = /^-\s*id:\s*["']?agent-default-model\b["']?\s*$([\s\S]*?)(?=^-\s|(?![\s\S]))/m.exec(text)?.[1] || "";
      const field = (k) => new RegExp(`^\\s+${k}:\\s*["']?([\\w.:@/-]+)`, "m").exec(block)?.[1] || null;
      return field("provider") && field("model") ? { id: `${field("provider")}/${field("model")}`, effort: field("reasoningEffort"), at: fs.statSync(file).mtimeMs } : null;
    } catch {
      return null;
    }
  };
  if (of("acp")) return null;
  return readdir(path.join(home, "profiles")).filter((p) => p !== "acp").map(of).filter(Boolean).sort((a, b) => b.at - a.at)[0] || null;
}
const valueOfId = (id) => {
  const at = String(id).indexOf("/");
  return at > 0 ? JSON.stringify([id.slice(0, at), id.slice(at + 1)]) : null;
};

// host: { state, commit, pending, label, describe, attached, gitInfo, changed, context, mcp, log }
export function createDsh(host) {
  const log = host.log || (() => {});
  const bin = () => onPath(process.env.AGENTBOOK_DSH_BIN || "dsh");
  const enabled = process.env.AGENTBOOK_DSH !== "0";
  let lastError = null;
  let models = (() => {
    try {
      return JSON.parse(fs.readFileSync(MODELS_FILE(), "utf8"));
    } catch {
      return null;
    }
  })();
  // post id (dsh's session id) -> { digest, calls: Map(tool call -> {name, args}), reply, replyOf, busy, queue, started, loaded },
  // and for a session in dsh's own apps: link (its plugin's connection), cwd, status, parent (a subagent's), error
  const posts = new Map();
  const asks = new Map(); // permission request key -> { rpcId, write }

  const post = (id) => host.state.sessions[id];
  const conv = (id) => {
    if (!posts.has(id)) posts.set(id, { digest: blank(), calls: new Map(), reply: null, replyOf: null, busy: false, queue: [], started: null, loaded: false });
    return posts.get(id);
  };
  const say = (id, text) => host.commit({ t: "message.add", post: id, from: "agent", via: "dash", text });

  // A post's steps, from its session's log (all of them, after a restart, and what ACP sent anyway once a turn
  // ends). The log stays where it is when it can't be read.
  function reload(id) {
    const c = conv(id);
    c.loaded = true;
    try {
      const events = readLog(id);
      if (!events?.length) return;
      const d = digestOf(events, post(id)?.cwd);
      // dsh writes its log in batches: one behind what its plugin already said stays where it is.
      if (c.digest.seq && (d.seq || 0) < c.digest.seq) return;
      d.turn = Math.max(d.turn, c.digest.turn);
      d.model ||= c.digest.model;
      d.context ||= c.digest.context;
      c.digest = d;
      host.changed(id);
    } catch (e) {
      log(`dsh log ${id}: ${e.message}`);
    }
  }

  function ensurePost(id, { cwd, lid, prompt }) {
    if (post(id) && !lid) return post(id);
    const g = host.gitInfo(cwd);
    host.commit({
      t: "session.hello",
      proc: `dsh:${id}`,
      agent: AGENT,
      agent_name: NAME,
      kind: "dsh",
      label: host.label(id),
      session_id: id,
      cwd,
      root: g.root,
      repo: g.repo,
      branch: g.branch,
      host: os.hostname().split(".")[0],
      channel: true,
      launch: lid,
      started: new Date().toISOString(),
      prompt: prompt ? short(prompt, 2000) : undefined,
    });
    host.changed(id, true);
    return post(id);
  }

  function setBusy(id, busy) {
    const s = post(id);
    const c = conv(id);
    if (!s) return;
    if (busy && !s.busy) {
      if (s.state === "done") host.commit({ t: "session.hello", proc: `dsh:${id}`, agent: AGENT, kind: "dsh", label: s.label, session_id: id, channel: true });
      host.commit({ t: "session.status", post: id, state: "working", turn: "start" });
    } else if (!busy && s.busy) {
      host.commit({ t: "session.status", post: id, state: "idle", text: "Waiting for your next message", turn: "end", settle_permissions: true });
    }
    c.busy = busy;
  }

  /* ---------- ACP: dsh's Agent Client Protocol server ---------- */

  let acp = null; // { child, rpc, write, ready, http, open: Set(sessions open in it) }

  function startAcp() {
    if (acp) return acp.ready;
    const cmd = bin();
    if (!cmd) return Promise.reject(new Error("DeepSeek Harness isn't installed here (the dsh command)."));
    const child = spawn(cmd, ["--profile", "acp"], { stdio: ["pipe", "pipe", "pipe"] });
    const waiting = new Map();
    let nextId = 1;
    let err = "";
    const write = (m) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
    const rpc = (method, params, timeout = 120e3) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = timeout ? setTimeout(() => (waiting.delete(id), reject(new Error(`dsh didn't answer ${method}`))), timeout) : null;
        waiting.set(id, { resolve, reject, timer });
        write({ id, method, params });
      });
    const failAll = (e) => {
      for (const w of waiting.values()) clearTimeout(w.timer), w.reject(e);
      waiting.clear();
    };
    child.stdin.on("error", () => {}); // it stopped: "exit" says so
    child.on("error", (e) => failAll(new Error(e.code === "ENOENT" ? "DeepSeek Harness isn't installed here (the dsh command)." : e.message)));
    child.on("exit", (code) => {
      const why = err.trim().split("\n").filter(Boolean).at(-1);
      failAll(new Error(`dsh's ACP server stopped${why ? `: ${short(why, 200)}` : code ? ` (exit ${code})` : "."}`));
      if (acp?.child === child) acp = null;
    });
    child.stderr.on("data", (d) => (err = (err + d).slice(-4000))); // its logs, for when it stops
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        return;
      }
      if (m.id != null && waiting.has(m.id) && !m.method) {
        const w = waiting.get(m.id);
        waiting.delete(m.id);
        clearTimeout(w.timer);
        // Its errors say what kind they are first ("Internal error: <what went wrong>").
        return m.error ? w.reject(new Error(String(m.error.message || "dsh refused").replace(/^(Internal error|Invalid params): /, ""))) : w.resolve(m.result);
      }
      if (m.method === "session/update") return onUpdate(m.params || {});
      if (m.method === "session/request_permission") return askPermission(m, write);
      if (m.method && m.id != null) write({ id: m.id, error: { code: -32601, message: `agentbook can't handle ${m.method}` } });
    });
    const self = { child, rpc, write, http: false, open: new Set() };
    self.ready = rpc("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "agentbook", version: "2" } }, 60e3).then((r) => {
      self.http = !!r?.agentCapabilities?.mcpCapabilities?.http;
      lastError = null;
      return self;
    });
    self.ready.catch((e) => {
      lastError = e.message;
      child.kill();
    });
    acp = self;
    return self.ready;
  }

  // agentbook's MCP server for a session, writing to its post (`proc`): by its address, which dsh takes, else through
  // a bridge it runs.
  function equip(a, proc, cwd) {
    // (A bridge reads this machine's key itself, as a command line is anyone's to see.)
    const { url } = host.mcp(proc, cwd, { bridged: !a.http });
    const home = process.env.AGENTBOOK_HOME;
    return [a.http ? { type: "http", name: "agentbook", url, headers: [] } : { name: "agentbook", command: process.execPath, args: [BRIDGE, url], env: home ? [{ name: "AGENTBOOK_HOME", value: home }] : [] }];
  }

  // What dsh says while a turn runs, on its post's steps.
  function onUpdate({ sessionId: id, update: u }) {
    if (!id || !u || !posts.has(id)) return;
    const c = conv(id);
    const d = c.digest;
    const at = new Date().toISOString();
    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        const text = u.content?.type === "text" ? u.content.text || "" : "";
        if (!text.trim()) return;
        addSay(d, { id: `${u.messageId || "m"}-${d.steps.length}`, at, text });
        c.reply = c.replyOf && c.replyOf === u.messageId && c.reply ? `${c.reply}\n\n${text}` : text;
        c.replyOf = u.messageId || null;
        break;
      }
      case "tool_call":
        c.calls.set(u.toolCallId, { name: u.title, args: u.rawInput });
        if (!quiet(u.title)) addTool(d, { id: u.toolCallId, at, name: u.title, args: u.rawInput, cwd: post(id)?.cwd });
        c.reply = null;
        if (quiet(u.title)) return;
        break;
      case "tool_call_update": {
        if (u.status !== "completed" && u.status !== "failed") return;
        const out = (u.content || []).map((x) => (x?.content?.type === "text" ? x.content.text : "")).join("\n").trim();
        toolDone(d, u.toolCallId, { at, error: u.status === "failed" ? out || "Failed" : null, output: out });
        break;
      }
      case "usage_update":
        if (u.used) d.context = u.used;
        break;
      case "config_option_update":
        noteOptions(id, u.configOptions);
        break;
      default:
        return;
    }
    host.changed(id);
  }

  function noteOptions(id, options) {
    const m = modelsOf(options);
    if (!m) return;
    if (JSON.stringify(m) !== JSON.stringify(models)) {
      models = m;
      try {
        fs.mkdirSync(path.dirname(MODELS_FILE()), { recursive: true });
        fs.writeFileSync(MODELS_FILE(), JSON.stringify(m));
      } catch {}
    }
    if (id && m.default) conv(id).digest.model = m.default.split("/").slice(1).join("/");
  }

  // dsh asks before a tool runs (by its call's id): Allow/Deny on the post, with what the call was.
  function askPermission(m, write) {
    const p = m.params || {};
    const id = p.sessionId;
    if (!post(id)) return write({ id: m.id, result: { outcome: { outcome: "cancelled" } } });
    const key = `ds-${m.id}`;
    asks.set(key, { rpcId: m.id, options: p.options || [], write });
    const call = conv(id).calls.get(p.toolCall?.toolCallId) || {};
    const args = call.args && typeof call.args === "object" ? call.args : {};
    const name = String(call.name || p.toolCall?.title || "");
    host.commit({
      t: "question.ask",
      post: id,
      kind: "permission",
      request_id: key,
      title: "Allow this?",
      tool_name: /^(bash|pwsh|shell|exec)/i.test(name) ? "Terminal" : name || NAME,
      detail: name ? toolTitle(name, call.args, post(id)?.cwd) : `${NAME} wants to go ahead with this.`,
      preview: String(args.command ?? args.file_path ?? args.path ?? args.url ?? ""),
    });
  }

  async function answer(id, e) {
    if (e.type !== "permission") return false;
    const a = asks.get(e.request_id);
    if (!a) return false;
    asks.delete(e.request_id);
    const yes = e.behavior === "allow";
    const pick = a.options.find((o) => o.kind === (yes ? "allow_once" : "reject_once")) || a.options.find((o) => (yes ? /^allow/ : /^(reject|deny)/).test(o.kind || o.optionId || ""));
    a.write({ id: a.rpcId, result: { outcome: pick ? { outcome: "selected", optionId: pick.optionId } : { outcome: "cancelled" } } });
    return true;
  }

  // The ACP server, with the post's session open in it: resumed (with agentbook's tools) when it isn't yet.
  async function ready(id) {
    const a = await startAcp();
    if (!a.open.has(id)) {
      const cwd = post(id)?.cwd || os.homedir();
      const r = await a.rpc("session/resume", { sessionId: id, cwd, mcpServers: equip(a, `dsh:${id}`, cwd) });
      a.open.add(id);
      noteOptions(id, r?.configOptions);
    }
    return a;
  }

  // Set a config option, saying on the post when dsh won't. True when it took it.
  async function setOption(a, id, configId, value, what) {
    try {
      noteOptions(id, (await a.rpc("session/set_config_option", { sessionId: id, configId, value }))?.configOptions);
      return true;
    } catch (e) {
      say(id, `agentbook couldn't switch this thread to ${what}, so it carries on as it was: ${e.message}`);
      return false;
    }
  }
  // The model picked for the post goes with its next prompt.
  async function applyPick(a, id) {
    const pick = post(id)?.model_pick;
    if (!pick) return;
    const value = valueOfId(pick);
    if (value) await setOption(a, id, "model", value, pick);
    else say(id, `agentbook couldn't switch this thread to ${pick}: dsh's models are named provider/model.`);
    host.commit({ t: "session.model", post: id, model: null });
  }

  // A prompt as a turn: the post works until dsh answers it, and then says the turn's reply. `then`: text to go
  // after it (the first prompt's context: after, since dsh names the session after what its first prompt starts with).
  function turn(a, id, text, then) {
    const c = conv(id);
    c.reply = null;
    c.replyOf = null;
    c.started = Date.now();
    c.digest.turn++;
    setBusy(id, true);
    const prompt = [{ type: "text", text }, ...(then ? [{ type: "text", text: then }] : [])];
    a.rpc("session/prompt", { sessionId: id, prompt }, 0)
      .then((r) => {
        if (c.reply) say(id, c.reply);
        else if (r?.stopReason && !["end_turn", "cancelled"].includes(r.stopReason)) say(id, `${NAME} stopped: ${r.stopReason.replace(/_/g, " ")}.`);
      })
      .catch((e) => say(id, `${NAME} stopped: ${e.message}`))
      .finally(() => {
        c.digest.worked += Date.now() - c.started;
        c.reply = null;
        reload(id);
        setBusy(id, false);
        // What came while it worked goes now: what dsh couldn't take then, and what's waiting on the post.
        if (c.queue.length) send(id, c.queue.splice(0).join("\n\n")).catch((e) => say(id, `couldn't reach ${NAME}: ${e.message}`));
        else if (host.pending(id).length) deliver(id);
      });
  }

  // A message as the post's next prompt, or, while a turn runs, after it.
  async function send(id, text) {
    const c = conv(id);
    if (c.busy) return void c.queue.push(text);
    const a = await ready(id);
    await applyPick(a, id);
    if (c.busy) return void c.queue.push(text);
    turn(a, id, text);
  }
  // A post in one of dsh's apps goes through its plugin; agentbook's own go over ACP.
  const handOn = deliverer({ host, log, name: NAME, answer: (id, e) => (elsewhere(id) ? answerThere(id, e) : answer(id, e)), send: (id, text) => (elsewhere(id) ? sendThere(id, text) : send(id, text)) });
  // Over ACP, while a turn runs only Allow/Deny goes: what you write waits for the turn to end (dsh takes one prompt at
  // a time). To a session in dsh's own apps it goes now (it reaches the model at its next step), or, while its app
  // isn't running, once it is (replyBlocked says so).
  const deliver = (id) => {
    if (elsewhere(id)) return linkFor(id) ? handOn(id) : undefined;
    if (conv(id).busy && !host.pending(id).some((o) => o.event.type === "permission")) return;
    return handOn(id);
  };

  /* ---------- dsh's plugin: the sessions in dsh's own apps ---------- */

  // Each dsh process with agentbook's plugin (plugin/dsh: its web app, its desktop app, a terminal) is a connection
  // here, and says what its sessions do as they do it. A session you start there is a post once you write to it (its
  // turns from before come from its log), with agentbook's tools from then on; its subagents are workers on its post.
  // What you write on the post, Stop, and your answers to what it asks go back through the plugin, which asks dsh as
  // its own apps do.
  const links = new Set(); // { ws, profile, plugin, pid, can, at, models, sessions: Set(session ids it said) }
  const calls = new Map(); // what agentbook asked a plugin to do: rid -> { resolve, reject, timer, link }
  const asked = new Map(); // what a plugin asks for a post: "dsp-<its key>" -> { kind, ask, id, link, questions, qids, answers }
  let rids = 0;
  // Posts whose session runs in one of dsh's apps: id -> that app's profile (web, desktop…). Kept, so after a restart
  // agentbook still doesn't write to one through its own ACP server, which would have two processes writing its log.
  const THEIRS = () => path.join(CLI_HOME, "dsh-sessions.json");
  const theirs = (() => {
    try {
      return JSON.parse(fs.readFileSync(THEIRS(), "utf8")) || {};
    } catch {
      return {};
    }
  })();
  const keepTheirs = () => {
    try {
      fs.mkdirSync(path.dirname(THEIRS()), { recursive: true });
      fs.writeFileSync(THEIRS(), JSON.stringify(theirs));
    } catch (e) {
      log(`dsh: couldn't keep ${THEIRS()}: ${e.message}`);
    }
  };
  const workerRoot = new Map(); // a subagent's session -> the post it works for
  const workers = new Map(); // post id -> Map(subagent session id -> worker, as workers.mjs says them)
  const appOf = (profile) => (profile === "web" ? "DeepSeek's web app" : profile === "desktop" ? "DeepSeek's desktop app" : `dsh (${profile || "its own app"})`);
  // Where a post's session runs now, when that isn't agentbook's ACP server: its profile, or null.
  const elsewhere = (id) => conv(id).link?.profile || theirs[id] || null;
  // Sessions open in agentbook's own ACP server are agentbook's: a plugin added to that profile too doesn't say them.
  const ours = (id) => !!acp?.open.has(id);
  // The connection a post's messages go through: the one that said its session, else one from its app (whose
  // plugin opens the session there first).
  const linkFor = (id) => {
    const c = conv(id);
    if (c.link && links.has(c.link)) return c.link;
    const app = elsewhere(id);
    return app ? [...links].find((l) => l.profile === app) || null : null;
  };

  // Something for a plugin to do ({ t: "message" | "stop" | "equip" }): it answers { t: "done", rid, error? }.
  function call(link, m, timeout = 30e3) {
    return new Promise((resolve, reject) => {
      const rid = `agentbook-${process.pid}-${Date.now().toString(36)}-${++rids}`;
      const timer = setTimeout(() => {
        calls.delete(rid);
        reject(new Error(`${appOf(link.profile)} didn't answer.`));
      }, timeout);
      timer.unref?.();
      calls.set(rid, { resolve, reject, timer, link });
      try {
        link.ws.send(JSON.stringify({ ...m, rid }));
      } catch (e) {
        clearTimeout(timer);
        calls.delete(rid);
        reject(e);
      }
    });
  }

  // What you wrote, to a session in dsh's app. It comes back from dsh as yours, with agentbook's id for it, and isn't
  // shown twice (onEvent).
  async function sendThere(id, text) {
    const link = linkFor(id);
    if (!link) throw new Error(`${appOf(elsewhere(id))} isn't running`);
    await pickThere(link, id);
    await call(link, { t: "message", id, text });
  }
  // The model picked for a post there goes with its next message, as dsh's own picker sets one.
  async function pickThere(link, id) {
    const pick = post(id)?.model_pick;
    if (!pick) return;
    if (!link.can?.includes("model")) say(id, `agentbook couldn't switch this thread to ${pick}: pick it in ${appOf(link.profile)}, or update agentbook's plugin for dsh there.`);
    else await call(link, { t: "model", id, model: pick }).catch((e) => say(id, `agentbook couldn't switch this thread to ${pick}, so it carries on as it was: ${e.message}`));
    host.commit({ t: "session.model", post: id, model: null });
  }

  // Where a thread you start goes: the dsh app running with agentbook's plugin (the one that connected last, when
  // there are two), else agentbook's own ACP server. Never the ACP profile's own plugin.
  const appLink = () =>
    process.env.AGENTBOOK_DSH_APP === "0"
      ? null
      : [...links].filter((l) => l.can?.includes("create") && l.profile !== "acp").sort((a, b) => (b.at || 0) - (a.at || 0))[0] || null;

  // A thread you start, in dsh's app: a new session there (its plugin makes it as the app's New Session does), the
  // model you picked, agentbook's tools on it, and then your message, with what agentbook tells the agents it starts
  // as context for the model. The post is the app's from then on (theirs), so what you write goes there, never to
  // agentbook's ACP server.
  async function startThere(link, { cwd, prompt, shown, lid, model, effort }) {
    const made = await call(link, { t: "create", cwd });
    const id = String(made?.id || "");
    if (!id) throw new Error(`${appOf(link.profile)} didn't say which session it made.`);
    const c = conv(id);
    c.link = link;
    c.cwd = cwd;
    c.loaded = true;
    link.sessions.add(id);
    theirs[id] = link.profile;
    keepTheirs();
    const context = await Promise.resolve(host.context?.({ launch: lid, cwd })).catch((e) => log(`dsh context: ${e.message}`));
    ensurePost(id, { cwd, lid, prompt });
    host.commit({ t: "message.add", post: id, from: "human", via: "dash", text: shown, resume: lid });
    // What you picked; else the app's own (nothing to set).
    const want = model || (effort ? link.models?.default : null);
    if (want) await call(link, { t: "model", id, model: want, effort: effort || undefined }).catch((e) => say(id, `agentbook couldn't start this thread on ${want}${effort ? ` (${effort} reasoning)` : ""}, so it runs on ${appOf(link.profile)}'s default: ${e.message}`));
    // The tools first, so its first step has them.
    await call(link, { t: "equip", id, url: host.mcp(`dsh:${id}`, cwd).url }).catch((e) => log(`dsh plugin (${link.profile}): agentbook's tools for ${id}: ${e.message}`));
    await call(link, { t: "message", id, text: prompt, context: typeof context === "string" ? context : undefined }).catch((e) => say(id, `couldn't hand your message to ${appOf(link.profile)}: ${e.message}`));
    log(`dsh: started ${id} in ${link.profile}`);
    return { id };
  }

  // agentbook's tools for a post's session there, an MCP server writing to the post. The plugin also hears from it
  // that the session is a post, so what it asks is asked here.
  function arm(link, id) {
    if (!link || !post(id)) return;
    const { url } = host.mcp(`dsh:${id}`, post(id)?.cwd || conv(id).cwd);
    call(link, { t: "equip", id, url }).catch((e) => log(`dsh plugin (${link.profile}): agentbook's tools for ${id}: ${e.message}`));
  }

  // dsh asks before a tool runs, or its ask_user_question asks you: Allow/Deny, or each question, on the post. dsh's
  // own app asks too, and whichever you answer first goes; one answered there closes it here ("settled").
  function onAsk(link, m) {
    const id = String(m.id || "");
    if (!m.ask || !post(id)) return;
    const key = `dsp-${m.ask}`;
    if (asked.has(key)) return void (asked.get(key).link = link); // asked again once its connection came back
    if (m.kind === "approval") {
      asked.set(key, { kind: "approval", ask: m.ask, id, link });
      const c = conv(id);
      const step = c.digest.byId?.get(m.call);
      const args = c.calls.get(m.call)?.args || {};
      const tool = String(m.tool || c.calls.get(m.call)?.name || "");
      return void host.commit({
        t: "question.ask",
        post: id,
        kind: "permission",
        request_id: key,
        title: "Allow this?",
        tool_name: /^(bash|pwsh|shell|exec)/i.test(tool) ? "Terminal" : tool || NAME,
        detail: short(m.reason || step?.title || `${NAME} wants to go ahead with this.`, 1000),
        preview: short(String(args.command ?? args.file_path ?? args.path ?? args.url ?? ""), 2000),
      });
    }
    if (m.kind !== "questions") return;
    const a = { kind: "questions", ask: m.ask, id, link, questions: [], qids: new Map(), answers: {} };
    asked.set(key, a);
    for (const q of (Array.isArray(m.questions) ? m.questions : []).slice(0, 8)) {
      const options = (q.options || []).slice(0, 6).map((o) => ({ label: short(String(o.label || ""), 80), detail: short(o.description, 140) || null, full: String(o.label || "") }));
      const op = host.commit({ t: "question.ask", post: id, kind: options.length ? "choice" : "text", title: short(String(q.question || "DeepSeek asks"), 300), detail: short(q.header || q.detail || "", 300), options: options.map(({ full, ...o }) => o), key: `${key}:${q.id}`, blocks: true });
      const one = { id: String(q.id), qid: `q${op.seq}`, options };
      a.questions.push(one);
      a.qids.set(one.qid, one);
    }
  }

  // Your answer, to the plugin: true when it was one of its asks.
  function answerThere(id, e) {
    if (e.type === "permission") {
      const a = asked.get(e.request_id);
      if (a?.kind !== "approval") return false;
      asked.delete(e.request_id);
      tellAsk(a, { t: "answer", ask: a.ask, value: e.behavior === "allow" ? "allow" : "deny" });
      return true;
    }
    for (const [key, a] of asked) {
      const one = a.kind === "questions" && a.qids.get(e.question_id);
      if (!one) continue;
      const v = e.skipped || e.value == null ? "" : String(e.value);
      const picked = v && one.options.find((o) => o.label === v || o.full === v);
      a.answers[one.id] = picked ? { id: one.id, selected: [picked.full] } : v ? { id: one.id, selected: [], custom: v } : { id: one.id, selected: [] };
      if (a.questions.every((q) => a.answers[q.id])) {
        asked.delete(key);
        tellAsk(a, { t: "answer", ask: a.ask, value: { answers: a.questions.map((q) => a.answers[q.id]) } });
      }
      return true;
    }
    return false;
  }
  const tellAsk = (a, m) => {
    const link = links.has(a.link) ? a.link : linkFor(a.id);
    if (!link) throw new Error(`${appOf(elsewhere(a.id))} isn't running`);
    link.ws.send(JSON.stringify(m));
  };

  // Answered in dsh's app (or it stopped asking: its turn ended): its questions here close, with that answer.
  function settleAsk(key, value, by) {
    const a = asked.get(key);
    if (!a) return;
    asked.delete(key);
    if (a.kind === "approval") {
      const q = host.state.questions.find((x) => x.request_id === key && !x.answered);
      if (q) host.commit({ t: "question.answer", qid: q.id, value: value === "allowed-once" ? "allow" : value === "rejected" ? "deny" : null, by });
      return;
    }
    for (const one of a.questions) {
      const x = Array.isArray(value) ? value.find((v) => v?.id === one.id) : null;
      const q = host.state.questions.find((y) => y.id === one.qid && !y.answered);
      if (q) host.commit({ t: "question.answer", qid: q.id, value: x ? String(x.selected?.[0] ?? x.custom ?? "") || null : null, by });
    }
  }

  function connect(ws) {
    const link = { ws, profile: "dsh", plugin: null, pid: null, sessions: new Set() };
    links.add(link);
    ws.onMessage = (text) => {
      let m;
      try {
        m = JSON.parse(text);
      } catch {
        return;
      }
      try {
        heard(link, m);
      } catch (e) {
        log(`dsh plugin (${link.profile}): ${e.message}`);
      }
    };
    // The process ended (or agentbook is): its sessions aren't running anymore, and its subagents went with it. What
    // it asked is gone with it (a plugin that comes back asks again).
    ws.onClose = () => {
      links.delete(link);
      for (const [rid, w] of calls)
        if (w.link === link) {
          calls.delete(rid);
          clearTimeout(w.timer);
          w.reject(new Error(`${appOf(link.profile)} stopped.`));
        }
      for (const [key, a] of [...asked]) if (a.link === link) settleAsk(key, null, "gone");
      const at = new Date().toISOString();
      for (const id of link.sessions) {
        const c = conv(id);
        if (c.link !== link) continue;
        c.link = null;
        if (post(id)) setBusy(id, false);
      }
      for (const [id, list] of workers)
        for (const w of list.values())
          if (link.sessions.has(w.id) && going(w)) {
            settle(w, "stopped", at, `${appOf(link.profile)} stopped.`);
            host.changed(id);
          }
    };
  }

  function heard(link, m) {
    switch (m.t) {
      case "hello":
        link.profile = short(String(m.profile || "dsh"), 40);
        link.plugin = short(String(m.plugin || ""), 20) || null;
        link.pid = Number(m.pid) || null;
        link.can = Array.isArray(m.can) ? m.can.map(String) : [];
        link.at = Date.now();
        if (!host.state.agents[AGENT]) host.commit({ t: "agent.hello", agent: AGENT, agent_name: NAME, kind: "dsh" });
        log(`dsh plugin ${link.plugin} connected from ${link.profile} (pid ${link.pid})`);
        // What you wrote while its app wasn't running goes now.
        for (const [id, app] of Object.entries(theirs)) if (app === link.profile && post(id) && host.pending(id).length) deliver(id);
        return;
      case "session":
        return onSession(link, m);
      case "models": {
        const list = (Array.isArray(m.list) ? m.list : []).filter((x) => x && typeof x.id === "string" && x.id.includes("/")).slice(0, 200).map((x) => ({ id: short(x.id, 400), name: short(String(x.name || x.id), 200), efforts: (Array.isArray(x.efforts) ? x.efforts : []).map(String).slice(0, 20), effort: x.effort ? String(x.effort) : null }));
        const def = list.find((x) => x.id === m.default) || null;
        link.models = list.length ? { list, default: def?.id || list[0].id, efforts: (def || list[0]).efforts, effort: m.effort || (def || list[0]).effort || null } : null;
        return;
      }
      case "done": {
        const w = calls.get(m.rid);
        if (!w || w.link !== link) return;
        calls.delete(m.rid);
        clearTimeout(w.timer);
        return void (m.error ? w.reject(new Error(short(String(m.error), 1000))) : w.resolve(m.value));
      }
      case "ask":
        return onAsk(link, m);
      case "settled":
        return settleAsk(`dsp-${m.ask}`, m.value ?? null, "terminal");
      case "event":
        return onEvent(link, String(m.id || ""), m.e);
      case "status":
        return onStatus(link, String(m.id || ""), m.status);
      case "error": {
        const id = String(m.id || "");
        if (!id || ours(id)) return;
        conv(id).error = short(String(m.error || "Failed"), 1000);
        return;
      }
      case "gone": {
        const id = String(m.id || "");
        const c = conv(id);
        if (c.link !== link) return;
        c.link = null;
        if (post(id)) setBusy(id, false);
        return;
      }
      case "subagent":
        return onSubagent(link, m);
    }
  }

  function onSession(link, m) {
    const id = String(m.id || "");
    if (!id || ours(id)) return;
    link.sessions.add(id);
    const c = conv(id);
    c.link = link;
    if (m.cwd) c.cwd = String(m.cwd);
    c.status = m.status || c.status || null;
    if (m.parent) {
      c.parent = String(m.parent);
      return void worker(rootFor(c.parent), id, { started: iso(m.created) });
    }
    if (!post(id)) return; // a post once you write to it
    claim(id);
    reload(id); // what it did while agentbook wasn't connected to it
    setBusy(id, c.status === "running");
    arm(link, id);
    host.changed(id);
    if (host.pending(id).length) deliver(id);
  }

  // The post is this app's session now: agentbook doesn't write to it through its own ACP server. One agentbook
  // started (a launch) is only while it's open there.
  function claim(id) {
    const c = conv(id);
    if (!c.link || post(id)?.launch || theirs[id] === c.link.profile) return;
    theirs[id] = c.link.profile;
    keepTheirs();
  }

  // A session you wrote to in dsh's app: its post, with its turns from before (its log).
  function activate(id, prompt) {
    if (post(id)) return post(id);
    const c = conv(id);
    if (!c.link) return null;
    ensurePost(id, { cwd: c.cwd || os.homedir(), prompt });
    if (host.keptOff(id)) return null; // kept off agentbook (Private terminals)
    claim(id);
    reload(id);
    if (c.status === "running") setBusy(id, true);
    arm(c.link, id);
    return post(id);
  }

  function onEvent(link, id, e) {
    if (!id || !e?.type || ours(id)) return;
    const c = conv(id);
    if (c.parent) return workerEvent(id, e);
    if (e.seq != null && c.digest.seq && e.seq <= c.digest.seq) return; // in what was read from its log already
    foldEvent(c.digest, e, c.cwd || post(id)?.cwd);
    const x = e.data || {};
    switch (e.type) {
      case "turn/start":
        c.reply = null;
        break;
      // It started a subagent (dsh's subagent tool): a worker on its post, named as it named it.
      case "subagent/catalog":
        if (x.childId) worker(id, String(x.childId), { started: iso(x.childCreatedAt), title: x.label });
        break;
      case "user/message": {
        // What you wrote: dsh's other user messages are what it tells the model (its instructions, the time…). What
        // you wrote here (agentbook's id for it) is on the post already.
        const text = textOf(x.content);
        if (x.source?.kind !== "user" || !text || String(x.source.rpcId || "").startsWith("agentbook-")) break;
        if (!activate(id, text)) break;
        host.commit({ t: "message.add", post: id, from: "human", via: "terminal", text: short(text, 16000) });
        break;
      }
      case "assistant/message": {
        const blocks = x.message?.content || [];
        const said = textOf(blocks);
        // Its reply is what it says last in a turn, with no tool to run after it.
        c.reply = blocks.some((b) => /^tool[-_]?call$|^toolCall$/.test(b?.type || "")) ? null : said || c.reply;
        break;
      }
      case "tool/call": {
        c.reply = null;
        // What it calls, for an Allow/Deny that asks about it.
        let args = x.arguments;
        try {
          args = typeof args === "string" ? JSON.parse(args) : args;
        } catch {}
        if (x.callId) c.calls.set(x.callId, { name: x.name, args: args && typeof args === "object" ? args : {} });
        if (c.calls.size > 200) c.calls.delete(c.calls.keys().next().value);
        break;
      }
      case "turn/end":
        if (post(id)) {
          if (c.reply) say(id, c.reply);
          else if (c.error) say(id, `${NAME} stopped: ${c.error}`);
        }
        c.reply = null;
        c.error = null;
        break;
    }
    if (post(id)) host.changed(id);
  }

  function onStatus(link, id, status) {
    if (!id || ours(id)) return;
    const c = conv(id);
    c.status = status;
    if (c.parent) return void (status === "running" && workerIs(id, "running"));
    if (!post(id)) return;
    setBusy(id, status === "running");
    // An error with no turn to end (it couldn't start one) is said once it stops.
    if (status !== "running" && c.error) {
      say(id, `${NAME} stopped: ${c.error}`);
      c.error = null;
    }
  }

  /* ---------- its subagents, as workers ---------- */

  // dsh's subagents run in the background, and one that finished waits for more (its parent can send it some): it's
  // done until it works again. One ends for good (subagent/end) when dsh lets it go.
  const rootFor = (id) => workerRoot.get(id) || id;
  function worker(root, id, { started, title } = {}) {
    workerRoot.set(id, root);
    const list = workers.get(root) || workers.set(root, new Map()).get(root);
    if (!list.has(id)) list.set(id, { id, title: "A subagent", state: "running", started: started || new Date().toISOString(), ended: null, error: null, step: null, n: 0 });
    const w = list.get(id);
    if (title) w.title = w.named = short(String(title), 120);
    return w;
  }
  // A worker working again, or done with what it had.
  function workerIs(id, state, why = null) {
    const root = rootFor(conv(id).parent || id);
    const w = worker(root, id);
    if (w.state === state) return;
    settle(w, state, new Date().toISOString(), why);
    if (state !== "running") w.step = null;
    host.changed(root);
  }
  // How a subagent ended, as dsh says it: its stopReason.
  const ENDED = { completed: ["done"], aborted: ["stopped"], error: ["failed"], "max-tokens": ["failed", "It ran out of tokens."], refusal: ["failed", "It refused."] };
  function onSubagent(link, m) {
    const id = String(m.id || "");
    if (!id || !m.parent) return;
    link.sessions.add(id);
    const c = conv(id);
    c.parent = String(m.parent);
    c.link = link;
    const root = rootFor(c.parent);
    const w = worker(root, id);
    const at = new Date().toISOString();
    if (m.state === "start") settle(w, "running", at);
    else {
      const [state, why] = ENDED[m.reason] || [stateOf(m.reason) || "done"];
      settle(w, state, at, why || null);
      w.step = null;
    }
    host.changed(root);
  }
  function workerEvent(id, e) {
    const c = conv(id);
    if (e.seq != null && c.digest.seq && e.seq <= c.digest.seq) return;
    const root = rootFor(c.parent);
    const w = worker(root, id);
    foldEvent(c.digest, e, c.cwd || post(root)?.cwd);
    const d = c.digest;
    w.title = w.named || d.label || d.ai_title || w.title;
    w.n = d.tools;
    if (e.type === "turn/start") workerIs(id, "running");
    else if (e.type === "turn/end") {
      const kind = e.data?.reason?.kind;
      workerIs(id, kind === "failed" ? "failed" : kind === "cancelled" || kind === "aborted" ? "stopped" : "done", kind === "failed" ? c.error || null : null);
      c.error = null;
    }
    const last = [...d.steps].reverse().find((x) => x.kind === "tool");
    if (going(w) && last) w.step = { title: last.title, at: last.at };
    host.changed(root);
  }
  // A worker's steps, as its post's page opens it: what came as it worked, else its log.
  const WORKER_STEPS = 40;
  function workerSteps(id, wid) {
    if (!workers.get(id)?.has(wid)) return null;
    const c = conv(wid);
    let d = c.digest;
    if (!d.steps.length) {
      const events = readLog(wid);
      if (events?.length) d = digestOf(events, post(id)?.cwd);
    }
    return { steps: d.steps.slice(-WORKER_STEPS).map(({ id, kind, at, tool, title, text, done, error }) => ({ id, kind, at, tool, title, text, done, error })), n: d.tools };
  }

  async function start({ cwd, prompt, shown = prompt, lid, model, effort }) {
    if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`No folder at ${cwd}`);
    const link = appLink();
    if (link) {
      try {
        return await startThere(link, { cwd, prompt, shown, lid, model, effort });
      } catch (e) {
        // Its app couldn't make the session: agentbook's own ACP server does.
        log(`dsh: couldn't start a session in ${link.profile} (${e.message}), so it starts in agentbook's ACP server`);
        if (!bin()) throw new Error(`${appOf(link.profile)} couldn't start it: ${e.message}`);
      }
    }
    const a = await startAcp();
    // Its post doesn't exist until dsh names the session: the tools write to the launch's until then.
    const context = await Promise.resolve(host.context?.({ launch: lid, cwd })).catch((e) => log(`dsh context: ${e.message}`));
    const r = await a.rpc("session/new", { cwd, mcpServers: equip(a, `launch:${lid}`, cwd) });
    const id = r.sessionId;
    a.open.add(id);
    const c = conv(id);
    c.loaded = true;
    noteOptions(id, r.configOptions);
    // What you picked, else what you picked in dsh's own apps.
    const mine = model ? null : defaultModel();
    const want = model || mine?.id;
    const now = models?.default;
    if (want && want !== now && valueOfId(want)) await setOption(a, id, "model", valueOfId(want), want);
    const how = effort || mine?.effort;
    if (how && models?.efforts?.includes(how) && how !== models.effort) await setOption(a, id, "reasoning_effort", how, `${how} reasoning`);
    ensurePost(id, { cwd, lid, prompt });
    host.commit({ t: "message.add", post: id, from: "human", via: "dash", text: shown, resume: lid });
    turn(a, id, prompt, typeof context === "string" ? context : null);
    return { id };
  }

  async function stop(id) {
    if (elsewhere(id)) {
      const link = linkFor(id);
      if (!link) throw new Error(`${appOf(elsewhere(id))} isn't running.`);
      if (!conv(id).busy) throw new Error("It isn't running.");
      return void (await call(link, { t: "stop", id }));
    }
    if (!conv(id).busy || !acp) throw new Error("It isn't running.");
    acp.write({ method: "session/cancel", params: { sessionId: id } });
  }

  function begin() {
    if (!enabled) return;
    if (bin() && !host.state.agents[AGENT]) host.commit({ t: "agent.hello", agent: AGENT, agent_name: NAME, kind: "dsh" });
    // What dsh's apps asked before agentbook stopped: their plugins ask again once they're back.
    for (const q of host.state.questions) if (!q.answered && /^dsp-/.test(q.request_id || q.key || "")) host.commit({ t: "question.answer", qid: q.id, value: null, by: "gone" });
    for (const s of Object.values(host.state.sessions)) {
      if (!s.proc?.startsWith("dsh:")) continue;
      // A turn that ran when agentbook stopped ended with it: dsh's ACP server was agentbook's child. One in dsh's own
      // apps says it's running again when its plugin connects.
      if (s.busy) host.commit({ t: "session.status", post: s.id, state: "idle", text: "Waiting for your next message", turn: "end", settle_permissions: true });
      if (host.pending(s.id).length) deliver(s.id);
    }
  }

  const digest = (id) => {
    const c = conv(id);
    if (!c.loaded && post(id)) reload(id);
    return c.digest;
  };

  return {
    prefix: "dsh",
    name: NAME,
    owns: (id) => id === AGENT && host.state.agents[id]?.kind === "dsh",
    begin,
    start,
    stop,
    deliver,
    steps: async (id) => digest(id),
    live: (s) => liveOf(posts.get(s.id)?.digest),
    summary: (s) => summaryOf(digest(s.id), s),
    working: (id) => !!posts.get(id)?.busy,
    workers: (id) => [...(workers.get(id)?.values() || [])].map(({ named, ...w }) => w),
    workerSteps: async (id, wid) => workerSteps(id, wid),
    models: () => {
      // Threads start in dsh's app while it runs: its models, with its keys.
      const app = appLink();
      if (app?.models) return app.models;
      const mine = defaultModel();
      return models && mine && models.list.some((m) => m.id === mine.id) ? { ...models, default: mine.id, effort: mine.effort || models.effort } : models;
    },
    switchesModel: true,
    replyBlocked: (s) => (elsewhere(s.id) && !linkFor(s.id) ? `This thread runs in ${appOf(elsewhere(s.id))}, which isn't running: start it, and you can write to this thread again.` : null),
    resumeCommand: () => null, // its session stays open in agentbook's dsh, which a terminal can't share
    // A connection from dsh's plugin (/api/dsh/ws). Refused while DeepSeek Harness is off here.
    connect: (ws) => (enabled ? connect(ws) : ws.close(1008, "DeepSeek Harness is off here (AGENTBOOK_DSH=0).")),
    status: () => ({ enabled, installed: !!bin(), running: !!acp, error: lastError, plugin: [...links].map((l) => ({ profile: l.profile, version: l.plugin, pid: l.pid })), startsIn: appLink()?.profile || null }),
  };
}
