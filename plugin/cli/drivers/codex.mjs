// Codex sessions, through Codex's own app-server daemon: the threads `codex agents` and the Codex apps show.
// agentbook connects to the daemon's control socket (WebSocket over a unix socket) and speaks its JSON-RPC.
//
// - A thread is a post on the Codex profile, keyed by thread id. agentbook lists recent threads, and
//   follows the ones loaded in the daemon: their status, every item (commands, edits, messages), the plan.
// - Writing on a post sends a turn (or steers the running one); writing on a post whose thread isn't
//   loaded resumes it first. Posting on the Codex wall starts a thread.
// - Sending on the side forks the thread (`thread/fork`) into a side thread of its own, which
//   goes on with what you sent while the thread works on.
// - Codex's approval requests (run a command, edit files, more access) become Allow/Deny prompts on the
//   post, and its questions become polls. Stop interrupts the running turn.
// - A model picked for a thread goes with its next turn (`turn/start` takes one, for that turn and the
//   ones after). Its models come from `model/list`.
//
// Threads that run in a standalone `codex` (not through the daemon) are listed, but their progress only
// shows when they're loaded in the daemon.
//
// Its routines are the ChatGPT app's Codex automations (codex-automations.mjs). The threads their runs start
// stay off the feed: they're on their routine, and open there.
//
// Its usage limits (limits.mjs) are its ChatGPT plan's, what `/status` shows: `account/rateLimits/read`, when its
// profile asks, at most once a minute, or again once Codex says they moved (`account/rateLimits/updated`).

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { COMMITS, codexEdits, filesChanged, noteEdit, shaIn } from "../changes.mjs";
import { notePrs } from "../../shared/prs.mjs";
import { liveStep, said, SEEN_TOOL, seenTitle } from "../transcript.mjs";
import { createCodexAutomations } from "./codex-automations.mjs";
import { codexLimitsOf, limitsReader } from "../limits.mjs";
import { connectWs } from "./ws.mjs";
import { codexWhy } from "../../shared/whynot.mjs";
import { going as workerGoing, settle, stateOf } from "../workers.mjs";
import { removeCodexEntry } from "../uninstall.mjs";

// A file that holds a key, this person's alone: one others here can read (its group or everyone) is made so, as
// Codex's own logins are. -> { ok: true, made } once it is (or when it isn't there), else { ok: false, why }.
export function keptPrivate(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return { ok: true, made: false };
  }
  if (!(st.mode & 0o077)) return { ok: true, made: false };
  if (st.uid !== process.getuid?.()) return { ok: false, why: `${file} is someone else's, and others here can read it` };
  try {
    fs.chmodSync(file, st.mode & 0o700);
    return { ok: true, made: true };
  } catch (e) {
    return { ok: false, why: `${file} can't be made this person's alone (${e.code || e.message})` };
  }
}

const SOCK = process.env.AGENTBOOK_CODEX_SOCK || path.join(os.homedir(), ".codex", "app-server-control", "app-server-control.sock");
const DAYS = Number(process.env.AGENTBOOK_CODEX_DAYS || 14);
const HOST = os.hostname().split(".")[0];
// Headless `codex exec` runs stay off agentbook, like `claude -p` (AGENTBOOK_CODEX_EXEC=1 shows them).
const SOURCES = new Set(["cli", "vscode", "appServer", ...(process.env.AGENTBOOK_CODEX_EXEC === "1" ? ["exec"] : [])]);
const KEEP = 3000;
const QUIET_S = Number(process.env.AGENTBOOK_CODEX_QUIET_S || 3600); // an idle thread untouched this long is over

