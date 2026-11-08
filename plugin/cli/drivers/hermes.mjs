// Hermes Agent (Nous Research) sessions. Hermes keeps every session in its SQLite database
// (~/.hermes/state.db, or $HERMES_HOME/state.db), which agentbook reads, read-only, for what to show; it steers
// sessions through `hermes acp`, Hermes's Agent Client Protocol server (JSON-RPC over stdio), run as a child.
//
// - Hermes is a profile ("hermes"), and each session people have with it a post: from its terminal app, its
//   desktop app, ACP clients and chat channels (Telegram, Discord…). Subagent, tool, cron and one-shot runs stay
//   off. A conversation Hermes compressed into a new session stays one post.
// - New message rows are the post's conversation and steps: tool calls are steps, the tool rows their results.
//   A session holding a turn lease is working.
// - Posting on Hermes's wall starts an ACP session in the folder picked. Writing on a post sends a prompt: over
//   ACP for sessions started that way (loading them first after a restart), or `hermes chat --resume` for its
//   terminal sessions, which can't ask for approvals (Hermes denies them). Chat-channel sessions are read-only
//   here: their channel delivers them. Stop cancels an ACP turn, or interrupts a `hermes chat` agentbook runs.
// - ACP's permission requests are Allow/Deny on the post; Hermes denies one left unanswered for 5 minutes.
//   Hermes has no questions to ask over ACP.
// - The ACP sessions agentbook starts or loads have agentbook's tools (ab_post, ab_ask…): its MCP server, at its
//   /api/mcp address when Hermes takes MCP servers over HTTP, or through a bridge it starts (mcp/http-bridge.mjs).

import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "../../shared/db.mjs";
import { addSay, addTool, blank, deliverer, iso, liveOf, short, summaryOf, toolDone, toolTitle } from "./steps.mjs";
import { shown as shownWorkers, stateOf } from "../workers.mjs";

const HOME_DIR = () => process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
const DAYS = Number(process.env.AGENTBOOK_HERMES_DAYS || 14);
const HIDDEN_SOURCES = new Set(["subagent", "tool", "cron", "oneshot", "kanban", "batch"]);
const CHANNELS = new Set(["telegram", "discord", "slack", "whatsapp", "signal", "matrix", "email", "sms", "api_server", "homeassistant"]);
const AGENT = "hermes";
const BOOT = Date.now() / 1000; // sessions that started since are new; older ones' messages are history
const BRIDGE = fileURLToPath(new URL("../../mcp/http-bridge.mjs", import.meta.url));

const textOf = (content) => {
  if (content == null) return "";
  if (typeof content !== "string") return Array.isArray(content) ? content.map((c) => c?.text || "").join("\n") : String(content);
  const t = content.trim();
  if (t.startsWith("[") && t.endsWith("]")) {
    try {
      return JSON.parse(t)
        .map((c) => c?.text || "")
        .join("\n");
    } catch {}
  }
  return content;
};
const parse = (s) => {
  try {
    return typeof s === "string" ? JSON.parse(s) : s;
  } catch {
    return null;
  }
};