const short = (s, n = 90) => {
  s = String(s ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};
const iso = (sec) => (sec ? new Date(sec * 1000).toISOString() : null);
// Codex runs commands as `/bin/zsh -lc '<command>'`.
const unwrap = (cmd) => {
  const s = Array.isArray(cmd) ? cmd.join(" ") : String(cmd || "");
  const m = s.match(/^\S*\/(?:ba|z)?sh -l?c '([\s\S]*)'$/);
  return m ? m[1].replace(/'\\''/g, "'") : s;
};
const userFacing = (t) => (typeof t.source === "string" ? SOURCES.has(t.source) : !!t.source?.custom) && !t.ephemeral && t.threadSource !== "automation";
// What a heartbeat automation sends into its thread each time: "<heartbeat><automation_id>…</automation_id>…".
const heartbeatOf = (text) => String(text || "").match(/^\s*<heartbeat>[\s\S]*?<automation_id>([^<]+)<\/automation_id>/)?.[1] || null;
const cwdOf = (t) => (typeof t.cwd === "string" ? t.cwd : t.cwd?.path || "");

// A web search item is a search, a page it opened, a search in a page, or ("other") pages it read from what it
// found, and only a search has a query: the others have "" or their page's URL in `query`, so they're named by
// their page, as Claude's WebFetch is ("Read example.com"). Its action and results come when it completes.
const site = (u) => {
  try {
    const url = new URL(u);
    return short(url.host.replace(/^www\./, "") + (url.pathname === "/" ? "" : url.pathname), 60);
  } catch {
    return short(u, 60);
  }
};
function webStep(item) {
  const a = item.action || {};
  if (a.type === "openPage" && a.url) return `Read ${site(a.url)}`;
  if (a.type === "findInPage" && a.url) return a.pattern ? `Find “${short(a.pattern, 40)}” in ${site(a.url)}` : `Read ${site(a.url)}`;
  if (a.type !== "openPage" && a.type !== "findInPage") {
    const q = String(item.query || "").trim() || a.query || a.queries?.find((x) => x?.trim());
    if (q) return `Search the web for “${short(q, 60)}”`;
  }
  const pages = [...new Set((item.results || []).map((r) => r?.url).filter(Boolean))];
  if (pages.length) return `Read ${site(pages[0])}${pages.length > 1 ? ` and ${pages.length - 1} more` : ""}`;
  return "Search the web";
}

// One line per item, in the voice of Claude's steps ("Run the tests", "Edit src/app.js").
function stepOf(item, cwd) {
  const rel = (p) => (p && cwd && String(p).startsWith(cwd + "/") ? String(p).slice(cwd.length + 1) : String(p || ""));
  switch (item.type) {
    case "commandExecution": {
      const a = (item.commandActions || [])[0];
      if (a?.type === "read" && a.path) return `Read ${short(rel(a.path), 70)}`;
      if (a?.type === "search") return a.query ? `Search for “${short(a.query, 50)}”` : "Search the files";
      if (a?.type === "listFiles") return `List ${short(rel(a.path) || "the folder", 60)}`;
      return `Run ${short(unwrap(item.command), 70)}`;
    }
    case "fileChange": {
      const files = (item.changes || []).map((c) => rel(c.path));
      return files.length ? `Edit ${short(files.join(", "), 70)}` : "Edit files";
    }
    case "mcpToolCall":
      if (SEEN_TOOL.test(item.tool || "")) return seenTitle(item.tool, item.arguments);
      return `Use ${item.server} ${String(item.tool || "").replace(/[-_]/g, " ")}`;
    case "dynamicToolCall":
      return `Use ${item.tool}`;
    case "webSearch":
      return webStep(item);
    case "collabAgentToolCall":
      return item.tool === "wait" ? "Wait for its subagents" : `Subagent: ${short(item.prompt || item.tool || "", 70)}`;
    case "imageGeneration":
      return "Generate an image";
    case "imageView":
      return `Look at ${short(rel(item.path), 60)}`;
    case "contextCompaction":
      return "Compact the conversation";
    // A review (/review): what it looks at, as Codex says it ("current changes", "commit a41c9e0").
    case "enteredReviewMode":
      return `Review ${short(item.review || "the changes", 60)}`;
    default:
      return null;
  }
}
const failed = (item) => item.status === "failed" || item.status === "declined" || (item.type === "commandExecution" && item.exitCode != null && item.exitCode !== 0) || !!item.error;
const errorOf = (item) => short(item.error?.message || (item.type === "commandExecution" ? `Exited with ${item.exitCode}${item.aggregatedOutput ? `: ${item.aggregatedOutput}` : ""}` : item.status), 160) || "Failed";
const textOf = (content) => (content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
// What /init asks for: the prompt Codex's terminal app sends for it (0.166.0), word for word.
const INIT_PROMPT = `Generate a file named AGENTS.md that serves as a contributor guide for this repository.
Before writing, check whether AGENTS.md already exists in the current working directory. If it does, do not overwrite or modify it.
Your goal is to produce a clear, concise, and well-structured document with descriptive headings and actionable explanations for each section.
Follow the outline below, but adapt as needed — add sections if relevant, and omit those that do not apply to this project.

Document Requirements

- Title the document "Repository Guidelines".
- Use Markdown headings (#, ##, etc.) for structure.
- Keep the document concise. 200-400 words is optimal.
- Keep explanations short, direct, and specific to this repository.
- Provide examples where helpful (commands, directory paths, naming patterns).
- Maintain a professional, instructional tone.

Recommended Sections

Project Structure & Module Organization

- Outline the project structure, including where the source code, tests, and assets are located.

Build, Test, and Development Commands

- List key commands for building, testing, and running locally (e.g., npm test, make build).
- Briefly explain what each command does.

Coding Style & Naming Conventions

- Specify indentation rules, language-specific style preferences, and naming patterns.
- Include any formatting or linting tools used.

Testing Guidelines

- Identify testing frameworks and coverage requirements.
- State test naming conventions and how to run tests.

Commit & Pull Request Guidelines

- Summarize commit message conventions found in the project’s Git history.
- Outline pull request requirements (descriptions, linked issues, screenshots, etc.).

(Optional) Add other sections if relevant, such as Security & Configuration Tips, Architecture Overview, or Agent-Specific Instructions.`;
// What a thread runs with, as loading it says (thread/resume, thread/start) or Codex says it changed: what /status shows.
const settingsOf = (r) => (r ? { model: r.model || null, effort: r.reasoningEffort || null, approvals: r.approvalPolicy || null, sandbox: r.sandbox?.type || null } : null);
// A side thread's own turns: Codex's fork copies the thread's turns into it with their ids and start times, so the ones
// that started before you sent it on the side (`side_at`) are the thread's, not its own.
export function ownTurns(turns, sideAt) {
  const from = sideAt ? Date.parse(sideAt) / 1000 : 0;
  return from ? (turns || []).filter((t) => (Number(t.startedAt) || 0) >= Math.floor(from)) : turns || [];
}
const PLAN = { pending: "pending", inProgress: "in_progress", in_progress: "in_progress", completed: "completed" };

// `edits` and `commits`: what the thread changed (changes.mjs). `noted`: the items already counted there.
function blank() {
  return { steps: [], byId: new Map(), plan: null, turn: 0, tools: 0, errors: 0, worked: 0, context: 0, model: null, ai_title: null, skills: null, skill_uses: {}, prs: {}, n: 0, edits: [], commits: [], noted: new Set() };
}

// host: { state, commit, pending, gitInfo, label, changed, log }
export function createCodex(host) {
  const log = host.log || (() => {});
  const threads = new Map(); // id -> { cwd, subscribed, turn, sent: Set, lastSay, digest, read }
  const requests = new Map(); // request key (on the question) -> { rpcId, method, post, params, asks: Map(qid -> question id), answers: {} }
  const waiting = new Map();
  let ws = null;
  let ready = null;
  let nextId = 1;
  let enabled = process.env.AGENTBOOK_CODEX !== "0";
  let retry = 2000;
  let lastError = null;
  let version = null; // its daemon's, from initialize
  let models = { list: [], default: null };

  /* ---------- connection ---------- */

  function rpc(method, params) {
    if (!ws) return Promise.reject(new Error("Not connected to Codex"));
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error(`Codex didn't answer ${method}`));
      }, 30000);
      waiting.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  const reply = (id, result) => ws?.send(JSON.stringify({ id, result }));
  const refuse = (id, message) => ws?.send(JSON.stringify({ id, error: { code: -32601, message } }));

  function startDaemon() {
    return new Promise((resolve) =>
      execFile(process.env.AGENTBOOK_CODEX_BIN || "codex", ["app-server", "daemon", "start"], { timeout: 30000 }, (err) => {
        if (err?.code === "ENOENT") {
          enabled = false;
          log("codex: not installed");
        } else if (err) log(`codex: couldn't start its daemon: ${err.message}`);
        resolve();
      }),
    );
  }

  function connect() {
    if (!enabled) return Promise.reject(new Error("Codex isn't installed here."));
    ready ||= (async () => {
      if (!fs.existsSync(SOCK)) await startDaemon();
      if (!enabled) throw new Error("Codex isn't installed here.");
      const conn = await connectWs(SOCK, { onMessage, onClose });
      ws = conn;
      // Its daemon's version is in the user agent it answers with: "agentbook/0.160.0 (Mac OS …)".
      const hi = await rpc("initialize", { clientInfo: { name: "agentbook", title: "agentbook", version: "2.0" } });
      version = /^[^/\s]+\/(\d[\w.-]*)/.exec(hi?.userAgent || "")?.[1] || version;
      ws.send(JSON.stringify({ method: "initialized", params: {} }));
      retry = 2000;
      lastError = null;
      log("codex: connected");
      loadModels().catch(() => {});
      offerTools().catch((e) => log(`codex: couldn't give its threads agentbook's tools: ${e.message}`));
      return conn;
    })().catch((e) => {
      ready = null;
      ws = null;
      lastError = e.message;
      throw e;
    });
    return ready;
  }

  function onClose() {
    ws = null;
    ready = null;
    for (const w of waiting.values()) {
      clearTimeout(w.timer);
      w.reject(new Error("Codex disconnected"));
    }
    waiting.clear();
    for (const th of threads.values()) Object.assign(th, { subscribed: false });
    log("codex: disconnected");
    setTimeout(() => sync().catch(() => {}), (retry = Math.min(retry * 2, 60000)));
  }

  function onMessage(text) {
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (m.id !== undefined && !m.method) {
      const w = waiting.get(m.id);
      if (!w) return;
      waiting.delete(m.id);
      clearTimeout(w.timer);
      return m.error ? w.reject(new Error(m.error.message || "Codex error")) : w.resolve(m.result);
    }
    if (m.method && m.id !== undefined) return onRequest(m).catch((e) => log(`codex request ${m.method}: ${e.message}`));
    if (m.method) {
      try {
        onNotification(m.method, m.params || {});
      } catch (e) {
        log(`codex ${m.method}: ${e.message}`);
      }
    }
  }

  /* ---------- threads and posts ---------- */

  const post = (id) => host.state.sessions[id];
  const spawnedBy = new Map(); // a spawned agent's thread id -> the thread that spawned it
  // The post a thread's calls to agentbook's tools write to: its own, or, for an agent a thread spawned (no post of
  // its own), the post of the thread that spawned it, as a Claude subagent's write to its session's. A call means
  // it's running, so a post agentbook took for over (a codex CLI thread that went quiet) is back.
  function postOf(id) {
    for (let at = id, hops = 0; at && hops < 10; at = spawnedBy.get(at), hops++)
      if (post(at)) {
        revive(at);
        return at;
      }
    return id;
  }
  const thread = (id) => {
    if (!threads.has(id)) threads.set(id, { cwd: "", subscribed: false, turn: null, turnsHeard: 0, sent: new Set(), lastSay: null, digest: blank(), read: 0 });
    return threads.get(id);
  };

  /* ---------- the agents a thread spawns ---------- */

  // A thread's agent can spawn agents (spawnAgent), which run as threads of their own and stay off agentbook: each is
  // a worker (workers.mjs) of the thread that spawned it. The spawn, and its calls after it (wait, closeAgent…), say
  // how each is going (agentsStates); so do its activity items (subAgentActivity).
  const AGENT_STATES = { interacted: "running" };
  function worker(id, child, { title, at }) {
    const th = thread(id);
    th.workers ||= new Map();
    if (!th.workers.has(child)) {
      th.workers.set(child, { id: child, title: short(String(title || "A subagent").split("\n")[0], 120), state: "running", started: at, ended: null, error: null, step: null, n: 0 });
      spawnedBy.set(child, id);
      if (th.workers.size > 200) th.workers.delete(th.workers.keys().next().value);
    }
    return th.workers.get(child);
  }
  function noteAgents(id, item, at) {
    if (item.type === "subAgentActivity" && item.agentThreadId) {
      const w = item.kind === "started" ? worker(id, item.agentThreadId, { title: item.agentPath, at }) : thread(id).workers?.get(item.agentThreadId);
      if (w) settle(w, stateOf(item.kind) || AGENT_STATES[item.kind], at);
      return;
    }
    if (item.type !== "collabAgentToolCall") return;
    for (const child of item.receiverThreadIds || []) {
      const w = item.tool === "spawnAgent" ? worker(id, child, { title: item.prompt, at }) : thread(id).workers?.get(child);
      const st = item.agentsStates?.[child];
      if (!w || !st) continue;
      // Closed: one still going was stopped; one that had finished stays as it ended.
      if (st.status === "shutdown") {
        if (workerGoing(w)) settle(w, "stopped", at);
      } else settle(w, stateOf(st.status), at, st.status === "errored" && st.message ? short(st.message, 300) : null);
    }
  }
  // A spawned agent's own events, when Codex sends them: the step it's on.
  function agentEvent(id, child, method, p) {
    const w = thread(id).workers?.get(child);
    const title = method === "item/started" && w && stepOf(p.item, thread(id).cwd);
    if (!title) return;
    w.step = { title, at: p.startedAtMs ? new Date(p.startedAtMs).toISOString() : new Date().toISOString() };
    w.n = (w.n || 0) + 1;
    host.changed(id);
  }
  // Its workers, each with its last step while it's going.
  const workersOf = (id) => [...(threads.get(id)?.workers?.values() || [])].map((w) => (workerGoing(w) ? { ...w } : { ...w, step: null }));
  // A worker's steps, from its own thread (thread/read): read when you open it on its thread's page. What it said, and
  // each item it ran, at its turn's times (Codex gives an item none of its own). Its latest WORKER_STEPS.
  const WORKER_STEPS = 40;
  async function workerStepsOf(id, child) {
    const w = threads.get(id)?.workers?.get(child);
    if (!w) return null;
    const t = (await rpc("thread/read", { threadId: child, includeTurns: true }))?.thread;
    const cwd = (t && cwdOf(t)) || thread(id).cwd;
    const steps = [];
    for (const turn of t?.turns || []) {
      const at = iso(turn.startedAt) || w.started;
      const end = iso(turn.completedAt);
      for (const item of turn.items || []) {
        if (item.type === "agentMessage") {
          if (item.text?.trim()) steps.push({ id: item.id, kind: "say", at: end || at, text: said(item.text) });
          continue;
        }
        const title = stepOf(item, cwd);
        if (!title) continue;
        const over = item.status ? item.status !== "inProgress" : !!end;
        steps.push({ id: item.id, kind: "tool", tool: item.type, at, title, ...(over ? { done: end || at } : {}), ...(over && failed(item) ? { error: errorOf(item) } : {}) });
      }
    }
    const n = steps.filter((x) => x.kind === "tool").length;
    if (n > (w.n || 0)) w.n = n;
    return { steps: steps.slice(-WORKER_STEPS), n };
  }

  // A thread nothing has happened in yet (a new one opened in Codex, nothing sent): no first message, no name,
  // no turns, not running. It gets its post at its first turn, as a Claude session in a terminal gets its thread
  // at its first prompt, so opening Codex and leaving leaves nothing behind. Until then it's held here.
  const untried = (t) => !String(t.preview || "").trim() && !t.name && !(t.turns || []).length && t.status?.type !== "active";
  const held = new Map(); // thread id -> the thread, as Codex last said it

  // Make sure a thread has a post, or hold it if nothing has happened in it yet (null), or nothing since where its
  // person said the past starts: a thread still loaded in Codex stays off until it's used again. `lid`: the launch it
  // answers, so the post takes over its placeholder; `active`: something is happening in it.
  function ensurePost(t, { lid, active = false } = {}) {
    const th = thread(t.id);
    th.cwd = cwdOf(t) || th.cwd;
    if (t.model) th.digest.model = t.model;
    if (t.name) th.digest.ai_title = short(t.name, 120);
    const known = post(t.id);
    if (known && !lid) return known;
    if (!known && !lid && !active && (untried(t) || t.updatedAt < (host.historyFrom?.() || 0) / 1000)) {
      held.set(t.id, t);
      return null;
    }
    held.delete(t.id);
    const g = host.gitInfo(th.cwd);
    host.commit({
      t: "session.hello",
      proc: `codex:${t.id}`,
      agent: "codex",
      agent_name: "Codex",
      kind: "codex",
      label: host.label(t.id),
      session_id: t.id,
      cwd: th.cwd,
      root: g.root,
      repo: g.repo,
      branch: t.gitInfo?.branch || g.branch,
      host: HOST,
      channel: true,
      launch: lid,
      started: iso(t.createdAt) || undefined,
      updated: iso(t.updatedAt) || undefined,
      prompt: t.preview ? short(t.preview, 2000) : undefined,
    });
    snapshot(t.id);
    return post(t.id);
  }

  // A post that ended comes back when its thread does.
  function revive(id) {
    const s = post(id);
    if (s && s.state === "done") host.commit({ t: "session.hello", proc: `codex:${id}`, agent: "codex", agent_name: "Codex", kind: "codex", label: s.label, session_id: id, channel: true });
  }

  function setStatus(id, status) {
    const s = post(id);
    if (!s || !status) return;
    if (status.type === "active") {
      revive(id);
      const flags = status.activeFlags || [];
      const st = flags.length ? "waiting" : "working";
      const text = flags.includes("waitingOnApproval") ? "Waiting for your approval" : flags.includes("waitingOnUserInput") ? "Waiting for your answer" : undefined;
      if (post(id).state !== st || !post(id).busy) host.commit({ t: "session.status", post: id, state: st, text, turn: post(id).busy ? undefined : "start" });
    } else if (status.type === "idle") {
      revive(id);
      if (post(id).state !== "idle" || post(id).busy) host.commit({ t: "session.status", post: id, state: "idle", text: "Waiting for your next message", turn: "end", settle_permissions: true });
    } else if (status.type === "notLoaded" || status.type === "systemError") {
      if (s.state !== "done") host.commit({ t: "session.gone", post: id, reason: status.type === "systemError" ? "Codex hit an error" : "Closed" });
    }
  }

  // agentbook's MCP server for a thread, so it can write to its post. Codex attaches a thread's MCP servers
  // when it loads the thread, and keeps them only while it's loaded: `thread/start`, and `thread/resume` of
  // a thread that isn't loaded, take them; a loaded thread ignores them. Its tools need no approval.
  const equip = (proc, cwd) => ({ config: { "mcp_servers.agentbook": { ...host.mcp(proc, cwd), default_tools_approval_mode: "approve" } } });
  // And every other Codex thread, wherever it was started (the Codex app, the codex CLI), as Claude Code sessions
  // get them from agentbook's plugin: an entry in Codex's own config (its config.toml, written through its daemon),
  // whose calls say which thread made them (mcp.mjs), and whose instructions say what Visual mode is. Codex's
  // reload hands it to the threads already loaded too; a thread agentbook starts or loads still gets its own,
  // above. An entry someone turned off stays off, and one that points at another agentbook that answers (a second
  // agentbook-cli here) is left alone; one that doesn't answer is stale, and replaced. AGENTBOOK_CODEX_MCP=0
  // leaves Codex's config as it is, and so does a person who didn't agree to this at login (host.codexTools).
  const answers = (url) => fetch(url, { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
  // With its server elsewhere, that entry's address has a key of its own (key=), local_key on or not: good for
  // agentbook's tools as any Codex thread, as Codex says which thread a call comes from and nothing proves it. So it
  // stays in a config.toml this person alone can read (keptPrivate, each time this connects: Codex makes a new one so,
  // but keeps the mode of one the person has), or it's taken out again, and the log says why.
  const keyedUrl = (u) => {
    try {
      return new URL(u).searchParams.has("key");
    } catch {
      return false;
    }
  };
  // The file Codex says the entry is in (config/read's origins, or its layers), else the person's own config.toml it
  // would go in: only that one is looked at, and none when Codex doesn't say.
  const entryFile = (read) => {
    const o = read?.origins?.["mcp_servers.agentbook.url"]?.name;
    if (o?.type === "user" && o.file) return o.file;
    const user = (read?.layers || []).filter((l) => l?.name?.type === "user" && l.name.file);
    return (user.find((l) => l.config?.mcp_servers?.agentbook) || user.find((l) => !l.name.profile))?.name.file || null;
  };
  // -> true when the entry isn't to be there: a file others can read, and that can't be made this person's alone.
  async function unshared(file, there = true) {
    if (!file) return false;
    const p = keptPrivate(file);
    if (p.made) log(`codex: made ${file} readable by this person alone, as agentbook's entry in it holds a key`);
    if (p.ok) return false;
    if (there) {
      removeCodexEntry(file);
      await rpc("config/mcpServer/reload", null).catch(() => {});
    }
    log(`codex: ${there ? "took agentbook's tools out of" : "didn't put agentbook's tools in"} Codex's settings, as their address holds a key and ${p.why}. Make it yours alone (chmod 600), then agentbook-cli down and up.`);
    return true;
  }
  async function offerTools() {
    if (process.env.AGENTBOOK_CODEX_MCP === "0" || !host.mcpForAll || host.codexTools?.() === false) return;
    const want = host.mcpForAll("codex");
    const read = await rpc("config/read", { includeLayers: true });
    const have = read?.config?.mcp_servers?.agentbook;
    if (have?.url === want.url && keyedUrl(want.url) && (await unshared(entryFile(read)))) return;
    if (have?.enabled === false || have?.url === want.url) return;
    // Without what comes after the path: a key can be there, for the log and for telling this agentbook-cli's from another's.
    const bare = (u) => String(u).split("?")[0];
    if (have?.url && bare(have.url) !== bare(want.url) && (await answers(have.url))) return log(`codex: its threads' agentbook tools are ${bare(have.url)}'s, which answers: leaving them`);
    if (keyedUrl(want.url) && (await unshared(entryFile(read), false))) return;
    const wrote = await rpc("config/value/write", { keyPath: "mcp_servers.agentbook", mergeStrategy: "replace", value: { ...want, default_tools_approval_mode: "approve" } });
    if (keyedUrl(want.url) && (await unshared(wrote?.filePath))) return;
    await rpc("config/mcpServer/reload", null);
    log(`codex: every Codex thread gets agentbook's tools now (${bare(want.url)})`);
  }
  // A Codex that won't take them still runs the thread, without the tools.
  async function loading(method, params, extra) {
    try {
      return await rpc(method, { ...params, ...extra });
    } catch (e) {
      if (/didn't answer|Not connected/.test(e.message)) throw e; // it may have done it: don't do it twice
      log(`codex ${method} with agentbook's tools: ${e.message}; trying without them`);
      return await rpc(method, params);
    }
  }

  // Subscribe to a thread's events (loading it in the daemon if it isn't).
  async function follow(id) {
    await connect();
    const th = thread(id);
    if (th.subscribed) return th;
    const r = await loading("thread/resume", { threadId: id, excludeTurns: true }, equip(`codex:${id}`, th.cwd || post(id)?.cwd));
    th.subscribed = true;
    th.settings = settingsOf(r) || th.settings;
    // Subagents' threads stay off agentbook; their parent's post shows their work.
    if (r?.thread && userFacing(r.thread)) {
      ensurePost(r.thread);
      setStatus(id, r.thread.status);
    }
    return th;
  }

  // Recent threads, and every thread the daemon has loaded. Runs at start and every 15 seconds.
  let syncing = null;
  function sync() {
    syncing ||= (async () => {
      await connect();
      // Codex is an agent here once its daemon answers, before it has a thread, so there's one to start a thread with.
      if (!host.state.agents.codex) host.commit({ t: "agent.hello", agent: "codex", agent_name: "Codex", kind: "codex", ...(version ? { version } : {}) });
      else if (version && host.state.agents.codex.version !== version) host.commit({ t: "agent.hello", agent: "codex", version });
      const since = Math.max(Date.now() / 1000 - DAYS * 86400, (host.historyFrom?.() || 0) / 1000);
      const list = await rpc("thread/list", { limit: 50, sortKey: "updated_at", sourceKinds: [...SOURCES] });
      const loaded = new Set((await rpc("thread/loaded/list", {}))?.data || []);
      for (const t of list?.data || []) {
        if (!userFacing(t)) continue;
        const isLoaded = loaded.has(t.id);
        if (!post(t.id) && !isLoaded && t.updatedAt < since) continue;
        const fresh = !post(t.id);
        if (!ensurePost(t)) continue;
        if (!isLoaded) {
          // Not in the daemon. A thread updated in the last few minutes is probably open in a standalone codex.
          const recent = Date.now() / 1000 - t.updatedAt < 180;
          if (!recent && post(t.id).state !== "done") host.commit({ t: "session.gone", post: t.id, reason: "Closed", ended: iso(t.updatedAt) });
          else if (recent && fresh) host.commit({ t: "session.status", post: t.id, state: "idle", text: "Open in another Codex window" });
        } else if (t.status?.type === "idle" && Date.now() / 1000 - t.updatedAt > QUIET_S) {
          // Loaded in the daemon, but untouched for an hour: it's over until you write to it, or it's used again.
          if (post(t.id).state !== "done") host.commit({ t: "session.gone", post: t.id, reason: "Quiet", ended: iso(t.updatedAt) });
        } else setStatus(t.id, t.status);
        if (t.name && thread(t.id).digest.ai_title !== short(t.name, 120)) {
          thread(t.id).digest.ai_title = short(t.name, 120);
          snapshot(t.id);
        }
      }
      for (const id of loaded) if (!thread(id).subscribed) await follow(id).catch((e) => log(`codex follow ${id}: ${e.message}`));
      for (const s of Object.values(host.state.sessions)) if (s.agent === "codex" && host.pending(s.id).length) deliver(s.id);
    })().finally(() => (syncing = null));
    return syncing;
  }

  /* ---------- what Codex sends ---------- */

  function onNotification(method, p) {
    if (method === "account/rateLimits/updated") return void limits.stale();
    if (method === "skills/changed") return void skillsByCwd.clear();
    const id = p.threadId || p.thread?.id;
    if (method === "thread/started") {
      if (userFacing(p.thread)) ensurePost(p.thread);
      // An agent a thread spawned: its worker, by the name it was given.
      const spawn = p.thread?.source?.subAgent?.thread_spawn;
      if (spawn?.parent_thread_id && post(spawn.parent_thread_id)) {
        worker(spawn.parent_thread_id, p.thread.id, { title: spawn.agent_nickname || spawn.agent_role, at: iso(p.thread.createdAt) || new Date().toISOString() });
        host.changed(spawn.parent_thread_id);
      }
      return;
    }
    if (id && spawnedBy.has(id) && !post(id)) return void agentEvent(spawnedBy.get(id), id, method, p);
    // A held thread's first turn makes its post; one closed before anything happened in it is let go.
    if (id && held.has(id) && !post(id)) {
      if (method === "turn/started" || method.startsWith("item/") || (method === "thread/status/changed" && p.status?.type === "active")) ensurePost(held.get(id), { active: true });
      else if (method === "thread/closed" || (method === "thread/status/changed" && p.status?.type === "notLoaded")) held.delete(id);
    }
    if (!id || !threads.has(id) || !post(id)) return;
    const th = thread(id);
    const d = th.digest;
    switch (method) {
      case "thread/status/changed":
        return setStatus(id, p.status);
      case "thread/name/updated":
        d.ai_title = p.threadName ? short(p.threadName, 120) : d.ai_title;
        return snapshot(id);
      case "thread/closed":
        th.subscribed = false;
        return setStatus(id, { type: "notLoaded" });
      case "turn/started":
        th.turn = p.turn?.id || null;
        th.turnsHeard++;
        th.lastSay = null;
        revive(id);
        if (!post(id).busy) host.commit({ t: "session.status", post: id, state: "working", turn: "start" });
        return host.changed(id);
      case "turn/completed": {
        th.turn = null;
        th.turnsHeard++;
        d.worked += Number(p.turn?.durationMs) || 0;
        if (p.turn?.error?.message) host.commit({ t: "message.add", post: id, from: "agent", via: "dash", text: `Stopped: ${codexWhy(p.turn.error.message, host.machine)}` });
        else if (th.lastSay) host.commit({ t: "message.add", post: id, from: "agent", via: "dash", text: th.lastSay });
        th.lastSay = null;
        host.commit({ t: "session.status", post: id, state: "idle", text: p.turn?.status === "interrupted" ? "Stopped" : "Finished, waiting for your next message", turn: "end", settle_permissions: true });
        return snapshot(id, true);
      }
      case "turn/plan/updated":
        d.plan = (p.plan || []).map((x) => ({ text: short(x.step, 120), now: short(x.step, 120), status: PLAN[x.status] || "pending" }));
        return host.changed(id);
      case "thread/tokenUsage/updated":
        d.context = Number(p.tokenUsage?.last?.inputTokens) || d.context;
        return;
      case "thread/settings/updated":
        if (p.threadSettings) th.settings = settingsOf({ ...p.threadSettings, sandbox: p.threadSettings.sandboxPolicy, reasoningEffort: p.threadSettings.effort });
        if (!p.threadSettings?.model || p.threadSettings.model === d.model) return;
        d.model = p.threadSettings.model;
        return snapshot(id);
      // Deprecated for the contextCompaction item, which a Codex that sends both sends too: whichever comes first.
      case "thread/compacted":
        return compacted(id);
      case "item/started":
        take(id, p.item, p.startedAtMs, false);
        return host.changed(id);
      case "item/completed":
        take(id, p.item, p.completedAtMs, true);
        return host.changed(id);
    }
  }

  // Fold an item into a thread's steps. `live`: it happened now (mirror what someone typed elsewhere).
  function take(id, item, ms, completed, live = true) {
    const th = thread(id);
    const d = th.digest;
    const at = ms ? new Date(ms).toISOString() : new Date().toISOString();
    if (item.type === "userMessage") {
      if (completed) return;
      d.turn++;
      if (live && !(item.clientId && th.sent.has(item.clientId))) {
        const text = textOf(item.content);
        // A heartbeat's prompt isn't you writing: its runs are on its routine.
        if (text && !heartbeatOf(text)) host.commit({ t: "message.add", post: id, from: "human", via: "terminal", text });
      }
      return;
    }
    // What it says, and what a review it ran found (its findings, which end the review's turn as its reply).
    if (item.type === "agentMessage" || item.type === "exitedReviewMode") {
      const text = item.type === "agentMessage" ? item.text : item.review;
      if (!completed || !text?.trim()) return;
      d.steps.push({ id: item.id, turn: d.turn, at, kind: "say", text: said(text) });
      if (live) th.lastSay = text;
    } else {
      if (item.type === "contextCompaction" && completed && live) compacted(id);
      noteAgents(id, item, at);
      const title = stepOf(item, th.cwd);
      if (!title) return;
      let step = d.byId.get(item.id);
      if (!step) {
        step = { id: item.id, turn: d.turn, at, kind: "tool", tool: item.type, title };
        d.steps.push(step);
        d.byId.set(item.id, step);
        d.tools++;
      } else step.title = title;
      if (item.type === "fileChange") th.changes = { ...(th.changes || {}), [item.id]: item.changes };
      if (completed) {
        step.done = at;
        if (failed(item)) {
          step.error = errorOf(item);
          d.errors++;
        } else if (!d.noted.has(item.id)) {
          // What it changed, once: from a file change's diffs, and the commits a command made.
          d.noted.add(item.id);
          if (item.type === "fileChange") for (const e of codexEdits(item, th.cwd)) noteEdit(d, step, { ...e, at }, th.cwd);
          if (item.type === "commandExecution" && COMMITS.test(unwrap(item.command))) d.commits.push({ step: step.id, turn: step.turn, from: step.at, to: at, sha: shaIn(item.aggregatedOutput) });
          if (item.type === "commandExecution") notePrs(d.prs, unwrap(item.command), item.aggregatedOutput, at);
        }
      }
    }
    if (d.steps.length > KEEP) for (const s of d.steps.splice(0, d.steps.length - KEEP)) d.byId.delete(s.id);
  }

  // Keep the post's summary (title, model, plan, stats) in the log, like Claude's.
  function snapshot(id) {
    if (post(id)) host.changed(id, true);
  }

  /* ---------- approvals and questions ---------- */

  async function onRequest(m) {
    const p = m.params || {};
    const id = p.threadId || p.conversationId;
    if (id && !post(id)) {
      const r = await rpc("thread/read", { threadId: id }).catch(() => null);
      if (r?.thread) ensurePost(r.thread, { active: true }); // it's asking something of a turn it's running
    }
    if (!id || !post(id)) return refuse(m.id, "agentbook doesn't know this thread");
    const key = `x${m.id}`;
    const ask = (q) => {
      requests.set(key, { rpcId: m.id, method: m.method, post: id, params: p });
      host.commit({ t: "question.ask", post: id, kind: "permission", request_id: key, ...q });
    };
    switch (m.method) {
      case "item/commandExecution/requestApproval":
      case "execCommandApproval":
        return ask({ title: "Allow Shell?", tool_name: "Shell", detail: p.reason || "Codex wants to run a command.", preview: unwrap(p.command) });
      case "item/fileChange/requestApproval":
      case "applyPatchApproval": {
        const changes = p.fileChanges ? Object.keys(p.fileChanges) : (thread(id).changes?.[p.itemId] || []).map((c) => c.path);
        return ask({ title: "Allow edits?", tool_name: "Edit", detail: p.reason || "Codex wants to change files.", preview: changes.join("\n") });
      }
      case "item/permissions/requestApproval":
        return ask({ title: "Allow more access?", tool_name: "Permissions", detail: p.reason || "Codex wants more access for this turn.", preview: JSON.stringify(p.permissions, null, 2) });
      case "item/tool/requestUserInput": {
        const req = { rpcId: m.id, method: m.method, post: id, params: p, asks: new Map(), answers: {} };
        requests.set(key, req);
        for (const q of p.questions || []) {
          const op = host.commit({
            t: "question.ask",
            post: id,
            kind: q.options?.length ? "choice" : "text",
            title: q.question,
            detail: q.header || "",
            options: (q.options || []).slice(0, 6).map((o) => ({ label: short(o.label, 80), detail: short(o.description, 140) || null })),
            key: `${key}:${q.id}`,
            blocks: true,
          });
          req.asks.set(`q${op.seq}`, q.id);
        }
        if (!req.asks.size) reply(m.id, { answers: {} });
        return;
      }
      case "mcpServer/elicitation/request":
        return reply(m.id, { action: "decline" });
      default:
        return refuse(m.id, `agentbook can't handle ${m.method}`);
    }
  }

  function answerPermission(e) {
    const r = requests.get(e.request_id);
    if (!r) return;
    requests.delete(e.request_id);
    const yes = e.behavior === "allow";
    if (r.method === "execCommandApproval" || r.method === "applyPatchApproval") return reply(r.rpcId, { decision: yes ? "approved" : "abort" });
    if (r.method === "item/permissions/requestApproval") return reply(r.rpcId, yes ? { permissions: r.params.permissions || {}, scope: "turn" } : { permissions: {} });
    reply(r.rpcId, { decision: yes ? "accept" : "decline" });
  }

  // An answer to one of Codex's questions. Once every question in its request is answered, reply.
  function answerInput(e) {
    for (const [key, r] of requests) {
      if (!r.asks?.has(e.question_id)) continue;
      r.answers[r.asks.get(e.question_id)] = { answers: e.skipped || e.value == null ? [] : [String(e.value)] };
      if (Object.keys(r.answers).length === r.asks.size) {
        requests.delete(key);
        reply(r.rpcId, { answers: r.answers });
      }
      return true;
    }
    return false;
  }

  /* ---------- what you send ---------- */

  // A call that starts a turn. Its reply says which turn, so a message or Stop can reach one Codex hasn't announced yet.
  // But the turn can be over by the time the reply is read, and it would then count as running for good, holding back
  // every command: what turn/started and turn/completed said while the call was out stands.
  async function startTurn(th, method, params) {
    const heard = th.turnsHeard;
    const r = await rpc(method, params);
    if (th.turnsHeard === heard) th.turn = r?.turn?.id || th.turn;
    return r;
  }

  // Send a message as a turn, or steer the turn that's running. A model picked for the post goes with the
  // next turn it starts (steering keeps the running turn's model). `effort` stays with the thread's later turns.
  // `also`: more input beside the text (a skill it's to use).
  async function sendTurn(id, text, { effort, also = [] } = {}) {
    const th = await follow(id);
    const clientUserMessageId = `ab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    th.sent.add(clientUserMessageId);
    const input = [{ type: "text", text, text_elements: [] }, ...also];
    if (th.turn) {
      try {
        return await rpc("turn/steer", { threadId: id, expectedTurnId: th.turn, input, clientUserMessageId });
      } catch {}
    }
    const model = post(id)?.model_pick || undefined;
    const r = await startTurn(th, "turn/start", { threadId: id, input, clientUserMessageId, model, effort: effort || undefined });
    if (model) {
      th.digest.model = model;
      host.commit({ t: "session.model", post: id, model: null });
      snapshot(id);
    }
    return r;
  }

  // Hand a post's queued events to Codex: verdicts and answers to its requests, messages as turns, and a slash command
  // as the call it is (runCommand). A command goes alone, as typed, between turns: what's before it goes first, and
  // it waits for the turn that makes (or one Codex runs by itself) to end; what's after it goes once it's run. Codex's
  // approvals and questions are answered meanwhile, since a turn waiting on one wouldn't end.
  const delivering = new Set();
  const again = new Set();
  const answersCodex = (e) => (e.type === "permission" && requests.has(e.request_id)) || (e.type === "answer" && [...requests.values()].some((r) => r.asks?.has(e.question_id)));
  async function deliver(id) {
    if (delivering.has(id)) return void again.add(id);
    delivering.add(id);
    const pending = host.pending(id);
    const at = pending.findIndex((o) => o.event.type === "message" && o.event.command);
    let events = at < 0 ? pending : [...pending.slice(0, at), ...pending.slice(at + 1).filter((o) => answersCodex(o.event))];
    try {
      if (events.length) {
        const texts = [];
        for (const o of events) {
          const e = o.event;
          if (e.type === "permission") answerPermission(e);
          else if (e.type === "answer") {
            if (!answerInput(e)) texts.push(host.describe(e));
          } else if (e.type === "message") texts.push(`${e.text || ""}${host.attached(e.files)}`.trim());
          else if (e.type === "file" || e.type === "run") texts.push(host.describe(e));
        }
        // What changed in its group since it last heard rides along; it never makes a turn of its own.
        if (texts.length) await sendTurn(id, [...texts, await Promise.resolve(host.news?.(id)).catch(() => null)].filter(Boolean).join("\n\n"));
        host.commit({ t: "outbox.ack", oids: events.map((o) => o.oid) });
      }
      if (at < 0) return;
      // Its turn over (agentbook tries again as the outbox changes, and every few seconds), the command, alone.
      const th = await follow(id);
      if (th.turn || post(id)?.busy) return;
      const o = pending[at];
      events = [o];
      await runCommand(id, o.event.text || "", o.event.command);
      host.commit({ t: "outbox.ack", oids: [o.oid] });
      if (pending.length > at + 1) again.add(id);
    } catch (e) {
      log(`codex deliver ${id}: ${e.message}`);
      host.undelivered(id, events, `couldn't reach Codex: ${e.message}`);
    } finally {
      delivering.delete(id);
      if (again.delete(id)) deliver(id);
    }
  }

  /* ---------- its slash commands ---------- */

  // What a thread can run with a slash command. Codex's commands are its terminal app's:
  // its app-server has no call that lists them or runs one typed, but has one for each of these, which runCommand
  // makes. Each in Codex's own words. Its skills are commands here too, one each, as Claude Code's and OpenClaw's are
  // (Codex's app spells them $name), and go to Codex as a skill, not as words. Left out (`off`, with why): what only
  // its terminal app does, and what agentbook does itself.
  const COMMANDS = [
    { name: "compact", hint: "", description: "Summarize the conversation to prevent hitting the context limit", takes: "" },
    { name: "review", hint: "[base <branch>|<commit>|what to look at]", description: "Review my current changes and find issues", takes: "opt" },
    { name: "goal", hint: "[<objective>|clear|pause|resume]", description: "Set or view the goal for a long-running task", takes: "opt" },
    { name: "init", hint: "", description: "Create an AGENTS.md file with instructions for Codex", takes: "" },
    { name: "status", hint: "", description: "Show current session configuration and token usage", takes: "" },
    { name: "usage", hint: "", description: "View account usage", takes: "" },
    { name: "mcp", hint: "", description: "List configured MCP servers and their tools", takes: "" },
    { name: "rename", hint: "<name>", description: "Rename the current thread", takes: "req" },
    { name: "fork", hint: "", description: "Fork the current chat into a new thread", takes: "" },
    { name: "model", hint: "<model>", description: "Choose what model to use", takes: "req" },
  ].map((c) => ({ ...c, from: "built-in" }));
  const WALL = "starts a new chat: start a new thread on Codex's wall";
  const TUI = "changes Codex's terminal app";
  const NOT_HERE = {
    new: WALL,
    clear: WALL,
    resume: "opens another chat: open its thread here",
    diff: "is Changes, on the thread",
    permissions: "picks what Codex may do, in its terminal app",
    approvals: "picks what Codex may do, in its terminal app",
    side: "starts a side chat, which agentbook doesn't show",
    btw: "starts a side chat, which agentbook doesn't show",
    plan: "switches its terminal app to Plan mode",
    copy: "copies in its terminal app: copy from the thread",
    export: "saves the chat from its terminal app",
    archive: "archives it in Codex: archive the thread here",
    delete: "deletes the chat for good, which only its terminal app does",
    logout: "signs out of Codex, in a terminal",
    feedback: "sends logs to OpenAI, from a terminal",
    quit: "closes its terminal app",
    exit: "closes its terminal app",
    theme: TUI,
    statusline: TUI,
    title: TUI,
    vim: TUI,
    keymap: TUI,
    raw: TUI,
  };
  const COMMANDS_MS = 5 * 60e3;
  const skillsByCwd = new Map(); // folder -> { at, list }: Codex's skills there, as skills/list gave them
  async function skillsIn(cwd) {
    const have = skillsByCwd.get(cwd);
    if (have && Date.now() - have.at < COMMANDS_MS) return have.list;
    const r = await rpc("skills/list", { cwds: cwd ? [cwd] : [] });
    const list = (r?.data || []).flatMap((e) => e.skills || []).filter((k) => k?.name && k.path && k.enabled !== false);
    skillsByCwd.set(cwd, { at: Date.now(), list });
    return list;
  }
  const cwdFor = (id) => thread(id).cwd || post(id)?.cwd || "";
  async function commands(s) {
    await connect();
    const skills = await skillsIn(cwdFor(s.id)).catch((e) => (log(`codex: couldn't list its skills: ${e.message}`), []));
    const names = new Set([...COMMANDS.map((c) => c.name), ...Object.keys(NOT_HERE)]);
    const own = [];
    for (const k of skills) {
      if (names.has(k.name) || !/^[\w:.-]{1,100}$/.test(k.name)) continue;
      names.add(k.name);
      const from = k.pluginId ? { from: "plugin", plugin: String(k.pluginId).split("@")[0] } : { from: k.scope === "repo" ? "project" : "skill" };
      own.push({ name: k.name, hint: "", description: short(k.interface?.shortDescription || k.shortDescription || k.description, 200), takes: "opt", ...from });
    }
    // /model takes one of its models, which the / list names when there are only a few.
    const ids = models.list.map((m) => m.id);
    const list = COMMANDS.map((c) => (c.name === "model" && ids.length && ids.length <= 4 ? { ...c, hint: `<${ids.join("|")}>` } : c));
    return { list: [...list, ...own], off: Object.entries(NOT_HERE).map(([name, why]) => ({ name, why })) };
  }

  // Run one: the call Codex has for it. What it says shows on the thread as its reply (`command`: whose output it is);
  // one that starts a turn (a review, /init, a skill, a compaction) shows as any turn does. One Codex refuses says why.
  async function runCommand(id, text, name) {
    const th = await follow(id);
    const args = text.slice(name.length + 1).trim();
    const say = (t) => host.commit({ t: "message.add", post: id, from: "agent", via: "dash", text: t, command: name });
    try {
      switch (name) {
        case "compact":
          th.compacting = true;
          await rpc("thread/compact/start", { threadId: id });
          return;
        case "review": {
          await startTurn(th, "review/start", { threadId: id, target: reviewTarget(args), delivery: "inline" });
          return;
        }
        case "init":
          await sendTurn(id, INIT_PROMPT);
          return;
        case "goal":
          return say(await goal(id, args));
        case "rename":
          if (!args) return say("Write its new name after it: `/rename <name>`.");
          await rpc("thread/name/set", { threadId: id, name: args });
          return say(`Renamed it “${args}”.`);
        case "fork": {
          const r = await rpc("thread/fork", { threadId: id, excludeTurns: true });
          const copy = r?.thread && ensurePost(r.thread, { active: true });
          return say(copy ? `Forked it: the copy is ${copy.label}, on Codex's wall.` : "Forked it.");
        }
        case "status":
          return say(await statusOf(id));
        case "usage":
          return say(usageOf(await limits()) || "Codex didn't say how much of its limits it has used.");
        case "mcp":
          return say(await mcpOf(id));
        case "model": {
          const m = models.list.find((x) => x.id.toLowerCase() === args.toLowerCase() || x.name.toLowerCase() === args.toLowerCase());
          if (!m) return say(`Pick one of its models: ${models.list.map((x) => `\`/model ${x.id}\``).join(", ") || "Codex listed none"}.`);
          host.commit({ t: "session.model", post: id, model: m.id });
          return say(`Its next turn is on ${m.name}.`);
        }
      }
      // A skill: its name as Codex's app writes it ($name), with what you wrote after it, and the skill itself.
      const k = (await skillsIn(cwdFor(id))).find((x) => x.name === name);
      await sendTurn(id, k ? `$${name}${args ? ` ${args}` : ""}` : text, k ? { also: [{ type: "skill", name, path: k.path }] } : {});
    } catch (e) {
      if (/Not connected|disconnected/.test(e.message)) throw e;
      th.compacting = false;
      say(`Codex couldn't run /${name}: ${e.message}`);
    }
  }
  // A compaction you asked for is done: it says so (one that Codex did by itself is a step, as before).
  function compacted(id) {
    const th = threads.get(id);
    if (!th?.compacting) return;
    th.compacting = false;
    host.commit({ t: "message.add", post: id, from: "agent", via: "dash", text: "Compacted the conversation: Codex goes on from a summary of it.", command: "compact" });
  }
  // What /review looks at: your uncommitted changes, what's changed since a base branch, a commit, or what you say.
  function reviewTarget(args) {
    const base = /^base\s+(\S+)$/i.exec(args);
    if (!args) return { type: "uncommittedChanges" };
    if (base) return { type: "baseBranch", branch: base[1] };
    if (/^[0-9a-f]{7,40}$/i.test(args)) return { type: "commit", sha: args };
    return { type: "custom", instructions: args };
  }
  // /goal: set it, show it, clear, pause or resume it, as Codex's own /goal does. Set by you (origin "user"), which
  // Codex takes as yours to change.
  const GOAL_STATES = { active: "Working on it", paused: "Paused", blocked: "Blocked", usageLimited: "Stopped at a usage limit", budgetLimited: "Out of its token budget", complete: "Done" };
  async function goal(id, args) {
    const word = args.toLowerCase();
    if (word === "clear") {
      await rpc("thread/goal/clear", { threadId: id, origin: "user" });
      return "Cleared the goal.";
    }
    if (word === "pause" || word === "resume") {
      const g = (await rpc("thread/goal/set", { threadId: id, status: word === "pause" ? "paused" : "active", origin: "user" }))?.goal;
      return `${word === "pause" ? "Paused" : "Resumed"} the goal${g?.objective ? `: ${g.objective}` : "."}`;
    }
    if (word === "edit") return "Write the new goal after it: `/goal <objective>`.";
    if (args) {
      const g = (await rpc("thread/goal/set", { threadId: id, objective: args, status: "active", origin: "user" }))?.goal;
      return `Goal set: ${g?.objective || args}`;
    }
    const g = (await rpc("thread/goal/get", { threadId: id }))?.goal;
    if (!g) return "No goal set. `/goal <objective>` sets one, and Codex works toward it.";
    const mins = Math.round((Number(g.timeUsedSeconds) || 0) / 60);
    const spent = [mins ? (mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min` : `${mins} min`) : null, g.tokensUsed ? `${tokens(g.tokensUsed)}${g.tokenBudget ? ` of ${tokens(g.tokenBudget)}` : ""} tokens` : null].filter(Boolean);
    return `**Goal:** ${g.objective}\n\n${GOAL_STATES[g.status] || g.status}${spent.length ? ` · ${spent.join(" · ")}` : ""}`;
  }
  const tokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
  const tilde = (p) => (p && p.startsWith(os.homedir()) ? `~${p.slice(os.homedir().length)}` : p || "");
  const SANDBOX = { dangerFullAccess: "Full access", readOnly: "Read-only", workspaceWrite: "Workspace write", externalSandbox: "An external sandbox" };
  // /status: what the thread runs with (as loading it said, else Codex's config for its folder), and its plan's limits.
  async function statusOf(id) {
    const th = thread(id);
    const st = th.settings || {};
    const cfg = (await rpc("config/read", { cwd: th.cwd || null }).catch(() => null))?.config || {};
    const effort = st.effort || cfg.model_reasoning_effort;
    const approvals = typeof st.approvals === "string" ? st.approvals : st.approvals ? "granular" : cfg.approval_policy;
    const sandbox = SANDBOX[st.sandbox] || cfg.sandbox_mode;
    const rows = [
      ["Model", `${st.model || th.digest.model || cfg.model || "its default"}${effort ? `, ${effort} reasoning` : ""}`],
      ["Folder", th.cwd ? `\`${tilde(th.cwd)}\`` : null],
      ["Approvals", approvals],
      ["Sandbox", sandbox],
      ["Context", th.digest.context ? `${tokens(th.digest.context)} tokens` : null],
      ["Thread", `\`${id}\``],
    ].filter(([, v]) => v);
    const usage = usageOf(await limits().catch(() => null));
    return [rows.map(([k, v]) => `- **${k}:** ${v}`).join("\n"), usage].filter(Boolean).join("\n\n");
  }
  // Its ChatGPT plan's limits, as its profile has them (limits.mjs), as a table.
  function usageOf(r) {
    const l = r?.limits?.[0];
    if (!l?.windows?.length) return r?.error ? `Codex couldn't say how much of its limits it has used: ${r.error}` : "";
    const at = (iso) => (iso ? new Date(iso).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" }) : "");
    const rows = l.windows.map((w) => `| ${w.label} | ${Math.round(w.used)}% | ${at(w.resets)} |`);
    const head = `**${[l.name, l.plan].filter(Boolean).join(" ")} limits**${l.blocked ? " · out until one resets" : ""}`;
    return `${head}\n\n${["| Limit | Used | Resets |", "| --- | --- | --- |", ...rows].join("\n")}`;
  }
  // /mcp: each MCP server, whether it's up, and how many tools it gives.
  const MCP_STATES = { connected: "Connected", starting: "Starting", notStarted: "Not started", failed: "Failed", authenticationRequired: "Needs you to sign in", cancelled: "Cancelled", disabled: "Off" };
  async function mcpOf(id) {
    const r = await rpc("mcpServerStatus/list", { threadId: id, detail: "toolsAndAuthOnly" });
    const list = r?.data || [];
    if (!list.length) return "Codex has no MCP servers.";
    const rows = list.map((m) => {
      const n = Object.keys(m.tools || {}).length;
      const st = m.authStatus === "notLoggedIn" ? "Needs you to sign in" : MCP_STATES[m.runtimeStatus] || (m.toolsError ? "Failed" : "");
      return `| ${String(m.name).replace(/\|/g, "\\|")} | ${st}${m.toolsError ? `: ${short(m.toolsError, 80).replace(/\|/g, "\\|")}` : ""} | ${n} |`;
    });
    return ["| MCP server | Status | Tools |", "| --- | --- | --- |", ...rows].join("\n");
  }

  async function start({ cwd, prompt, shown = prompt, lid, model, effort, dirs = [] }) {
    if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`No folder at ${cwd}`);
    await connect();
    // What it's told about agentbook stays with the thread, as its developer instructions.
    const context = await host.context({ launch: lid, cwd }).catch((e) => log(`codex context: ${e.message}`));
    // A thread in a group can write the group's folder too.
    const extra = equip(`launch:${lid}`, cwd);
    if (dirs.length) extra.config["sandbox_workspace_write.writable_roots"] = dirs;
    const r = await loading("thread/start", { cwd, model: model || undefined }, { ...extra, ...(context ? { developerInstructions: context } : {}) });
    const t = r.thread;
    const th = thread(t.id);
    th.subscribed = true;
    th.settings = settingsOf(r);
    ensurePost(t, { lid });
    host.commit({ t: "message.add", post: t.id, from: "human", via: "dash", text: shown, resume: lid });
    await sendTurn(t.id, prompt, { effort });
    return { id: t.id };
  }

  // A side thread: the thread forked as it is, its copy going on with what you sent while the
  // thread works on, untouched. The copy works where the thread works, with agentbook's tools as itself (`launch:`
  // until its post is there, as a thread agentbook starts). Codex gives it the thread's name too: it's named after
  // what you sent, there and here.
  async function side({ id, cwd, prompt, shown = prompt, lid, effort, dirs = [] }) {
    await connect();
    cwd = cwd || cwdFor(id);
    if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`No folder at ${cwd}`);
    const extra = equip(`launch:${lid}`, cwd);
    if (dirs.length) extra.config["sandbox_workspace_write.writable_roots"] = dirs;
    const r = await loading("thread/fork", { threadId: id, cwd, excludeTurns: true }, extra);
    const name = short(String(shown).split("\n")[0], 80) || "Side thread";
    const t = { ...r.thread, name, preview: shown };
    const th = thread(t.id);
    th.subscribed = true;
    th.settings = settingsOf(r);
    await rpc("thread/name/set", { threadId: t.id, name }).catch((e) => log(`codex: couldn't name side thread ${t.id}: ${e.message}`));
    ensurePost(t, { lid });
    host.commit({ t: "message.add", post: t.id, from: "human", via: "dash", text: shown, resume: lid });
    await sendTurn(t.id, prompt, { effort });
    return { id: t.id };
  }

  async function stop(id) {
    const th = threads.get(id);
    if (!th?.turn) throw new Error("It isn't working on anything right now.");
    await rpc("turn/interrupt", { threadId: id, turnId: th.turn });
  }

  // Every step of a thread. Followed threads have them already; others are read once from Codex.
  async function steps(id) {
    const th = thread(id);
    const s = post(id);
    if (!th.subscribed && ws && Date.now() - th.read > 10000) {
      th.read = Date.now();
      const r = await rpc("thread/read", { threadId: id, includeTurns: true }).catch(() => null);
      if (r?.thread) {
        const d = (th.digest = Object.assign(blank(), { model: th.digest.model, ai_title: th.digest.ai_title }));
        th.cwd = cwdOf(r.thread) || th.cwd || s?.cwd || "";
        for (const turn of ownTurns(r.thread.turns, s?.side_at)) {
          for (const item of turn.items || []) {
            take(id, item, (turn.startedAt || 0) * 1000, false, false);
            take(id, item, (turn.completedAt || turn.startedAt || 0) * 1000, true, false);
          }
          d.worked += Number(turn.durationMs) || 0;
        }
      }
    }
    return th.digest;
  }

  // The skills Codex can use, for the newest thread's folder. Logged on the newest post when they change.
  async function skills() {
    const newest = Object.values(host.state.sessions).filter((s) => s.agent === "codex" && s.cwd).sort((a, b) => b.started.localeCompare(a.started))[0];
    if (!newest) return;
    const r = await rpc("skills/list", { cwds: [newest.cwd] }).catch(() => null);
    const list = (r?.data || []).flatMap((e) => e.skills || []).filter((k) => k.enabled !== false);
    const out = list.map((k) => ({ name: k.name, description: short(k.shortDescription || k.description, 200), file: k.path || null }));
    if (out.length && JSON.stringify(newest.skills || null) !== JSON.stringify(out)) host.commit({ t: "session.skills", post: newest.id, skills: out });
  }

  // The models you can pick for Codex, as its own pickers list them, each with the reasoning efforts it takes.
  async function loadModels() {
    const r = await rpc("model/list", {});
    const list = (r?.data || []).filter((m) => !m.hidden);
    if (!list.length) return;
    const one = (m) => ({ id: m.model || m.id, name: m.displayName || m.model || m.id, efforts: (m.supportedReasoningEfforts || []).map((e) => e.reasoningEffort), effort: m.defaultReasoningEffort || null });
    const def = one(list.find((m) => m.isDefault) || list[0]);
    models = { list: list.map(one), default: def.id || null, efforts: def.efforts, effort: def.effort };
  }

  const digest = (s) => threads.get(s.id)?.digest || null;
  function live(s) {
    const d = digest(s);
    if (!d) return null;
    const turn = d.steps.filter((x) => x.turn === d.turn);
    const step = [...turn].reverse().find((x) => x.kind === "tool" && !x.done) || turn.at(-1) || null;
    return { step: liveStep(step), plan: d.plan, steps: d.tools, turn_steps: turn.filter((x) => x.kind === "tool").length, turn_start: turn[0]?.at || null };
  }
  function summary(s) {
    const d = digest(s);
    if (!d) return null;
    const files = filesChanged(d.edits, s);
    return { ai_title: d.ai_title, model: d.model, plan: d.plan, context: d.context, prs: d.prs, stats: { steps: d.tools, errors: d.errors, worked_ms: d.worked, ...(files ? { files } : {}) } };
  }

  /* ---------- routines: the ChatGPT app's automations ---------- */

  const automations = createCodexAutomations({ log });
  const refused = (status, message) => Object.assign(new Error(message), { status });
  // A heartbeat's thread is a post when agentbook follows it.
  const withPost = (r) => (r.thread && post(r.thread) ? { ...r, post: r.thread } : r);

  // What its profile shows before you open them. null: it has none.
  function routinesOf(agentId) {
    if (agentId !== "codex") return null;
    const list = automations.routines();
    if (!list.length) return null;
    const next = list.map((r) => r.next).filter(Boolean).sort()[0] || null;
    const last = list.map((r) => r.last).filter(Boolean).sort().at(-1) || null;
    return { n: list.length, loops: list.filter((r) => r.group === "loop").length, paused: list.filter((r) => !r.enabled).length, failing: 0, running: list.filter((r) => r.running).length, next, last };
  }
  async function routines(agentId) {
    return agentId === "codex" ? { routines: automations.routines().map(withPost) } : null;
  }
  // A post's loops: the heartbeats that send their prompt into its thread.
  function loopsOf(s) {
    const list = automations.routines().filter((r) => r.thread === s.id);
    return list.length ? list.map((r) => ({ ...r, post: s.id, live: r.enabled, runs: null })) : null;
  }

  // A thread as a run: the steps it took and the last thing it said.
  async function readRun(threadId, turnId = null) {
    await connect();
    const t = (await rpc("thread/read", { threadId, includeTurns: true }))?.thread;
    if (!t) return null;
    const cwd = cwdOf(t);
    const steps = [];
    let reply = null;
    for (const turn of t.turns || []) {
      if (turnId && turn.id !== turnId) continue;
      const done = iso(turn.completedAt || turn.startedAt);
      for (const item of turn.items || []) {
        if (item.type === "agentMessage" && item.text?.trim()) {
          steps.push({ id: item.id, kind: "say", at: done, text: short(item.text, 600) });
          reply = { text: item.text, at: done };
        } else if (item.type !== "userMessage") {
          const title = stepOf(item, cwd);
          if (title) steps.push({ id: item.id, kind: "tool", at: iso(turn.startedAt), tool: item.type, title, done, error: failed(item) ? errorOf(item) : null });
        }
      }
    }
    return { steps, reply, model: t.model || null };
  }

  // One automation, with its runs, newest first. A heartbeat's runs are the turns it started in its thread.
  async function routine(agentId, job, { offset = 0 } = {}) {
    const r = agentId === "codex" && automations.one(job);
    if (!r) return null;
    if (!r.thread) return { routine: withPost(r), ...automations.runs(job, { offset }) };
    let turns = [];
    try {
      await connect();
      turns = (await rpc("thread/read", { threadId: r.thread, includeTurns: true }))?.thread?.turns || [];
    } catch (e) {
      return { routine: withPost(r), runs: [], total: null, more: false, error: `Codex couldn't read its thread: ${e.message}` };
    }
    const mine = turns.filter((t) => (t.items || []).some((i) => i.type === "userMessage" && heartbeatOf(textOf(i.content)) === job)).reverse();
    const inPost = !!post(r.thread);
    const runs = mine.map((t) => {
      const said = (t.items || []).filter((i) => i.type === "agentMessage" && i.text?.trim()).at(-1)?.text;
      const status = t.status === "failed" ? "error" : t.status === "inProgress" ? "running" : "ok";
      return { id: t.id, job, at: iso(t.startedAt), took: Number(t.durationMs) || null, status, error: status === "error" ? short(t.error?.message, 200) || "It failed" : null, summary: said ? short(said, 400) : null, session: inPost ? null : `${r.thread}#${t.id}`, post: inPost ? r.thread : null };
    });
    return { routine: withPost(r), runs: runs.slice(offset, offset + 50), total: runs.length, more: runs.length > offset + 50 };
  }
  // A run: an automation's thread, or a heartbeat's turn in its thread ("<thread>#<turn>").
  async function routineRun(agentId, job, session) {
    const r = agentId === "codex" && automations.one(job);
    if (!r || !session) return null;
    const [thread, turn] = String(session).split("#");
    if (r.thread ? thread !== r.thread || !turn : !automations.isRun(job, thread)) return null;
    return readRun(thread, turn || null);
  }
  async function routineDo(agentId, job) {
    if (agentId !== "codex" || !automations.one(job)) return false;
    throw refused(409, "Codex runs and pauses its automations in the ChatGPT app: open it there.");
  }

  function begin() {
    if (!enabled) return;
    const tick = () => sync().catch((e) => lastError !== e.message && log(`codex: ${(lastError = e.message)}`));
    tick();
    setInterval(tick, Number(process.env.AGENTBOOK_CODEX_SYNC_MS || 15000)).unref();
    setTimeout(() => skills().catch(() => {}), 5000).unref();
    setInterval(() => skills().catch(() => {}), 30 * 60e3).unref();
    setInterval(() => loadModels().catch(() => {}), 30 * 60e3).unref();
  }

  // How much of its ChatGPT plan's limits it has used (limits.mjs).
  const limits = limitsReader(async () => {
    await connect();
    return { limits: [codexLimitsOf(await rpc("account/rateLimits/read", { excludeResetCreditDetails: true }))] };
  });

  return {
    prefix: "codex", // its posts' procs: "codex:<thread id>"
    name: "Codex",
    owns: (agentId) => agentId === "codex",
    postOf,
    begin,
    sync,
    start,
    side,
    stop,
    deliver,
    steps,
    digest,
    live,
    summary,
    working: (id) => !!threads.get(id)?.turn,
    workers: workersOf,
    workerSteps: workerStepsOf,
    models: () => models,
    switchesModel: true,
    commands,
    commandsWait: true, // a slash command waits for a turn that's running to end, never steered into it
    replyBlocked: () => null,
    resumeCommand: (s) => `cd ${s.cwd || s.root || "."} && codex resume ${s.session_id}`,
    routinesOf,
    routines,
    routine,
    routineRun,
    routineDo,
    loopsOf,
    limits: (agentId) => (agentId === "codex" && enabled ? limits() : null),
    status: () => ({ enabled, connected: !!ws, error: lastError }),
  };
}