// host: { state, commit, pending, label, describe, attached, gitInfo, changed, log }
export function createHermes(host) {
  const log = host.log || (() => {});
  const bin = () => process.env.AGENTBOOK_HERMES_BIN || "hermes";
  const enabled = process.env.AGENTBOOK_HERMES !== "0";
  let db = null;
  let lastError = null;
  const posts = new Map(); // post id (a conversation's first session) -> { last: Map(session -> message row id read), digest, sent: [], busy, source, sessions: Set }
  const rootOf = new Map(); // session id -> its post id
  const asks = new Map(); // question request key -> { rpcId, options }
  const running = new Map(); // post id -> a `hermes chat` child agentbook runs
  let workers = new Map(); // post id -> its subagents, as workers (noteWorkers)

  /* ---------- the database ---------- */

  function open() {
    if (db) return db;
    const file = path.join(HOME_DIR(), "state.db");
    if (!fs.existsSync(file)) return null;
    db = new DatabaseSync(file, { readOnly: true });
    return db;
  }
  const all = (sql, ...args) => open()?.prepare(sql).all(...args) || [];

  const post = (id) => host.state.sessions[id];
  const conv = (id) => {
    if (!posts.has(id)) posts.set(id, { last: new Map(), digest: blank(), sent: [], busy: false, source: null, sessions: new Set([id]) });
    return posts.get(id);
  };

  // A session Hermes compressed continues in a child session: both are the one post, keyed by the first.
  function rootId(row, byId) {
    let r = row;
    for (let i = 0; i < 50 && r?.parent_session_id; i++) {
      const parent = byId.get(r.parent_session_id) || all("SELECT id, parent_session_id, end_reason FROM sessions WHERE id = ?", r.parent_session_id)[0];
      if (!parent || parent.end_reason !== "compression") break;
      r = parent;
    }
    return r.id;
  }

  function ensurePost(id, row, { lid, prompt } = {}) {
    const c = conv(id);
    c.source = row.source || c.source;
    if (row.title) c.digest.ai_title = short(row.title, 120);
    if (row.model) c.digest.model = row.model;
    if (post(id) && !lid) return post(id);
    const cwd = row.cwd || parse(row.model_config)?.cwd || "";
    const g = host.gitInfo(cwd);
    host.commit({
      t: "session.hello",
      proc: `hermes:${id}`,
      agent: AGENT,
      agent_name: "Hermes",
      kind: "hermes",
      label: host.label(id),
      session_id: id,
      cwd,
      root: g.root,
      repo: g.repo,
      branch: row.git_branch || g.branch,
      host: os.hostname().split(".")[0],
      channel: true,
      launch: lid,
      started: iso(row.started_at) || undefined,
      updated: iso(row.last_activity_at || row.started_at) || undefined,
      prompt: prompt ? short(prompt, 2000) : undefined,
    });
    host.changed(id, true);
    return post(id);
  }

  // Fold new message rows into their post. `live`: they happened now, so they join its conversation.
  function take(id, session, rows, live) {
    const c = conv(id);
    for (const m of rows) {
      c.last.set(session, Math.max(c.last.get(session) || 0, m.id));
      if (m.display_kind === "hidden") continue;
      const { text, calls } = fold(c.digest, m, post(id)?.cwd);
      if (m.role === "user") {
        const mine = c.sent.indexOf(text);
        if (mine >= 0) c.sent.splice(mine, 1);
        else if (live && text) host.commit({ t: "message.add", post: id, from: "human", via: c.source && c.source !== "acp" ? c.source : "terminal", text });
      }
      // A reply with no tools to run ends the turn: it's what Hermes says on the post.
      else if (m.role === "assistant" && live && text && !calls.length) host.commit({ t: "message.add", post: id, from: "agent", via: "dash", text });
    }
  }
  // A message row on a digest: a turn begun, what it said and the tools it called, or how one of them went.
  function fold(d, m, cwd) {
    const at = iso(m.timestamp) || new Date().toISOString();
    const text = textOf(m.content).trim();
    const calls = m.role === "assistant" ? parse(m.tool_calls) || [] : [];
    if (m.role === "user") d.turn++;
    else if (m.role === "assistant") {
      if (text) addSay(d, { id: `m${m.id}`, at, text });
      for (const call of calls) addTool(d, { id: call.id, at, name: call.function?.name || call.name, args: call.function?.arguments ?? call.arguments, cwd });
    } else if (m.role === "tool") toolDone(d, m.tool_call_id, { at, error: /^(error|failed)\b/i.test(text) ? text : null, output: text });
    return { text, calls };
  }

  const MESSAGES = "SELECT id, role, content, tool_calls, tool_call_id, tool_name, timestamp, display_kind FROM messages WHERE session_id = ? AND active = 1 AND id > ? ORDER BY timestamp, id";

  /* ---------- keeping up ---------- */

  function sync() {
    if (!enabled || !open()) return;
    try {
      const since = Math.max(Date.now() / 1000 - DAYS * 86400, (host.historyFrom?.() || 0) / 1000);
      const rows = all("SELECT id, source, title, started_at, ended_at, last_activity_at, cwd, model, model_config, git_branch, parent_session_id, end_reason, hidden FROM sessions WHERE hidden = 0 AND (last_activity_at > ? OR started_at > ?) ORDER BY started_at", since, since);
      const byId = new Map(rows.map((r) => [r.id, r]));
      const leased = new Set(all("SELECT conversation_id FROM session_turn_leases WHERE expires_at > ?", Date.now() / 1000).map((r) => r.conversation_id));
      const busy = new Map(); // post -> working
      const subs = [];
      for (const row of rows) {
        if (row.source === "subagent") subs.push(row);
        if (HIDDEN_SOURCES.has(row.source)) continue;
        const id = rootId(row, byId);
        rootOf.set(row.id, id);
        const c = conv(id);
        c.sessions.add(row.id);
        // A session's first read is its history, unless it started since agentbook did.
        const read = c.last.has(row.id);
        const rowsNew = all(MESSAGES, row.id, c.last.get(row.id) || 0);
        if (!read) c.last.set(row.id, 0);
        if (!post(id)) {
          if (!rowsNew.length && !leased.has(row.id)) continue; // nothing in it yet
          const first = rowsNew.find((m) => m.role === "user");
          take(id, row.id, rowsNew, false);
          ensurePost(id, byId.get(id) || row, { prompt: first ? textOf(first.content) : undefined });
        } else {
          ensurePost(id, byId.get(id) || row);
          if (rowsNew.length) {
            take(id, row.id, rowsNew, read || row.started_at > BOOT);
            host.changed(id);
          }
        }
        busy.set(id, busy.get(id) || leased.has(row.id) || running.has(id) || acpTurns.has(id));
      }
      for (const [id, b] of busy) setBusy(id, b);
      noteWorkers(subs, leased);
      lastError = null;
    } catch (e) {
      if (lastError !== e.message) log(`hermes: ${(lastError = e.message)}`);
      try {
        db?.close();
      } catch {}
      db = null;
    }
  }

  // A session's agent can delegate to subagents, sessions of their own (source "subagent") that stay off agentbook:
  // each is a worker (workers.mjs) of the post its parent session is on. One holding a turn lease is running, and so is
  // one that hasn't ended while its post's turn goes on (the turn waits for it); one that ended says how by why it
  // ended. The tool it last called is its step while it runs.
  function noteWorkers(rows, leased) {
    const next = new Map();
    for (const row of rows) {
      const id = row.parent_session_id && rootOf.get(row.parent_session_id);
      if (!id || !post(id)) continue;
      const going = leased.has(row.id) || (!row.ended_at && conv(id).busy);
      const why = String(row.end_reason || "");
      const state = going ? "running" : stateOf(why) || (/error|fail/i.test(why) ? "failed" : /interrupt|cancel|abort|kill/i.test(why) ? "stopped" : "done");
      const w = { id: row.id, title: short(row.title || "A subagent", 120), state, started: iso(row.started_at), ended: going ? null : iso(row.ended_at || row.last_activity_at), error: state === "failed" && why ? short(why, 300) : null, step: going ? lastStep(row.id, id) : null };
      (next.get(id) || next.set(id, []).get(id)).push(w);
    }
    // Those its post shows, each with how many tools it called, which its post's page reads its steps by.
    for (const [id, list] of next) next.set(id, shownWorkers(list));
    const ids = [...next.values()].flat().map((w) => w.id);
    const n = new Map(ids.length ? all(`SELECT session_id, SUM(CASE WHEN json_valid(tool_calls) AND json_type(tool_calls) = 'array' THEN json_array_length(tool_calls) ELSE 0 END) AS n FROM messages WHERE active = 1 AND role = 'assistant' AND tool_calls IS NOT NULL AND session_id IN (${ids.map(() => "?").join()}) GROUP BY session_id`, ...ids).map((r) => [r.session_id, r.n]) : []);
    for (const w of [...next.values()].flat()) w.n = n.get(w.id) || 0;
    workers = next;
  }
  // A worker's steps, from its own session's messages: read when you open it on its post's page. Its latest WORKER_STEPS.
  const WORKER_STEPS = 40;
  function workerSteps(id, worker) {
    if (!(workers.get(id) || []).some((w) => w.id === worker) || !open()) return null;
    const d = blank();
    for (const m of all(MESSAGES, worker, 0)) if (m.display_kind !== "hidden") fold(d, m, post(id)?.cwd);
    return { steps: d.steps.slice(-WORKER_STEPS).map(({ id, kind, at, tool, title, text, done, error }) => ({ id, kind, at, tool, title, text, done, error })), n: d.tools };
  }
  function lastStep(session, id) {
    const m = all("SELECT tool_calls, timestamp FROM messages WHERE session_id = ? AND active = 1 AND role = 'assistant' AND tool_calls IS NOT NULL ORDER BY id DESC LIMIT 1", session)[0];
    const call = (parse(m?.tool_calls) || []).at(-1);
    return call ? { title: toolTitle(call.function?.name || call.name, call.function?.arguments ?? call.arguments, post(id)?.cwd), at: iso(m.timestamp) } : null;
  }

  function setBusy(id, busy) {
    const s = post(id);
    const c = conv(id);
    if (!s) return;
    if (busy && !s.busy) {
      if (s.state === "done") host.commit({ t: "session.hello", proc: `hermes:${id}`, agent: AGENT, kind: "hermes", label: s.label, session_id: id, channel: true });
      host.commit({ t: "session.status", post: id, state: "working", turn: "start" });
    } else if (!busy && s.busy) {
      host.commit({ t: "session.status", post: id, state: "idle", text: "Waiting for your next message", turn: "end", settle_permissions: true });
    }
    c.busy = busy;
  }

  /* ---------- ACP: Hermes's Agent Client Protocol server ---------- */

  let acp = null; // { child, rpc, ready }
  const acpTurns = new Set(); // posts with an ACP prompt running
  const acpLoaded = new Set(); // ACP sessions loaded in this child

  function startAcp() {
    if (acp) return acp.ready;
    const child = spawn(bin(), ["acp"], { env: { ...process.env, HERMES_ACP_SKIP_CONFIGURED_MCP: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    const waiting = new Map();
    let nextId = 1;
    const write = (m) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
    const rpc = (method, params, timeout = 120e3) =>
      new Promise((resolve, reject) => {
        const id = nextId++;
        const timer = timeout ? setTimeout(() => (waiting.delete(id), reject(new Error(`Hermes didn't answer ${method}`))), timeout) : null;
        waiting.set(id, { resolve, reject, timer });
        write({ id, method, params });
      });
    child.on("error", (e) => {
      for (const w of waiting.values()) w.reject(new Error(e.code === "ENOENT" ? "Hermes isn't installed here." : e.message));
      waiting.clear();
    });
    child.on("exit", () => {
      for (const w of waiting.values()) w.reject(new Error("Hermes's ACP server stopped."));
      waiting.clear();
      acpLoaded.clear();
      acpTurns.clear();
      acp = null;
    });
    child.stderr.on("data", () => {}); // its logs
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
        return m.error ? w.reject(new Error(m.error.message || "Hermes refused")) : w.resolve(m.result);
      }
      if (m.method === "session/request_permission") return askPermission(m, write);
      if (m.method && m.id != null) write({ id: m.id, error: { code: -32601, message: `agentbook can't handle ${m.method}` } });
    });
    const ready = rpc("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "agentbook", version: "2" } }, 60e3).then((r) => {
      acp.http = !!r?.agentCapabilities?.mcpCapabilities?.http;
      return acp;
    });
    acp = { child, rpc, write, ready, http: false };
    ready.catch(() => child.kill());
    return ready;
  }

  function askPermission(m, write) {
    const p = m.params || {};
    const id = rootOf.get(p.sessionId) || p.sessionId;
    if (!post(id)) return write({ id: m.id, result: { outcome: { outcome: "cancelled" } } });
    const key = `hm-${m.id}`;
    asks.set(key, { rpcId: m.id, options: p.options || [], write });
    const tc = p.toolCall || {};
    const input = tc.rawInput || {};
    host.commit({ t: "question.ask", post: id, kind: "permission", request_id: key, title: "Allow this?", tool_name: tc.kind === "execute" ? "Terminal" : tc.title || "Hermes", detail: tc.title || "Hermes wants to go ahead with this.", preview: input.command || input.path || "" });
  }

  async function answer(id, e) {
    if (e.type !== "permission") return false;
    const a = asks.get(e.request_id);
    if (!a) return false;
    asks.delete(e.request_id);
    const yes = e.behavior === "allow";
    const pick = a.options.find((o) => (yes ? o.kind === "allow_once" || o.optionId === "allow_once" : o.kind === "reject_once" || o.optionId === "deny")) || a.options.find((o) => (yes ? /^allow/.test(o.kind || o.optionId) : /^(reject|deny)/.test(o.kind || o.optionId)));
    a.write({ id: a.rpcId, result: { outcome: pick ? { outcome: "selected", optionId: pick.optionId } : { outcome: "cancelled" } } });
    return true;
  }

  // agentbook's MCP server for a session, writing to its post (`proc`), as ACP hands an agent MCP servers: by its
  // address when Hermes said it takes HTTP ones, else as a command, which every ACP agent runs.
  function equip(a, proc, cwd) {
    // (A bridge reads this machine's key itself, as a command line is anyone's to see.)
    const { url } = host.mcp(proc, cwd, { bridged: !a.http });
    const home = process.env.AGENTBOOK_HOME;
    return [a.http ? { type: "http", name: "agentbook", url, headers: [] } : { name: "agentbook", command: process.execPath, args: [BRIDGE, url], env: home ? [{ name: "AGENTBOOK_HOME", value: home }] : [] }];
  }

  // Send a prompt over ACP, and keep the post working until its turn ends.
  async function acpPrompt(id, sessionId, text) {
    const a = await startAcp();
    if (!acpLoaded.has(sessionId)) {
      const cwd = post(id)?.cwd || os.homedir();
      await a.rpc("session/load", { sessionId, cwd, mcpServers: equip(a, `hermes:${id}`, cwd) });
      acpLoaded.add(sessionId);
    }
    acpTurns.add(id);
    setBusy(id, true);
    a.rpc("session/prompt", { sessionId, prompt: [{ type: "text", text }] }, 0)
      .catch((e) => host.commit({ t: "message.add", post: id, from: "agent", via: "dash", text: `Hermes stopped: ${e.message}` }))
      .finally(() => {
        acpTurns.delete(id);
        sync();
        setBusy(id, false);
      });
  }

  // A terminal session continues with `hermes chat --resume`, without approvals (Hermes denies them).
  function chatResume(id, sessionId, text) {
    return new Promise((resolve, reject) => {
      const child = spawn(bin(), ["chat", "--resume", sessionId, "--query-file", "-", "-Q", "--format", "stream-json", "--source", "cli"], { cwd: post(id)?.cwd && fs.existsSync(post(id).cwd) ? post(id).cwd : os.homedir(), stdio: ["pipe", "pipe", "pipe"] });
      let err = "";
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => reject(new Error(e.code === "ENOENT" ? "Hermes isn't installed here." : e.message)));
      child.on("spawn", () => {
        running.set(id, child);
        setBusy(id, true);
        resolve();
      });
      child.on("exit", (code) => {
        running.delete(id);
        sync();
        setBusy(id, false);
        if (code && code !== 130) host.commit({ t: "message.add", post: id, from: "agent", via: "dash", text: `Hermes couldn't continue it: ${short(err.trim().split("\n").at(-1) || `exit ${code}`, 300)}` });
      });
      child.stdin.end(text);
    });
  }

  const newest = (id) => [...conv(id).sessions].at(-1) || id;
  async function send(id, text) {
    const c = conv(id);
    c.sent.push(text.trim());
    if (c.source === "acp" || acpLoaded.has(newest(id))) return acpPrompt(id, newest(id), text);
    return chatResume(id, newest(id), text);
  }
  const deliver = deliverer({ host, log, name: "Hermes", answer, send });

  async function start({ cwd, prompt, shown = prompt, lid }) {
    if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`No folder at ${cwd}`);
    const a = await startAcp();
    // Its post doesn't exist until Hermes names the session: the tools write to the launch's until then.
    const r = await a.rpc("session/new", { cwd, mcpServers: equip(a, `launch:${lid}`, cwd) });
    const id = r.sessionId;
    acpLoaded.add(id);
    rootOf.set(id, id);
    const c = conv(id);
    c.source = "acp";
    c.sent.push(prompt.trim());
    ensurePost(id, { source: "acp", cwd, started_at: Date.now() / 1000 }, { lid, prompt });
    host.commit({ t: "message.add", post: id, from: "human", via: "dash", text: shown, resume: lid });
    acpPrompt(id, id, prompt);
    return { id };
  }

  async function stop(id) {
    if (acpTurns.has(id)) return acp?.write({ method: "session/cancel", params: { sessionId: newest(id) } });
    if (running.has(id)) return void running.get(id).kill("SIGINT");
    throw new Error("It's running in Hermes elsewhere. Stop it there.");
  }

  function begin() {
    if (!enabled) return;
    const hasHermes = () => fs.existsSync(path.join(HOME_DIR(), "state.db"));
    const tick = () => {
      if (!hasHermes()) return;
      if (!host.state.agents[AGENT]) host.commit({ t: "agent.hello", agent: AGENT, agent_name: "Hermes", kind: "hermes" });
      sync();
      for (const s of Object.values(host.state.sessions)) if (s.proc?.startsWith("hermes:") && host.pending(s.id).length) deliver(s.id);
    };
    tick();
    setInterval(tick, Number(process.env.AGENTBOOK_HERMES_SYNC_MS || 2000)).unref();
  }

  return {
    prefix: "hermes",
    name: "Hermes",
    workers: (id) => workers.get(id) || [],
    workerSteps: async (id, worker) => workerSteps(id, worker),
    owns: (id) => id === AGENT && host.state.agents[id]?.kind === "hermes",
    begin,
    sync,
    start,
    stop,
    deliver,
    steps: async (id) => conv(id).digest,
    live: (s) => liveOf(posts.get(s.id)?.digest),
    summary: (s) => summaryOf(posts.get(s.id)?.digest, s),
    working: (id) => !!posts.get(id)?.busy,
    models: () => null,
    switchesModel: false,
    replyBlocked: (s) => {
      const src = posts.get(s.id)?.source;
      return CHANNELS.has(src) ? `This conversation is on ${src[0].toUpperCase()}${src.slice(1)}: write to Hermes there.` : null;
    },
    resumeCommand: (s) => `hermes --resume ${s.session_id}`,
    status: () => ({ enabled, connected: !!db, error: lastError }),
  };
}
