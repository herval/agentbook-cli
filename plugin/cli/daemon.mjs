// agentbook-cli: the machine's half of agentbook. It follows this machine's agents
// (Claude Code, Codex, OpenClaw, Hermes, cloud), keeps what it needs to carry on in its own store, sends what they
// do up to its server as ops, and does what the server asks (commands and reads), checked on the way in.
//
// It serves the machine's own sessions on loopback, as agentbook always has: the hooks, the MCP bridge, /api/mcp
// for Codex, question long-polls. Loopback is trusted here: it's the same machine and the same person.
//
// createCli() makes one; plugin/cli/main.mjs runs it, talking to its server over HTTP (uplink.mjs).

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { attached, bird, describe, gitInfo, isVersion, LOGIN_LOST, NOT_LOGGED_IN, olderVersion, PLUGIN_ROOT, PORT, VERSION } from "../lib/common.mjs";
import { claudeCommands, claudeModels, cleanEnv, createClaude, learnCommand, openTerminal } from "./drivers/claude.mjs";
import { cloudSessionId, codexTaskId, createCloud } from "./drivers/cloud.mjs";
import { createCodex } from "./drivers/codex.mjs";
import { createClaudeRoutines } from "./drivers/claude-routines.mjs";
import { createHermes } from "./drivers/hermes.mjs";
import { createDsh } from "./drivers/dsh.mjs";
import { createManaged } from "./drivers/managed.mjs";
import { createDevin } from "./drivers/devin.mjs";
import { createOpenclaw } from "./drivers/openclaw.mjs";
import { decodeSetupCode } from "./drivers/openclaw-gateway.mjs";
import { capped, createChanges, parseUnified, sizeOf, sizeText, totals } from "./changes.mjs";
import { loginChangedAt, watchLogin } from "./claude-login.mjs";
import { createSignin } from "./claude-signin.mjs";
import { trustFolder } from "./claude-trust.mjs";
import { branches, clone, cloneTarget, cloneUrl, commitsSince, currentBranch, goneFolder, placeOf, prepare, remoteOf, repoKey, restoreFolder, scanCheckouts, showCommit } from "./git.mjs";
import { createGate, real, retiredThread } from "./gate.mjs";
import { pinOf } from "./signatures.mjs";
import { createRoutineRunner } from "./routines.mjs";
import { createRuns } from "./runs.mjs";
import { createTerminals } from "./terminals.mjs";
import { installedByClaude } from "./uninstall.mjs";
import { createGroupFiles } from "./group-files.mjs";
import { forgetLeftovers } from "./leftovers.mjs";
import { cleanPath } from "../shared/groups.mjs";
import { ATTACHABLE, cleanData, noteLines } from "../shared/widgets.mjs";
import { localPictures, shapeOf, withDraft } from "../shared/shapes.mjs";
import { reachOf } from "./reach.mjs";
import { createWork } from "./work.mjs";
import * as mcp from "./mcp.mjs";
import { contextText, fromServer } from "./context.mjs";
import { createTranscripts, describeTool } from "./transcript.mjs";
import { cleanUp, discard, listWip, wipDetail, wipDiff } from "./wip.mjs";
import { conversationOf, createStore, fileOf, foldedInto, helloLaunch, PASSING_ERRORS, publicState, queued, CLI_HOME, FILES_DIR, HOME } from "../shared/store.mjs";
import { githubRepo, prOfUrl, prUrl } from "../shared/prs.mjs";
import { machineName } from "../shared/ids.mjs";
import { going as workerGoing, goingOf as workersGoing, shown as shownWorkers } from "./workers.mjs";
import { localPicture, picture, readPicture } from "../shared/pictures.mjs";
import { isLevel } from "../shared/visibility.mjs";
import { accept as acceptWs, refuse as refuseWs } from "../shared/ws.mjs";
import { AUTH_HEADER, AUTH_WINDOW_MS, PROOF_HEADER, checkRequest, proofOf } from "../shared/local-auth.mjs";
import { redact, redactDeep, secretFileRefusal } from "./redact.mjs";
import { createFileKeep } from "./file-keep.mjs";

const MAX_BODY = 80 * 1024 * 1024;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// The routes this machine's sessions use, on loopback: the hooks, the MCP bridge, question long-polls, and
// agentbook-cli's own commands. Everything else is the page's, on the server.
const SESSION_ROUTES = [/^\/api\/health$/, /^\/api\/show$/, /^\/api\/hello$/, /^\/api\/procs\//, /^\/api\/mcp$/, /^\/api\/gate(\/approve)?$/, /^\/api\/status$/, /^\/api\/local\/openclaw(\/pair)?$/, /^\/api\/local\/remote$/, /^\/api\/local\/fold$/];
export const isSessionRoute = (method, pathname) => SESSION_ROUTES.some((re) => re.test(pathname)) || (method === "GET" && /^\/api\/questions\/[^/]+$/.test(pathname));

// `machine`: this machine's name, as its server knows it.
// `faults`: what it kept going through (crash.mjs), for `status`.
export function createCli({ machine = machineName(process.env.AGENTBOOK_MACHINE || os.hostname().split(".")[0]), faults = null } = {}) {
  const MACHINE = machine;
  // Its log keeps every op its server hasn't acknowledged, however old (uplink.mjs).
  const store = createStore({ acks: true, moveCorrupt: true });
  const { state } = store;

  // Private terminals (its person's setting, on their profile): only threads started in agentbook are on it. A
  // session started anywhere else gets no thread, so nothing of it goes up to the server: Claude Code or Codex in a
  // terminal, an editor, the desktop app or `claude --bg`, and a chat with an OpenClaw or Hermes agent on Discord or
  // Telegram, a Codex Cloud task (unless it's brought here by its link), an OpenClaw cron run. Its hooks and tools
  // hear it's kept off. What's a thread already stays one (a resume, a copy, a /clear in a process agentbook
  // started). The server says it with each poll (setPrefs), and this machine keeps what it last said, for while
  // it's off or starting.
  const PREFS_FILE = path.join(CLI_HOME, "prefs.json");
  let prefs = (() => {
    try {
      return JSON.parse(fs.readFileSync(PREFS_FILE, "utf8")) || {};
    } catch {
      return {};
    }
  })();
  const keptOff = new Set(); // procs (and session ids) kept off agentbook
  const brought = new Set(); // Codex Cloud tasks brought here by their link (cloud.pull): started from agentbook
  const KEPT_OFF = "This session is kept off agentbook: Private terminals is on, so only threads started in agentbook are on it.";
  // Where this machine's past starts, as its person said at login (ms, 0: however far its agents' windows go).
  const historyFrom = () => Date.parse(gate.settings().history_from) || 0;
  // Whether a session saying hello would be a new thread agentbook didn't start, while Private terminals is on.
  function startedElsewhere(op) {
    if (!(prefs.private_terminals || gate.settings().private_terminals) || brought.has(op.session_id)) return false;
    const key = (op.session_id && foldedInto(state, op.session_id)) || op.session_id || op.proc;
    if (state.sessions[key]) return false;
    const was = state.procs[op.proc];
    if (was && state.sessions[was] && (was === op.proc || state.sessions[was].launch)) return false;
    return !helloLaunch(state, key, op);
  }
  // A start of agentbook's whose session it doesn't know yet: Claude Code says a background session's id once it has
  // started it (launch.started), and the session may say hello first.
  const launchInFlight = () => Object.values(state.launches).some((l) => !l.post && !l.error && !l.session && !l.resume && Date.now() - Date.parse(l.at) < 120e3);
  function keepOff(op) {
    if (!keptOff.has(op.proc)) log(`private terminals: ${op.kind || "claude-code"} session ${op.session_id || op.proc} stays off agentbook`);
    keptOff.add(op.proc);
    if (op.session_id) keptOff.add(op.session_id);
  }
  // Every new thread goes through here: a driver's session (an OpenClaw chat, a Codex thread) agentbook didn't start
  // isn't one, and nothing else of it (its messages, its status) goes up either.
  const commit = (op) => {
    if (op?.t === "session.hello" && startedElsewhere(op)) return void keepOff(op);
    if (op?.post && keptOff.has(op.post) && !state.sessions[op.post]) return;
    return store.commit(op);
  };
  const transcripts = createTranscripts();
  const changes = createChanges({ load: transcripts.load });
  let uplink = null; // set once the server is known (setUplink)
  let serverUrl = null;
  // Its server stopped taking this machine's login: what its threads hear, as they start and at each one's next prompt.
  const loginLost = () => (uplink?.status().signed_out ? LOGIN_LOST(serverUrl) : null);
  const toldLoginLost = new Set(); // posts told, for this stop: emptied once its server takes the login again (connected)
  let started = false;
  let owner = null; // whose machine this is, as its server says: { username }
  let latest = null; // the newest agentbook-cli, if its server says (setLatest)

  // The agents agentbook runs sessions for. Claude Code sessions run in the background under Claude Code's
  // supervisor; Codex threads run in Codex's app-server daemon.
  const claude = createClaude({ log });
  const gitCache = new Map();
  // What drivers get from the CLI: its state, a way to change it, and the helpers they share.
  const driverHost = {
    state,
    commit,
    // Whether a session of theirs is kept off agentbook (Private terminals): it has no post, and gets none for now.
    keptOff: (id) => keptOff.has(id) && !state.sessions[id],
    pending: store.pending,
    undelivered: (post, events, why) => undelivered(post, events, why),
    label: bird,
    describe,
    attached,
    gitInfo: (cwd) => {
      if (!cwd) return { root: "", repo: "", branch: "" };
      if (!gitCache.has(cwd)) gitCache.set(cwd, gitInfo(cwd));
      return gitCache.get(cwd);
    },
    changed: (id, save) => {
      pageChanged();
      if (save) saveSnapshot(state.sessions[id]);
      if (id) work.touch(id, { changes: !!save });
    },
    // Fetch a file it keeps elsewhere now, rather than when it's first opened (a new message's picture), and
    // again the ones that stopped coming, once it's connected again.
    fetchFile,
    refetch: () => [...unfetched].forEach(fetchFile),
    // What a session it starts is told about agentbook (see contextFor), and agentbook's MCP server for it, at
    // /api/mcp: the ab_* tools, writing to its post (`proc`: `codex:<thread>`, or `launch:<lid>` before it has
    // one), with paths relative to the folder it works in (`cwd`).
    context: (q) => contextFor(q),
    // What changed in a thread's group since it last heard, to send with what it gets anyway (a promise of text).
    news: (id) => groupNews(id),
    mcp: (proc, cwd, { bridged = false } = {}) => ({ url: mcpUrl(proc, cwd, bridged) }),
    // The same tools for every thread of an agent, wherever it was started (Codex's own config entry for them).
    // With its server elsewhere it holds a key of its own, also while local_key waits, so it still works once that's on.
    mcpForAll: (agent) => ({ url: `${SELF_URL}/api/mcp?${new URLSearchParams({ agent, ...(hosted() ? { key: mcpKey(`agent:${agent}`) } : {}) })}` }),
    // Whether its person agreed to that, for Codex, at login (a machine from before that question: yes).
    codexTools: () => gate.settings().codex_tools !== false,
    historyFrom,
    // The same server, here, for an agent that can't reach /api/mcp (OpenClaw's, on its gateway's machine, whose
    // calls its driver hands on): one JSON-RPC message, answered as the post `who` says (see mcp.handle).
    mcpCall: (msg, who) => mcp.handle(msg, who),
    // Bytes kept on the server (an agent's picture): their sha256, or null while it can't be reached.
    blobPut: (buf, type) => blobPut(buf, type),
    log,
  };
  const codex = createCodex(driverHost);
  const openclaw = createOpenclaw(driverHost);
  const hermes = createHermes(driverHost);
  const dsh = createDsh(driverHost);
  const managed = createManaged(driverHost);
  const devin = createDevin(driverHost);
  // Agents agentbook runs through drivers of their own (Codex's daemon, OpenClaw's gateway, Hermes's and dsh's ACP servers,
  // Claude Agent's and Devin's APIs): each owns the posts whose proc starts with its prefix ("codex:<thread id>"), and
  // the agents it lists.
  const drivers = [codex, openclaw, hermes, dsh, managed, devin];
  const driverOf = (s) => (s && !s.cloud && s.proc ? drivers.find((d) => s.proc.startsWith(`${d.prefix}:`)) || null : null);
  const driverOfAgent = (id) => drivers.find((d) => d.owns(id)) || null;
  const cloud = createCloud({ state, commit, label: bird, historyFrom, log });
  // Claude's routines: its routines on claude.ai, and the loops its posts run (/loop). Other agents' come from
  // their drivers (OpenClaw's cron jobs, Codex's automations).
  // Its routines on claude.ai are read with Claude Code's sign-in only when its server is this machine (claude-routines.mjs).
  const hosted = () => {
    try {
      return !!serverUrl && !["127.0.0.1", "localhost", "::1", "[::1]"].includes(new URL(serverUrl).hostname);
    } catch {
      return !!serverUrl;
    }
  };
  const claudeRoutines = createClaudeRoutines({ state, commit, changed: () => pageChanged(), log, hosted });
  const routinesOfAgent = (id) => (claudeRoutines.owns(id) ? claudeRoutines : driverOfAgent(id));
  // A page routine's code, run here when the server says (page_routine.run).
  const routineRunner = createRoutineRunner({ home: HOME, log });
  // A terminal for its owner, in a post's folder as this machine has it (terminals.mjs), talking to the page through
  // the server on its own line; its shell outlives agentbook-cli, which finds it again as it starts.
  const terminals = createTerminals({ home: CLI_HOME, line: () => uplink?.termSocket?.() ?? null, hosted, log });
  // Code blocks run from a thread's messages (post.run), in its terminal: what they print goes up as it comes.
  const codeRuns = createRuns({ state, commit, changed: () => (pageChanged(), uplink?.push()), machine: MACHINE, refused: (dir, post) => gate.pathRefusal(dir, { post }), terminals: () => (gate.settings().commands.term !== false ? terminals : null), opens: () => !(gate.settings().keys.length && gate.settings().signed.includes("term.open")), log });

  // Something the page shows changed: what the machine knows goes up again.
  function pageChanged() {
    uplink?.infoChanged();
  }

  /* ---------- helpers ---------- */

  function send(res, status, body, type = "application/json") {
    const data = type === "application/json" ? JSON.stringify(body) : body;
    res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(data);
  }
  const ok = (res, body = { ok: true }) => send(res, 200, body);
  const fail = (res, status, error, extra = {}) => send(res, status, { error, ...extra });

  function readBody(req, raw = false) {
    // A body already read (to see where a request goes) is kept on the request.
    if (req.rawBody) {
      if (raw) return Promise.resolve(req.rawBody);
      try {
        return Promise.resolve(req.rawBody.length ? JSON.parse(req.rawBody.toString("utf8")) : {});
      } catch {
        return Promise.reject(new Error("Invalid JSON"));
      }
    }
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new Error("Body too large"));
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => {
        const buf = Buffer.concat(chunks);
        if (raw) return resolve(buf);
        if (!buf.length) return resolve({});
        try {
          resolve(JSON.parse(buf.toString("utf8")));
        } catch {
          reject(new Error("Invalid JSON"));
        }
      });
      req.on("error", reject);
    });
  }

  const str = (v, max = 2000) => (v == null ? "" : String(v).slice(0, max));
  const slug = (name) => String(name || "agent").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "agent";
  // A model's name or alias ("sonnet", "claude-opus-5-5", "opus[1m]", "gpt-6.1-sol"); it goes on a command line.
  const modelName = (v) => {
    const m = str(v, 80).trim();
    return /^[a-zA-Z0-9][\w.:@\[\]\/-]*$/.test(m) ? m : "";
  };
  const safeName = (name) => path.basename(String(name || "file")).replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "file";

  function storeFile(buf, name) {
    const stored = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}-${safeName(name)}`;
    fs.writeFileSync(path.join(FILES_DIR, stored), buf, { mode: 0o600 });
    return stored;
  }

  // "17:00" → today (or tomorrow) at 17:00 local; ISO strings pass through.
  function parseUntil(v) {
    if (!v) return null;
    const s = String(v).trim();
    const hm = s.match(/^(\d{1,2}):(\d{2})$/);
    if (hm) {
      const d = new Date();
      d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
      if (d < new Date()) d.setDate(d.getDate() + 1);
      return d.toISOString();
    }
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }

  // A poll's options: "Label|what it means", or { label, detail } (or description).
  function options(list) {
    return (Array.isArray(list) ? list : []).slice(0, 6).map((o) => {
      if (o && typeof o === "object") return { label: str(String(o.label ?? "").trim(), 80), detail: str(String(o.detail ?? o.description ?? "").trim(), 140) || null };
      const [label, ...rest] = String(o).split("|");
      return { label: str(label.trim(), 80), detail: str(rest.join("|").trim(), 140) || null };
    });
  }

  /* ---------- what the machine knows right now (info, for the page) ---------- */

  const liveOf = (s) => (driverOf(s) ? driverOf(s).live(s) : transcripts.live(s));
  const live = () => Object.fromEntries(Object.values(state.sessions).filter((s) => s.state !== "done").map((s) => [s.id, liveOf(s)]));

  // Where a session runs: in the background (Claude Code's supervisor), in a terminal, or through a driver.
  function runtimeOf(s) {
    if (s.cloud === "claude") return { kind: "cloud", vendor: "claude", url: s.url, teleport: cloud.teleportCommand(s.session_id) };
    if (s.cloud === "codex") return { kind: "cloud", vendor: "codex", url: s.url, apply: `codex cloud apply ${s.session_id}` };
    const d = driverOf(s);
    if (d) return { kind: "driver", vendor: d.prefix, name: d.name, working: d.working(s.id), syncing: !!d.syncing?.(s.id), models: d.switchesModel, resume: s.session_id ? d.resumeCommand(s) : null, blocked: d.replyBlocked(s), ...(d.repos ? { remote: true } : {}) };
    const a = claude.info(s.session_id);
    if (!a) return null;
    return { kind: a.kind, id: a.id, state: a.state, status: a.status, waiting_for: a.waitingFor || null };
  }
  // The workers its agent started (workers.mjs), going or lately ended: its driver's, or a Claude Code session's,
  // from its subagents' transcripts.
  const workersOf = (s) => (!s || s.cloud ? [] : shownWorkers(driverOf(s) ? driverOf(s).workers?.(s.id) : claudeWorkers(s)));
  // A Claude Code session's subagents run in its process: once that's gone (a terminal closed without ending it),
  // so are those that were still going.
  function claudeWorkers(s) {
    const list = transcripts.workers(s);
    const a = claude.info(s.session_id);
    return a && !claude.running(a) ? list.map((w) => (workerGoing(w) ? { ...w, state: "stopped", ended: s.updated || null, step: null } : w)) : list;
  }
  // What a session has going between its turns: its workers still going, and for a background session, what Claude
  // Code lists (a shell watching a CI run, a monitor). Its turn ended, but it's working on those, and hears back when
  // they finish. A command is called what its step was.
  function goingOf(s) {
    if (!s || s.busy || s.cloud) return null;
    const own = driverOf(s) ? [] : claude.workOf(s.session_id).map((w) => ({ id: w.id, kind: w.kind, title: transcripts.taskTitle(s, w.id) || w.label, started: w.started }));
    // A subagent Claude Code lists too (by its id for it, or its name) is the one worker.
    const ids = new Set(own.flatMap((x) => [x.id, x.title]));
    const workers = workersOf(s).filter((w) => !ids.has(w.agent) && !ids.has(w.title));
    const all = [...own, ...workersGoing(workers)];
    return all.length ? all : null;
  }
  // What the page shows of this machine that its store doesn't have: each post's runtime and what it's doing this
  // moment, each agent's extras, the machine's folders, and the machine itself. Keys are replaced whole when they
  // change (see uplink.mjs).
  function info() {
    const out = {};
    const clones = cloneDir();
    out.machine = { name: MACHINE, os: `${os.platform()} ${os.release()}`, home: os.homedir(), clone_dir: clones, drivers: Object.fromEntries(drivers.map((d) => [d.prefix, d.status()])), cli: VERSION || "unknown", gate: gate.summary() };
    const v = publicState(state);
    out.folders = { folders: knownFolders(v.folders, clones), cloning: [...cloning.values()].map(({ repo, dir, error }) => ({ repo, dir, error })) };
    for (const s of v.sessions) {
      const p = { rt: runtimeOf(s) };
      // Its loops as they stand (live, or ended today): Claude's /loop, or Codex automations' heartbeats into its thread.
      if (s.loops) p.loops = claudeRoutines.loopsOf(s);
      else if (s.agent === "codex" && !s.cloud) p.loops = codex.loopsOf(s) || undefined;
      if (s.state !== "done") p.live = liveOf(state.sessions[s.id]);
      // What it has going between its turns, which makes it working.
      const going = s.state !== "done" && !s.asleep ? goingOf(state.sessions[s.id]) : null;
      if (going) p.going = going;
      // The workers its agent started, going or lately ended, each with how it's going and its last step.
      const workers = workersOf(state.sessions[s.id]);
      if (workers.length) p.workers = workers.map(({ agent, steps, ...w }) => w);
      // Its code blocks running now, with what they printed so far.
      const running = codeRuns.live(s.id);
      if (running) p.runs = running;
      // When agentbook next tries to pick up a turn an API error cut off (or did, until its next turn starts), or
      // "login": once you've signed in to Claude Code again.
      if (s.failed && cut.has(s.id)) p.pickup = cut.get(s.id).at || (s.failed.error === LOGIN ? "login" : undefined);
      out[`post:${s.id}`] = p;
    }
    // An agent is the agent on this machine: its skills, plugins, projects and models are this machine's.
    for (const a of v.agents) {
      const d = driverOfAgent(a.id);
      const x = { driver: d?.prefix || null };
      // The machine it runs on, when that isn't this one: OpenClaw's agents run on its gateway's.
      x.host = d?.machine?.() || null;
      if (d?.folders === false) x.folders = false; // its sessions work in the agent's own workspace
      if (d?.repos) x.repos = true; // or on a repo it clones where it runs (Claude Agent, Devin)
      x.models = d ? d.models(a.id) : a.kind === "claude-code" ? claudeModels() : null;
      x.routines = routinesOfAgent(a.id)?.routinesOf?.(a.id) || null; // what it does on a schedule (its routines, cron jobs, automations, loops)
      x.workspace = d?.workspaceOf?.(a.id) || null; // its own folder (an OpenClaw agent's), and when it last did something there
      // Whether agentbook can reach it now (OpenClaw's agents, through its gateway): when it can't, it's offline.
      x.link = d?.link?.() || null;
      if (x.link && x.link.state !== "connected") x.offline = true;
      out[`agent:${a.id}`] = x;
    }
    return out;
  }

  // The folders this machine knows: where its sessions ran, and the git checkouts beside those and in the clone
  // folder (~/dev/*), each with the repo it's a clone of, so a workspace finds its checkouts on every machine.
  // Folders sessions ran in carry their branches; the others only the branch they're on, and the composer asks
  // for the rest when it needs them.
  const SCAN_MS = 60e3;
  let scanned = { at: 0, list: [] };
  // Where temp folders go (tempDir), which aren't folders to offer as a workspace. By the real path, as Claude Code goes
  // by that, and /tmp and macOS's temp folders are behind links.
  const TEMP_DIRS = path.join(real(os.tmpdir()), "agentbook-temp-");
  const facts = new Map(); // root -> { at, remote, branch }: read from .git now and then, not on every view
  function gitFacts(root) {
    const c = facts.get(root);
    if (c && Date.now() - c.at < SCAN_MS) return c;
    const fresh = { at: Date.now(), remote: remoteOf(root), branch: currentBranch(root) };
    facts.set(root, fresh);
    return fresh;
  }
  function knownFolders(all, clones) {
    const home = os.homedir();
    const used = all.filter((f) => !f.root.startsWith(TEMP_DIRS));
    if (Date.now() - scanned.at > SCAN_MS) {
      const parents = new Set([clones]);
      for (const f of used) {
        const up = path.dirname(f.root);
        if (up === home || up.startsWith(home + path.sep)) parents.add(up);
      }
      scanned = { at: Date.now(), list: scanCheckouts([...parents]) };
    }
    const byRoot = new Map(used.map((f) => [f.root, f]));
    // A clone still going isn't a checkout yet, though its .git is there.
    const going = new Set([...cloning.values()].filter((c) => !c.error).map((c) => c.dir));
    for (const c of scanned.list) if (!byRoot.has(c.root) && !going.has(c.root)) byRoot.set(c.root, { root: c.root, name: path.basename(c.root), sessions: 0, live: 0, last: c.at });
    return [...byRoot.values()].map((f) => {
      const known = gitFacts(f.root);
      return { ...f, machine: MACHINE, ...(known.remote || {}), branch: known.branch, ...((f.sessions && branchesOf(f.root)) || {}), ...(f.sessions ? { wip: wipOf(f.root) } : {}) };
    });
  }

  // Where this machine clones a repo it has no checkout of: AGENTBOOK_CLONE_DIR, or the folder most of its
  // checkouts are in (~/dev), or ~/dev.
  function cloneDir() {
    if (process.env.AGENTBOOK_CLONE_DIR) return path.resolve(process.env.AGENTBOOK_CLONE_DIR);
    const home = os.homedir();
    const count = new Map();
    for (const root of new Set(Object.values(state.sessions).map((x) => x.root).filter(Boolean))) {
      const up = path.dirname(root);
      if (up.startsWith(home + path.sep) && fs.existsSync(path.join(root, ".git"))) count.set(up, (count.get(up) || 0) + 1);
    }
    return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] || path.join(home, "dev");
  }
  // A folder you chose to work in is trusted in Claude Code, as its trust prompt there would: a background session
  // won't start in a folder it hasn't trusted, and a new repo isn't covered by the folder it's in (see
  // claude-trust.mjs). That's the checkout of a repo agentbook clones for you, and a folder you add as a workspace
  // (`folder.trust`). Failing to only means its first start asks you to trust it. Not when this machine turned
  // folder.trust off, or wants to OK it here: then a start that needs it offers Trust and retry, through the gate.
  const trustHere = (dir) => {
    const g = gate.settings();
    if (g.commands["folder.trust"] === false || g.ask_here.includes("folder.trust")) return Promise.resolve();
    return trustFolder(dir).then(
      (was) => was && log(`trusted ${dir} in Claude Code`),
      (e) => log(`couldn't trust ${dir} in Claude Code: ${e.message}`),
    );
  };
  // The repos this machine is cloning, by repoKey: adding a workspace starts one, a post to it waits for the
  // same one, and the page shows it going, or why it failed (kept until it's tried again).
  const cloning = new Map(); // repo -> { repo, dir, promise, error }
  function cloneHere(url) {
    const repo = repoKey(url);
    const going = cloning.get(repo);
    if (going && !going.error) return going;
    const to = cloneTarget(cloneDir(), url);
    if (to.exists) {
      if (cloning.delete(repo)) pageChanged();
      return { repo, dir: to.dir, exists: true, promise: trustHere(to.dir).then(() => to.dir) };
    }
    const job = { repo, dir: to.dir, error: null };
    job.promise = clone(url, to.dir).then(
      async () => {
        cloning.delete(repo);
        scanned.at = 0;
        facts.delete(to.dir);
        log(`cloned ${url} into ${to.dir}`);
        pageChanged();
        await trustHere(to.dir);
        return to.dir;
      },
      (e) => {
        job.error = `Couldn't clone ${url}: ${e.message}`;
        log(job.error);
        pageChanged();
        throw new Error(job.error);
      },
    );
    job.promise.catch(() => {}); // a workspace's clone has nobody waiting on it
    cloning.set(repo, job);
    pageChanged();
    return job;
  }
  // A project's branches, for the composer: read in the background and kept a little while, since this view is
  // built on every change.
  const BRANCHES_MS = 15e3;
  const branchCache = new Map(); // root -> { at, data, reading }
  function branchesOf(root, fresh = false) {
    const c = branchCache.get(root) || { at: 0, data: undefined, reading: false };
    branchCache.set(root, c);
    if ((fresh || Date.now() - c.at > BRANCHES_MS) && !c.reading) {
      c.reading = true;
      branches(root)
        .catch(() => null)
        .then((data) => {
          const changed = JSON.stringify(data) !== JSON.stringify(c.data);
          Object.assign(c, { at: Date.now(), data, reading: false });
          if (changed) pageChanged();
        });
    }
    return c.data;
  }
  // A project's work in progress (see wip.mjs), the same way. Read again sooner when a post starts working on
  // another of its branches.
  const WIP_MS = 20e3;
  const wipCache = new Map(); // root -> { at, key, data, reading }
  function wipOf(root, fresh = false) {
    const posts = new Set(Object.values(state.sessions).filter((s) => s.root === root && !s.cloud && s.branch && s.branch !== "HEAD").map((s) => s.branch));
    const key = [...posts].sort().join("\n");
    const c = wipCache.get(root) || { at: 0, key: null, data: undefined, reading: false };
    wipCache.set(root, c);
    if ((fresh || c.key !== key || Date.now() - c.at > WIP_MS) && !c.reading) {
      c.reading = true;
      // Folders sessions work in now (a turn, or subagents and shells after it): their worktrees are read fresh.
      const working = Object.values(state.sessions)
        .filter((s) => s.cwd && !s.cloud && s.state !== "done" && (s.busy || s.state === "working" || (s.session_id && claude.backgroundWork(s.session_id))))
        .map((s) => s.cwd);
      listWip(root, posts, MACHINE, working)
        .catch(() => null)
        .then((data) => {
          const changed = JSON.stringify(data) !== JSON.stringify(c.data);
          Object.assign(c, { at: Date.now(), key, data, reading: false });
          if (changed) pageChanged();
        });
    }
    return c.data;
  }

  /* ---------- a post's pull requests, as its transcript and its agent name them ---------- */

  // The repo on GitHub a post's folder is a checkout of ("github.com/owner/name"), or null.
  function repoOfPost(s) {
    const remote = s?.root && gitFacts(s.root).remote?.remote;
    return remote && githubRepo(remote) ? remote : null;
  }
  // A post's pull requests as its transcript has them, with a "#12" in its folder's repo made a link (dropped when
  // the folder isn't a checkout of a repo on GitHub).
  function prsOfPost(s, prs) {
    const out = {};
    const r = Object.values(prs || {}).some((p) => !p.url) ? githubRepo(repoOfPost(s) || "") : null;
    for (const [k, p] of Object.entries(prs || {})) {
      if (p.url) out[k] = p;
      else if (r) out[prUrl(r.slug, p.number)] = { ...p, url: prUrl(r.slug, p.number), repo: r.slug };
    }
    return out;
  }
  // A link to a pull request from its agent (a result's or an attachment's) links it to the post.
  function agentLinked(post, url) {
    const pr = prOfUrl(url);
    if (pr && /\/pull\/\d+\/?(?:[#?].*)?$/.test(url)) commit({ t: "session.pr", post, url: prUrl(pr.repo, pr.number), number: pr.number, repo: pr.repo, how: "agent", at: new Date().toISOString() });
  }

  // A post's queue: messages of yours that wait for its turn to end, in order. The
  // next one goes in once the turn is over and nothing holds it: the queue isn't paused (Stop, an ended session, or
  // you), its agent isn't waiting on an answer from you, and nothing else of yours is on its way to it (that goes
  // first, and makes a turn of its own). It goes as any message does to an idle session: as its next prompt.
  const queueOf = (post) => state.messages.filter((m) => m.post === post && m.queued);
  // A question its agent asked you, not an OK a routine asks on its thread (server/main.mjs), which it doesn't wait on.
  const asksYou = (post) => state.questions.some((q) => q.post === post && !q.answered && q.kind !== "permission" && !q.hook && !q.routine);
  // Work it has going between its turns (a shell pushing or watching CI, a monitor, a subagent), which the page shows
  // as working: it hears back when that's done, in a turn of its own, and what you queue waits for that turn too. A
  // Claude Code session's as its saved state says now (goingOf's list is a refresh old, and the turn that ends it
  // can be shorter than that).
  const goingNow = (s) => !s.busy && !s.cloud && !s.asleep && (driverOf(s) ? !!goingOf(s) : claude.backgroundWork(s.session_id) > 0);
  function releaseNext(post) {
    const s = state.sessions[post];
    const [next] = queueOf(post);
    if (!next || !s || s.busy || s.state === "done" || s.queue_paused || asksYou(post) || goingNow(s)) return;
    if (store.pending(post).some((o) => o.event.type !== "permission")) return;
    commit({ t: "message.release", post, mid: next.id });
  }
  // One of them sent now: it goes at once, as Send now's do (an ended Claude Code session resumes with it), and the
  // queue goes on.
  function sendQueued(s, m) {
    if (s.queue_paused) commit({ t: "session.paused", post: s.id, paused: null });
    if (s.state === "done" && !driverOf(s) && !s.cloud) {
      const o = state.outbox.find((x) => x.post === s.id && x.mid === m.id);
      const note = o?.event.text?.startsWith(m.text) ? o.event.text.slice(m.text.length).trim() : "";
      commit({ t: "message.drop", post: s.id, mids: [m.id] });
      return resume(s, m.text, (m.files || []).map((f) => f.id), note || null);
    }
    setAside(s.id);
    commit({ t: "message.release", post: s.id, mid: m.id });
    return {};
  }

  // Send now, to a Claude Code session in the middle of a turn: its PostToolUse hook hands Claude what you sent at
  // its next step. That hook would run after every tool call of every session, so it starts only when a file named
  // for its Claude Code process says something of yours waits for it (hooks.json): one per busy session with a
  // message pending, or how a run of yours went, in ~/.agentbook/cli/steer.
  const STEER_DIR = path.join(CLI_HOME, "steer");
  const STEERS = new Set(["message.add", "message.release", "message.drop", "message.fail", "message.retry", "event.deliver", "outbox.ack", "session.status", "session.hello", "session.gone", "session.sleep"]);
  let steering = null; // the pids with a file there
  function syncSteer() {
    const want = new Set();
    for (const [proc, post] of Object.entries(state.procs)) {
      const s = state.sessions[post];
      const pid = /^[^:]+-(\d+)$/.exec(proc)?.[1];
      if (pid && s?.busy && !driverOf(s) && !s.cloud && store.pending(post).some((o) => (o.event.type === "message" && !o.event.command) || o.event.type === "run")) want.add(pid);
    }
    try {
      if (!steering) {
        fs.mkdirSync(STEER_DIR, { recursive: true });
        steering = new Set(fs.readdirSync(STEER_DIR));
      }
      for (const pid of steering) if (!want.has(pid)) fs.rmSync(path.join(STEER_DIR, pid), { force: true });
      for (const pid of want) if (!steering.has(pid)) fs.writeFileSync(path.join(STEER_DIR, pid), "");
      steering = want;
    } catch (e) {
      log(`steer: ${e.message}`);
    }
  }
  syncSteer(); // and away with what an earlier run left there

  // Sessions long-poll for events; wake them when something arrives.
  const waiters = new Map(); // post -> Set(resolve)
  function wake(post) {
    const set = waiters.get(post);
    if (!set) return;
    waiters.delete(post);
    for (const fn of set) fn();
  }

  store.onChange((op) => {
    pageChanged();
    for (const o of state.outbox) if (queued(o)) wake(o.post);
    if (op.t === "session.hello") waking.delete(state.procs[op.proc]);
    if (op.t !== "outbox.ack" && state.outbox.some(queued)) setTimeout(deliverQueued, 50);
    if (op.post && (op.t === "session.gone" || (op.t === "session.status" && op.turn))) wake(op.post);
    // A process moved to another post (/clear, resume): its delivery loop must re-poll for the new one.
    if (op.t === "session.hello") for (const key of [...waiters.keys()]) wake(key);
    if (op.t === "session.status" && op.turn === "end") {
      saveSnapshot(state.sessions[op.post], true);
      setTimeout(() => reportTurn(op.post).catch((e) => log(`changes ${op.post}: ${e.message}`)), 1500).unref();
      setTimeout(() => work.touch(op.post, { changes: true, now: true }), 1500).unref();
    }
    if (op.t === "session.hello") work.touch(state.procs[op.proc]);
    // A post that ended or fell asleep: all of its work, now that it's done. One a copy folded into: the copy's.
    if (op.t === "session.gone" || op.t === "session.sleep" || op.t === "session.fold") work.touch(op.post, { changes: true, now: true });
    // Its queue: the next one goes in once its turn is over (or what held it lets go), and one that ended holds it.
    const asked = op.t === "question.answer" ? state.questions.find((q) => q.id === op.qid)?.post : null;
    if (asked || (op.post && ["session.status", "session.paused", "message.drop"].includes(op.t))) setTimeout(() => releaseNext(asked || op.post), 0);
    if (op.t === "session.gone" && queueOf(op.post).length && !state.sessions[op.post]?.queue_paused) setTimeout(() => commit({ t: "session.paused", post: op.post, paused: "ended" }), 0);
    if (STEERS.has(op.t)) syncSteer();
    // A thread that said hello, ended or fell asleep: local_key may turn on now (keyOnWhenDone).
    if (op.t === "session.hello" || op.t === "session.gone" || op.t === "session.sleep") setTimeout(() => keyOnWhenDone(), 0);
  });

  // What the transcript says about a session goes into the log now and then, so it survives restarts.
  const SNAPSHOT_MS = Number(process.env.AGENTBOOK_SNAPSHOT_MS || 30e3);
  const snaps = {}; // post -> { json, at }
  const unsaved = new Set(); // posts whose latest snapshot waits for the throttle
  function saveSnapshot(s, now = false) {
    if (!s) return;
    const d = driverOf(s);
    if (!d) transcripts.digest(s);
    const snap = d ? d.summary(s) : transcripts.snapshot(s);
    if (!snap) return;
    if (snap.prs) snap.prs = prsOfPost(s, snap.prs);
    const json = JSON.stringify(snap);
    const last = snaps[s.id];
    if (last?.json === json) return unsaved.delete(s.id);
    if (!now && last && Date.now() - last.at < SNAPSHOT_MS) return unsaved.add(s.id);
    unsaved.delete(s.id);
    snaps[s.id] = { ...snaps[s.id], json, at: Date.now() };
    commit({ t: "session.snapshot", post: s.id, ...snap });
  }

  // The skills a session can use, logged only when they change.
  function saveSkills(s) {
    const skills = s && transcripts.skills(s);
    if (!skills) return;
    const json = JSON.stringify(skills);
    if (JSON.stringify(s.skills || null) === json) return;
    commit({ t: "session.skills", post: s.id, skills });
  }

  // What a slash command you sent printed, read from its transcript: on the thread as its
  // agent's reply, once (`ext`: the command's entry there). Its Markdown copy when it left one (/context's table), else
  // what it printed, as it printed it. Only the commands sent from here: what one typed in its terminal printed stays
  // there. What printed a moment ago may have its Markdown copy still to come (`ranWaiting`).
  const ranWaiting = new Set();
  const fenced = (t) => {
    const n = Math.max(3, ...[...t.matchAll(/`{3,}/g)].map((m) => m[0].length + 1));
    return `${"`".repeat(n)}text\n${t}\n${"`".repeat(n)}`;
  };
  function saveRan(s) {
    if (!s) return;
    ranWaiting.delete(s.id);
    for (const r of transcripts.ran(s)) {
      const said = conversationOf(state, s.id);
      if (r.out == null || said.some((m) => m.ext === `cmd:${r.id}`)) continue;
      if (!r.md && Date.now() - Date.parse(r.outAt) < 1500) {
        ranWaiting.add(s.id);
        continue;
      }
      // The one you sent it with: the latest of yours that ran it, before it ran, and not answered already.
      const sent = said.findLast((m) => m.from === "human" && m.command === r.name && !m.queued && Date.parse(m.at) <= Date.parse(r.at) + 5e3);
      if (!sent || Date.parse(r.at) - Date.parse(sent.at) > 10 * 60e3) continue;
      if (said.some((m) => m.from === "agent" && m.command === r.name && m.at >= sent.at)) continue;
      const text = r.md || (r.out ? fenced(r.out) : "");
      if (!text) continue;
      commit({ t: "message.add", post: s.id, from: "agent", via: "dash", text, command: r.name, ext: `cmd:${r.id}`, when: r.outAt || r.at });
      if (commanded.get(s.id)?.name === r.name) commanded.delete(s.id);
    }
  }

  // Where a session works, kept current: Claude Code notes the session's folder on every transcript line, and
  // the agent may move to another checkout (EnterWorktree, a cd that sticks) or switch branch where it is. The
  // post says which checkout and branch; moving between folders of one checkout isn't news.
  function saveWhere(s) {
    const dir = s && transcripts.digest(s)?.cwd;
    const at = dir && placeOf(dir);
    if (!at) return;
    const was = s.cwd ? placeOf(s.cwd) : null;
    const where = {};
    if (was?.top !== at.top) {
      where.cwd = at.top;
      if (was?.root !== at.root) Object.assign(where, { root: at.root, repo: at.repo });
    }
    if (at.branch !== s.branch) where.branch = at.branch;
    if (Object.keys(where).length) commit({ t: "session.where", post: s.id, ...where });
  }

  // Follow running sessions' transcripts once a second.
  setInterval(() => {
    if (!started) return;
    const recent = Date.now() - 300e3;
    // One that ended or fell asleep stops writing its transcript: follow it a few minutes more.
    const quiet = (s) => (s.state === "done" ? s.ended : s.slept);
    const following = Object.values(state.sessions).filter((s) => !driverOf(s) && !s.cloud && ((s.state !== "done" && !s.asleep) || Date.parse(quiet(s)) > recent));
    const changed = transcripts.poll(following);
    for (const key of new Set([...changed, ...unsaved])) saveSnapshot(state.sessions[key]);
    for (const key of changed) saveSkills(state.sessions[key]);
    for (const key of new Set([...changed, ...ranWaiting])) saveRan(state.sessions[key]);
    for (const key of changed) saveWhere(state.sessions[key]);
    for (const key of changed) saveInterrupt(state.sessions[key]);
    // Its work goes up as it happens, what it changed every few seconds while it works.
    for (const key of changed) work.touch(key, { changes: Date.now() - (changesSent.get(key) || 0) > 10e3 && !!changesSent.set(key, Date.now()) });
    if (changed.length) pageChanged();
  }, 1000).unref();

  // Questions with a deadline and a default answer themselves when time runs out.
  setInterval(() => {
    const now = Date.now();
    for (const q of state.questions) {
      if (q.answered || !q.until || Date.parse(q.until) > now) continue;
      if (q.default != null && q.default !== "") commit({ t: "question.answer", qid: q.id, value: q.default, by: "default" });
    }
  }, 15000).unref();

  /* ---------- background sessions ---------- */

  // What Claude Code's supervisor says about its sessions, every few seconds while anything could change.
  // A background session whose process stopped without saying so (Claude Code retired it, or it was stopped
  // elsewhere) is asleep; one that crashed ends its post.
  const waking = new Map(); // post -> when agentbook started waking it
  const commanded = new Map(); // post -> the slash command agentbook last woke it with: { name, bare, at }
  const sleeping = new Map(); // post -> why agentbook is putting it to sleep
  const resumes = new Set(); // launches resuming an ended thread, until it's back or they failed
  async function syncRuntime() {
    const changed = await claude.refresh();
    // Claude Code is an agent here once its supervisor answers, before it has a thread: a machine that never ran a
    // session with agentbook's hooks has one to start a thread with (else Add agents says
    // Claude Code is "Ready", with no agent anywhere to start one with). One of any name will do.
    if (claude.listedAt() && !Object.values(state.agents).some((a) => a.kind === "claude-code")) commit({ t: "agent.hello", agent: "claude", agent_name: "Claude", kind: "claude-code" });
    // Each Claude Code agent here says the version of Claude Code it runs on, on its page.
    const v = claude.version();
    for (const a of Object.values(state.agents)) if (v && a.kind === "claude-code" && a.version !== v) commit({ t: "agent.hello", agent: a.id, version: v });
    closePanels();
    settlePrompts();
    for (const s of Object.values(state.sessions)) {
      if (s.state === "done" || s.asleep || driverOf(s) || s.cloud || waking.has(s.id)) continue;
      const a = claude.info(s.session_id);
      if (a?.kind !== "background" || claude.running(a)) continue;
      if (a.state === "failed") commit({ t: "session.gone", post: s.id, reason: "Failed" });
      else asleep(s.id);
    }
    // An ended thread you wrote on, whose resume Claude Code gave up on: it says why, instead of "Resuming it" and
    // then nothing.
    for (const lid of resumes) {
      const l = state.launches[lid];
      const s = l && state.sessions[l.post];
      const a = s && claude.info(s.session_id);
      if (!s || l.error || l.arrived || s.launch === lid || Date.now() - Date.parse(l.at) > 600e3) resumes.delete(lid);
      else if (a?.kind === "background" && a.state === "failed" && a.startedAt >= Date.parse(l.at) - 5e3) {
        resumes.delete(lid);
        commit({ t: "launch.fail", lid, error: claude.failure(a.id) || "Claude Code couldn't resume it." });
      }
    }
    await sleepIdle();
    if (changed) pageChanged();
  }

  // A prompt on Claude Code's own screen ends without a hook: you answered it there, or, in auto mode, it timed out after
  // 2 minutes and Claude Code denied the command and went on. Only the turn's end or a message reset the thread, so it
  // said "It's waiting in its terminal" with nothing waiting (once for 8 minutes). Claude Code lists a session
  // as waiting for as long as a dialog is up, so the list says when it's over. Only a list asked for after the prompt was
  // heard of speaks for it: not one that was on its way, nor the old one kept when an ask fails. What's open on agentbook
  // ends with its answer.
  function settlePrompts() {
    const asked = claude.listAsked();
    for (const s of Object.values(state.sessions)) {
      if (s.state !== "waiting" || driverOf(s) || s.cloud || Date.parse(s.updated) >= asked) continue;
      if (state.questions.some((q) => q.post === s.id && !q.answered)) continue;
      const a = claude.info(s.session_id);
      if (claude.running(a) && ["busy", "idle"].includes(a.status)) commit({ t: "session.status", post: s.id, state: s.busy ? "working" : "idle", text: s.busy ? "Carrying on" : undefined });
    }
  }

  // A slash command that opened a panel (a picker, a dialog) waits on someone at a terminal, which a background session
  // has none of: agentbook closes it (Esc, as `interrupt` presses it), says so on the thread, and remembers it on this
  // machine, so the / list asks for what it takes next time, or leaves it out (learnCommand).
  function closePanels() {
    for (const [post, c] of commanded) {
      const s = state.sessions[post];
      if (!s || Date.now() - c.at > 120e3) {
        commanded.delete(post);
        continue;
      }
      const a = claude.info(s.session_id);
      if (!a || !claude.running(a) || a.status !== "waiting" || !/dialog|input/i.test(a.waitingFor || "")) continue;
      commanded.delete(post);
      try {
        learnCommand(c.name, { bare: c.bare });
      } catch (e) {
        log(`couldn't note that /${c.name} opens a panel: ${e.message}`);
      }
      claude.interrupt(s.session_id).catch((e) => log(`couldn't close the panel /${c.name} opened on ${s.label}: ${e.message}`));
      const how = c.bare ? ` Send it with what it takes after it, or open it in a terminal: \`claude attach ${a.id}\`.` : ` Open it in a terminal to use it: \`claude attach ${a.id}\`.`;
      commit({ t: "message.add", post, from: "agent", via: "dash", text: `agentbook closed the panel /${c.name} opened: it shows only in a terminal.${how}` });
    }
  }

  // Background sessions sleep when nothing needs them: Claude Code ends the process and keeps the conversation,
  // and writing to the post wakes it. One sleeps after SLEEP_AFTER without a turn, and while more than MAX_AWAKE
  // run, the longest idle sleep early (after a short grace, in case you answer it). Never one that's working,
  // waiting on you, or has work of its own going (a background shell, a monitor, a scheduled wakeup).
  const SLEEP_AFTER_MS = Number(process.env.AGENTBOOK_SLEEP_AFTER_MIN ?? 30) * 60e3;
  const MAX_AWAKE = Number(process.env.AGENTBOOK_MAX_AWAKE ?? 6);
  const SLEEP_GRACE_MS = Number(process.env.AGENTBOOK_SLEEP_GRACE_SEC ?? 120) * 1e3;
  const idleSince = (s) => Date.parse(s.turn_ended || s.updated || s.started) || 0;
  const span = (ms) => (ms >= 90 * 60e3 ? `${Math.round(ms / 3600e3)} hours` : ms >= 90e3 ? `${Math.round(ms / 60e3)} minutes` : "a minute");
  async function sleepIdle() {
    const awake = Object.values(state.sessions).filter((s) => s.state !== "done" && !s.asleep && !sleeping.has(s.id) && !driverOf(s) && !s.cloud && claude.background(s.session_id) && claude.running(claude.info(s.session_id)));
    const idle = awake
      .filter((s) => !s.busy && s.state === "idle" && !["busy", "waiting"].includes(claude.info(s.session_id).status) && !waking.has(s.id) && !store.pending(s.id).length && !claude.backgroundWork(s.session_id))
      .sort((a, b) => idleSince(a) - idleSince(b));
    let over = MAX_AWAKE > 0 ? awake.length - MAX_AWAKE : 0;
    for (const s of idle) {
      const quiet = Date.now() - idleSince(s);
      const why = SLEEP_AFTER_MS > 0 && quiet >= SLEEP_AFTER_MS ? `Idle for ${span(quiet)}` : over > 0 && quiet >= SLEEP_GRACE_MS ? `More than ${MAX_AWAKE} threads were running` : null;
      if (!why) continue;
      over--;
      await putToSleep(s, why).catch((e) => log(`couldn't put ${s.label} to sleep: ${e.message}`));
    }
  }
  // Its process ended, through agentbook or not (the policy, the SessionEnd hook and the next sync each notice):
  // the post says so once, with why.
  function asleep(post) {
    const s = state.sessions[post];
    if (s && !s.asleep && s.state !== "done") commit({ t: "session.sleep", post, reason: sleeping.get(post) || "Claude Code stopped it" });
  }
  async function putToSleep(s, why) {
    sleeping.set(s.id, why);
    try {
      await claude.stop(s.session_id);
      asleep(s.id);
    } finally {
      sleeping.delete(s.id);
    }
  }
  // `claude agents` is a whole Claude Code starting and ending, so it runs often only while something here depends
  // on its answer: an awake background thread, which has no terminal and whose ending no hook reports, a launch or a
  // resume on its way, a panel to close, a session just heard of. A thread in a terminal reports through its hooks,
  // so an open page is no reason. Otherwise now and then, to see Claude Code update itself.
  const RUNTIME_MS = Number(process.env.AGENTBOOK_RUNTIME_MS || 4000);
  const RUNTIME_IDLE_MS = Number(process.env.AGENTBOOK_RUNTIME_IDLE_MS || 600e3);
  let lastSync = 0;
  let ticked = Date.now();
  let listUntil = 0; // a session just said hello that the last listing didn't have: which kind it is, soon
  const listSoon = () => (listUntil = Date.now() + 3 * RUNTIME_MS);
  const listingNeeded = () =>
    Date.now() < listUntil ||
    resumes.size > 0 ||
    commanded.size > 0 ||
    waking.size > 0 ||
    Object.values(state.launches).some((l) => !l.arrived && !l.error && state.agents[l.agent]?.kind === "claude-code" && Date.now() - Date.parse(l.at) < 600e3) ||
    Object.values(state.sessions).some((s) => s.state !== "done" && !s.asleep && claude.background(s.session_id));
  setInterval(() => {
    if (!started) return;
    // This machine slept (its clock jumped past what this timer saw, which stands still meanwhile): pick up what
    // an API error cut off then.
    if (Date.now() - ticked > 60e3) pickUpAll();
    ticked = Date.now();
    if (Date.now() - lastSync < (listingNeeded() ? RUNTIME_MS : RUNTIME_IDLE_MS)) return;
    lastSync = Date.now();
    syncRuntime().catch(() => {});
  }, Math.min(1000, RUNTIME_MS)).unref();

  // What you send a background session waits in its outbox. A busy one takes it at the end of its turn (the
  // Stop hook); an idle one has no turn to end, so agentbook wakes it: Claude Code stops it and resumes it
  // with what you sent as its next prompt (one that's asleep only resumes). Codex posts hand theirs to Codex.
  function promptFor(events) {
    const es = events.map((o) => o.event);
    if (es.length === 1 && es[0].type === "message") return `${es[0].text || ""}${attached(es[0].files)}`.trim();
    return `From agentbook:\n${es.map((e) => `- ${describe(e)}`).join("\n")}`;
  }

  // What couldn't reach a post's session (`events`, from its outbox; `why`: "couldn't reach OpenClaw: …"). Your
  // messages stay on the post, saying so, for you to send again or delete; anything else (an answer, a file) goes,
  // and the post says it didn't get there.
  function undelivered(post, events, why) {
    const said = conversationOf(state, post);
    const kept = events.filter((o) => o.event.type === "message" && o.mid && said.some((m) => m.id === o.mid));
    const rest = events.filter((o) => !kept.includes(o));
    if (kept.length) commit({ t: "message.fail", post, mids: kept.map((o) => o.mid), error: why });
    if (!rest.length) return;
    commit({ t: "outbox.ack", oids: rest.map((o) => o.oid) });
    commit({ t: "message.add", post, from: "agent", via: "dash", text: `agentbook ${why}` });
  }

  // What resuming it did: the model you picked switched to (or why not), and a copy Claude Code started instead of
  // resuming it (a new session with its conversation in it, and what you sent): the thread goes on in the copy, so
  // what it says is said here (session.fold). Rare now that a resume waits for a stopped session's process to be
  // gone, but Claude Code copies one it has open elsewhere, or one resumed with options of its own, all the same.
  function resumed(s, r) {
    if (r?.copy && r.id && !String(s.session_id || "").startsWith(r.id)) {
      commit({ t: "session.fold", post: s.id, copy: r.id, follow: true });
      log(`${s.label}: Claude Code started a copy (${r.id}), which goes on as the same thread`);
    }
    switched(s, r);
  }
  // A model picked for a Claude Code session switches when agentbook next wakes or resumes it.
  function switched(s, r) {
    if (!s.model_pick) return;
    if (r.modelError) commit({ t: "message.add", post: s.id, from: "agent", via: "dash", text: `agentbook couldn't switch this session to ${s.model_pick}, so it carries on with its model: ${r.modelError}` });
    commit({ t: "session.model", post: s.id, model: null });
  }

  // A session resumed with what you wrote, whose first prompt hasn't come yet: it's starting, not idle, and what
  // you send meanwhile goes with that prompt (its hook takes it), rather than resuming it again.
  // One woken with a slash command has no prompt to wait for (one that prints starts no turn): it's up once it says hello.
  const commandLaunches = new Set();
  const starting = (s) => Object.values(state.launches).some((l) => l.resume && l.post === s.id && !l.error && !l.mirrored && !commandLaunches.has(l.id) && Date.now() - Date.parse(l.at) < RESUME_WAIT_MS);
  async function wakeIdle(s) {
    if (s.state === "done" || s.busy || s.state === "waiting" || waking.has(s.id) || sleeping.has(s.id) || holdMs(s.id) > 0 || starting(s)) return;
    if (!s.asleep && !claude.running(claude.info(s.session_id))) return;
    const pending = store.pending(s.id).filter((o) => o.event.type !== "permission");
    if (!pending.length) return;
    // A slash command goes alone, as typed, as its prompt (what's before it goes first, what's after it next time).
    const at = pending.findIndex((o) => o.event.type === "message" && o.event.command);
    const events = at === 0 ? pending.slice(0, 1) : at > 0 ? pending.slice(0, at) : pending;
    const command = at === 0 ? events[0].event : null;
    waking.set(s.id, Date.now());
    const news = command ? null : await groupNews(s.id).catch(() => null);
    const prompt = command ? command.text : [promptFor(events), news].filter(Boolean).join("\n\n");
    const lid = launchId();
    const cwd = resumeDir(s);
    if (command) commandLaunches.add(lid);
    commit({ t: "launch.add", lid, agent: s.agent, root: cwd, prompt, post: s.id, resume: true });
    try {
      resumed(s, await claude.resume({ sessionId: s.session_id, cwd, prompt, lid, label: s.label, model: s.model_pick, dirs: extraDirs(s) }));
      commit({ t: "outbox.ack", oids: events.map((o) => o.oid) });
      if (command) commanded.set(s.id, { name: command.command, bare: command.text.trim() === `/${command.command}`, at: Date.now() });
    } catch (e) {
      waking.delete(s.id);
      commit({ t: "launch.fail", lid, error: e.message });
      undelivered(s.id, events, `couldn't wake this session: ${e.message}`);
    }
  }

  // A Claude Code cloud session takes what you send through `claude -p … --cloud <id>`.
  const sending = new Set();
  async function sendToCloud(s) {
    if (sending.has(s.id)) return;
    const events = store.pending(s.id).filter((o) => o.event.type !== "permission");
    if (!events.length) return;
    sending.add(s.id);
    try {
      await cloud.send(s.session_id, promptFor(events));
      commit({ t: "outbox.ack", oids: events.map((o) => o.oid) });
    } catch (e) {
      undelivered(s.id, events, `couldn't send that to the cloud session: ${e.message}`);
    } finally {
      sending.delete(s.id);
    }
  }

  function deliverQueued() {
    for (const [post, since] of waking) if (Date.now() - since > 90e3) waking.delete(post);
    const posts = new Set(state.outbox.filter(queued).map((o) => o.post));
    for (const id of posts) {
      const s = state.sessions[id];
      if (!s) continue;
      if (driverOf(s)) driverOf(s).deliver(id);
      else if (s.cloud === "claude") sendToCloud(s);
      else if (s.asleep || claude.background(s.session_id)) wakeIdle(s);
    }
  }
  setInterval(() => started && deliverQueued(), 2000).unref();

  // A background session whose turn an API error cut off (the network dropped, the computer slept mid-reply, the API
  // was overloaded: its StopFailure hook says which) is picked up again once Claude's API answers: agentbook resumes
  // it, telling it so, as it would with a message from you. It tries a while after the error, then less and less
  // often, and again when this machine wakes up or agentbook-cli starts. One its expired login cut off is picked up
  // once you've signed in again (loginBack). A turn that ends on its own, or a message from you, settles it; one that
  // fails again after MAX_PICKUPS resumes is left for you. Not an archived one, nor other errors (a usage limit, a
  // refused request): those need you (store.mjs), and writing to the thread picks them up, as Retry on it does
  // (post.pickup) with any error.
  const LOGIN = "authentication_failed";
  const PICKUP_SEC = String(process.env.AGENTBOOK_PICKUP_SEC || "20,60,300,900,1800,3600").split(",").map(Number).filter((n) => n >= 0);
  const MAX_PICKUPS = 3;
  const cut = new Map(); // post -> { step, pickups, timer, at }: the next wait in PICKUP_SEC, resumes so far, the next try
  const resumable = (s) => !!s?.failed && s.state !== "done" && !s.busy && s.state !== "waiting" && !driverOf(s) && !s.cloud && (s.asleep ? s.sleep_reason !== "Archived" : claude.background(s.session_id));
  const pickable = (s) => resumable(s) && (PASSING_ERRORS.has(s.failed.error) || s.failed.error === LOGIN);
  function pickUpIn(post, c, sec) {
    c.at = new Date(Date.now() + sec * 1e3).toISOString();
    c.timer = setTimeout(() => pickUp(post).catch((e) => log(`picking up ${post}: ${e.message}`)), sec * 1e3).unref();
  }
  // Try it after the next wait; `fresh` starts the waits over (this machine woke up, agentbook-cli started).
  function cutOff(post, fresh = false) {
    const c = cut.get(post) || { step: 0, pickups: 0 };
    if (fresh) c.step = 0;
    else if (c.timer) return;
    clearTimeout(c.timer);
    Object.assign(c, { timer: null, at: null });
    cut.set(post, c);
    const sec = PICKUP_SEC[c.step];
    // An expired login doesn't pass with time: it waits for you to sign in again.
    if (state.sessions[post].failed.error === LOGIN) loginWatch();
    else if (sec != null && c.pickups < MAX_PICKUPS) {
      c.step++;
      pickUpIn(post, c, sec);
    }
    pageChanged();
  }
  function dropCut(post) {
    if (!cut.has(post)) return;
    clearTimeout(cut.get(post).timer);
    cut.delete(post);
    loginWatch();
    pageChanged();
  }
  // You've signed in to Claude Code again (a session's turn got a reply, or its stored login changed, at `at`): every
  // thread an expired login cut off before then is picked up, a couple of seconds apart.
  function loginBack(at = Date.now()) {
    let n = 0;
    for (const [post, c] of cut) {
      const s = state.sessions[post];
      if (s?.failed?.error !== LOGIN || c.timer || c.pickups >= MAX_PICKUPS || Date.parse(s.failed.at) >= at) continue;
      pickUpIn(post, c, 2 * n++);
    }
    if (n) {
      log(`Claude Code is signed in again: picking up ${n} thread${n === 1 ? "" : "s"} an expired login cut off`);
      pageChanged();
    }
  }
  // While a thread waits for you to sign in, where Claude Code keeps its login is watched, and a change there picks
  // it up.
  let loginWatcher = null;
  const loginChanged = () =>
    loginChangedAt()
      .then((at) => at && loginBack(at))
      .catch(() => {});
  // Claude Code signed in again from a thread's Login expired card (claude-signin.mjs): once it has, every thread an
  // expired login cut off is picked up, as when its login changes by itself.
  const signin = createSignin({ bin: () => process.env.AGENTBOOK_CLAUDE || "claude", env: (extra) => cleanEnv(extra), log, signedIn: () => loginBack(Date.now()) });
  function loginWatch() {
    const waits = [...cut.keys()].some((post) => state.sessions[post]?.failed?.error === LOGIN);
    if (waits && !loginWatcher) loginWatcher = watchLogin(loginChanged);
    else if (!waits && loginWatcher) {
      loginWatcher.close();
      loginWatcher = null;
    }
  }
  // Whether Claude's API answers from here (any answer at all): until it does, a resume would fail the same way.
  async function apiAnswers() {
    try {
      await fetch(process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com", { method: "HEAD", signal: AbortSignal.timeout(8000) });
      return true;
    } catch {
      return false;
    }
  }
  async function pickUp(post) {
    const s = state.sessions[post];
    const c = cut.get(post);
    if (!c || !pickable(s)) return dropCut(post);
    Object.assign(c, { timer: null, at: null });
    // What you sent picks it up anyway (deliverQueued wakes it with that).
    if (store.pending(post).some((o) => o.event.type !== "permission")) return dropCut(post);
    const expired = s.failed.error === LOGIN;
    // Being woken already (with a message from you), it's looked at again in a while: its turn starting settles it.
    if (expired && (waking.has(post) || sleeping.has(post) || starting(s))) return pickUpIn(post, c, 20);
    if (waking.has(post) || sleeping.has(post) || starting(s) || (!expired && !(await apiAnswers()))) return cutOff(post, false);
    if (waking.has(post)) return; // Retry picked it up meanwhile
    c.pickups++;
    const prompt = expired
      ? `agentbook: Claude Code's login expired and cut your last turn off (${s.failed.text || s.failed.error}). You're signed in again, so carry on where you left off.`
      : `agentbook: an API error cut your last turn off (${s.failed.text || s.failed.error}). Claude's API answers again, so carry on where you left off.`;
    await carryOn(s, c, prompt).catch(() => cutOff(post, false));
  }
  // Resume it, told why. Its turn starting says it's no longer cut off.
  async function carryOn(s, c, prompt) {
    const post = s.id;
    waking.set(post, Date.now());
    const lid = launchId();
    const cwd = resumeDir(s);
    commit({ t: "launch.add", lid, agent: s.agent, root: cwd, prompt, post, resume: true });
    try {
      resumed(s, await claude.resume({ sessionId: s.session_id, cwd, prompt, lid, label: s.label, model: s.model_pick, dirs: extraDirs(s) }));
      log(`picked up ${s.label} after an API error (${s.failed.error})`);
      c.at = new Date().toISOString(); // now: its turn starting says it's no longer cut off
      pageChanged();
    } catch (e) {
      waking.delete(post);
      commit({ t: "launch.fail", lid, error: e.message });
      log(`couldn't pick up ${s.label}: ${e.message}`);
      throw e;
    }
  }
  // Every thread an API error cut off, tried again from the first wait: when agentbook-cli starts, and when this
  // machine wakes up (see the runtime timer above). One an expired login cut off is picked up now if you've signed
  // in since.
  function pickUpAll() {
    for (const s of Object.values(state.sessions)) if (pickable(s)) cutOff(s.id, true);
    if (loginWatcher) loginChanged();
  }

  /* ---------- routes: this machine's sessions ---------- */

  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, "(?<$1>[^/]+)")}$`), handler });

  // Hooks and the MCP server address their session by Claude Code process; the server knows its post. An
  // agent agentbook runs through a driver is told its post (`codex:<thread>`), or the launch that starts it
  // (`launch:<lid>`) when its post isn't known yet.
  const postKeyOf = (proc) => (String(proc).startsWith("launch:") ? state.launches[String(proc).slice(7)]?.post : state.procs[proc]) || null;
  function postOf(res, proc) {
    if (!started) {
      fail(res, 409, NOT_LOGGED_IN, { code: "login" });
      return null;
    }
    const key = postKeyOf(proc);
    if ((!key || !state.sessions[key]) && keptOff.has(proc)) {
      fail(res, 404, KEPT_OFF, { code: "private" });
      return null;
    }
    if (!key || !state.sessions[key]) {
      fail(res, 404, "This session isn't registered with agentbook yet.", { code: "unregistered" });
      return null;
    }
    return key;
  }
  // A post this request may see ("see"), see the work of ("work"), or act on as its owner ("own"):
  // its key, or a 404 (not visible) or 403 (visible, not theirs) sent.
  // Its version and pid: a session's hook started on a newer plugin stops it and starts that one (ensureCli). Anyone
  // here may ask whether it's there and which version it is; with its server elsewhere, where its folder is, its pid,
  // its name and how far its log is go only to a caller with the key. With its server here, every route takes anyone
  // here, so its health says it all, as before.
  route("GET", "/api/health", (req, res) => ok(res, { ok: true, name: "agentbook", cli: true, version: VERSION, ...(!hosted() || localKeyOk(req) ? { home: HOME, seq: state.seq, machine: MACHINE, pid: process.pid } : {}) }));
  // What only agentbook-cli on this machine may do through these routes (OK a command, pair OpenClaw) needs the key
  // in its folder (cli/local.key, this user's alone): other local processes reach loopback too, a routine's code
  // among them, and it can't read that file.
  const localKey = (() => {
    const file = path.join(HOME, "cli", "local.key");
    try {
      return fs.readFileSync(file, "utf8").trim();
    } catch {
      const key = crypto.randomBytes(24).toString("base64url");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, key + "\n", { mode: 0o600 });
      return key;
    }
  })();
  const same = (got, want) => {
    const a = Buffer.from(String(got || ""));
    const b = Buffer.from(want);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  // A call signed with the key (shared/local-auth.mjs), as this version's hooks, tools and commands make them, so the
  // key itself never goes to whatever holds this port while agentbook-cli is down: taken once, within its minute.
  // -> { nonce } or null. The key as it is still works, from what's older (agentbook-cli's commands sent it).
  const taken = new Map(); // nonce -> when it was taken, oldest first
  function signedBy(auth, method, target, body) {
    const now = Date.now();
    const r = checkRequest(localKey, auth, method, target, body, now);
    if (!r) return null;
    for (const [n, at] of taken) {
      if (now - at <= 2 * AUTH_WINDOW_MS) break;
      taken.delete(n);
    }
    if (taken.has(r.nonce)) return null;
    taken.set(r.nonce, now);
    return r;
  }
  const localKeyOk = (req) => !!req.signed || same(req.headers["x-agentbook-key"], localKey);
  // With its server elsewhere, the key is also what stops what can't read that file from acting as a thread here: a
  // routine's code, which reaches loopback, and with it ab_file for a file it can't read, or a hello that shares a
  // folder; another person's process, on a machine they share. A machine that's its own server changes in nothing.
  // agentbook-cli's commands always show it, so those routes ask for it. The routes agents use ask too, unless this
  // machine has threads from before this (gate.json's local_key): their hooks and MCP servers are older and send none,
  // and they keep working. It doesn't stop a process of this person's own, which can read the file.
  const CLI_ROUTES = /^\/api\/(?:gate(?:\/approve)?|status|local\/.+)$/;
  const keyed = () => hosted() && gate.settings().local_key === true;
  // What goes in the address of an MCP server for what takes only an address (Codex, dsh, Hermes's HTTP): good for
  // that thread's tools and nothing else, so an address that ends up in a config or a log isn't the key.
  const mcpKey = (who) => crypto.createHmac("sha256", localKey).update(`mcp:${who}`).digest("base64url").slice(0, 32);
  const mcpKeyOk = (url) => url.pathname === "/api/mcp" && same(url.searchParams.get("key"), mcpKey(url.searchParams.get("proc") || `agent:${url.searchParams.get("agent")}`));
  function keyRefused(req, url) {
    if (!hosted() || url.pathname === "/api/health") return false;
    if (!CLI_ROUTES.test(url.pathname) && !keyed()) return false;
    return !localKeyOk(req) && !mcpKeyOk(url);
  }
  // A machine with threads from before signed calls starts with local_key off, and turns it on by itself once no
  // live thread is one that calls without the key: none of those that were live when this started and haven't
  // called with it since (`before`), and none that called without it since (`keyless`), nor a dsh plugin's line
  // opened unsigned. It's judged at what tells: a thread's hello or call, one ending or falling asleep, such a line
  // closing, and the start. With its server on this machine, or `local_key_auto: false` in gate.json, it stays.
  const before = new Set();
  const keyless = new Set();
  const keylessLines = new Set();
  const keyWaits = () => hosted() && gate.settings().local_key === false && gate.settings().local_key_auto !== false;
  function heard(proc, withKey) {
    if (!proc || !keyWaits()) return;
    if (!withKey) return void keyless.add(proc);
    if (before.delete(proc)) keyOnWhenDone();
  }
  // -> the threads it still waits for, by their names (none once it's on).
  function keyWaitsFor() {
    if (!keyWaits()) return [];
    for (const set of [before, keyless]) for (const p of set) if (!state.procs[p]) set.delete(p);
    return [...new Set([...before, ...keyless])].map((p) => state.sessions[state.procs[p]]?.label || p);
  }
  function keyOnWhenDone() {
    if (!keyWaits() || keyWaitsFor().length || keylessLines.size) return;
    gate.agree({ local_key: true, local_key_since: new Date().toISOString() });
    log("gate: no thread here reaches agentbook-cli without its key any more, so every caller needs it now (local_key turned on by itself)");
  }
  // What a call says it's for: /api/procs/<proc>/…, or an MCP address for one thread.
  const procOfCall = (url) => {
    const m = /^\/api\/procs\/([^/]+)/.exec(url.pathname);
    if (m) {
      try {
        return decodeURIComponent(m[1]);
      } catch {
        return m[1];
      }
    }
    return url.pathname === "/api/mcp" ? url.searchParams.get("proc") : null;
  };
  // That a newer agentbook-cli is out, for a session and for status, in this machine's words: its server only says a
  // number (setLatest), so it can't put words of its own in front of an agent. How to update is how it got here.
  const updateNote = () => {
    if (!latest || !VERSION || !olderVersion(VERSION, latest)) return {};
    const how = installedByClaude() ? "claude plugin marketplace update agentbook && claude plugin update agentbook@agentbook" : `git -C "${path.dirname(PLUGIN_ROOT)}" pull, then agentbook-cli down and agentbook-cli up`;
    return { update: `agentbook-cli ${latest} is out, and this machine has ${VERSION}. To update: ${how}` };
  };
  // How the daemon is doing, for agentbook-cli status: its server, whether it's reachable, what's waiting to go up.
  route("GET", "/api/status", (req, res) => ok(res, { machine: MACHINE, pid: process.pid, server: serverUrl, ...(uplink ? uplink.status() : { connected: false }), ...(store.saveFailing() ? { save_failing: store.saveFailing() } : {}), ...(faults?.last() ? { fault: faults.last() } : {}), ...updateNote(), drivers: Object.fromEntries(drivers.map((d) => [d.prefix, d.status()])) }));
  // The gate, for agentbook-cli on this machine: its settings, the folders it shares, what waits for an OK here,
  // and the OK (or not).
  route("GET", "/api/gate", (req, res) => ok(res, { settings: gate.settings(), shared: gate.readable(), waiting: gate.waiting(), owner: owner?.username || null, keyed: hosted() ? keyed() : null, key_waits: keyWaits() ? { threads: keyWaitsFor(), lines: keylessLines.size } : null }));
  route("POST", "/api/gate/approve", async (req, res) => {
    if (!localKeyOk(req)) return fail(res, 403, "Only agentbook-cli on this machine OKs a command.");
    const b = await readBody(req);
    if (!gate.approve(String(b.cid || ""), b.yes !== false)) return fail(res, 404, "Nothing waits for an OK by that id.");
    ok(res);
  });
  // Pairing with an OpenClaw gateway from this machine (agentbook-cli openclaw), so its setup code or token never
  // passes through the server.
  route("GET", "/api/local/openclaw", (req, res) => ok(res, openclaw.connection()));
  route("POST", "/api/local/openclaw/pair", async (req, res) => {
    if (!localKeyOk(req)) return fail(res, 403, "Only agentbook-cli on this machine pairs it.");
    const r = await commands["openclaw.pair"](await readBody(req));
    if (r?.error) return fail(res, r.status || 400, r.error);
    ok(res, { connection: openclaw.connection() });
  });
  // The same from this machine (agentbook-cli remote), so a key never passes through the server.
  route("GET", "/api/local/remote", async (req, res) => ok(res, await reads["read.remote"]({})));
  route("POST", "/api/local/remote", async (req, res) => {
    if (!localKeyOk(req)) return fail(res, 403, "Only agentbook-cli on this machine connects these.");
    const r = await commands["remote.connect"](await readBody(req));
    if (r?.error) return fail(res, r.status || 400, r.error);
    ok(res, r);
  });
  // A copy Claude Code started before agentbook folded them (resumed above), folded into the thread it's a copy of
  // (agentbook-cli fold): only one whose conversation has the thread's in it, and the thread goes on in whichever of
  // the two had the last turn. A copy keeps the ids of the messages it copied, so the thread's first one says.
  const readText = (file) => {
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
  };
  const firstMessage = (file) => {
    for (const line of (readText(file) || "").split("\n")) {
      try {
        const e = JSON.parse(line);
        if ((e.type === "user" || e.type === "assistant") && e.uuid) return e.uuid;
      } catch {}
    }
    return null;
  };
  route("POST", "/api/local/fold", async (req, res) => {
    if (!localKeyOk(req)) return fail(res, 403, "Only agentbook-cli on this machine folds a thread.");
    const b = await readBody(req);
    const find = (id) => (id ? state.sessions[id] || Object.values(state.sessions).find((s) => s.id.startsWith(id)) : null);
    const [copy, s] = [find(String(b.copy || "")), find(String(b.post || ""))];
    if (!copy || !s) return fail(res, 404, `No thread ${copy ? b.post : b.copy} on this machine.`);
    if (copy.id === s.id) return fail(res, 400, "That's one thread.");
    if (driverOf(s) || driverOf(copy) || s.cloud || copy.cloud) return fail(res, 400, "Only Claude Code's threads on this machine fold.");
    const first = firstMessage(s.transcript);
    if (!first || !copy.transcript || !readText(copy.transcript)?.includes(`"uuid":"${first}"`)) return fail(res, 400, `${copy.label} isn't a copy of ${s.label}: its conversation doesn't have ${s.label}'s in it.`);
    if (s.busy || copy.busy) return fail(res, 409, `${s.busy ? s.label : copy.label} is in the middle of a turn. Fold them once it's done.`);
    const last = (x) => x.turn_ended || x.turn_started || x.started || "";
    const follow = last(copy) > last(s);
    const left = follow ? s : copy;
    if (!left.asleep && left.state !== "done" && claude.running(claude.info(left.session_id))) return fail(res, 409, `${left.label} is still running, and the thread would go on in ${follow ? copy.label : s.label}. Stop it first.`);
    commit({ t: "session.fold", post: s.id, copy: copy.id, follow });
    log(`folded ${copy.id} into ${s.label} (${s.id})${follow ? ", which goes on in it" : ""}`);
    ok(res, { post: s.id, label: s.label, copy: copy.id, follow });
  });
  route("GET", "/api/show", async (req, res, { query }) => {
    const r = await ask("POST", "/show", { post: postKeyOf(query.get("proc") || "") || null });
    send(res, r.error ? 503 : 200, r.error ? `agentbook-server can't be reached; try again (${r.error}).` : hosted() ? fromServer("agentbook", r.text) : r.text, "text/plain; charset=utf-8");
  });

  /* ---------- asking the server ---------- */

  // The server's answer to something only it knows (tasks, pages, the feed), or { error } when it can't be
  // reached: what agents write still goes up later, but what they read needs the server now.
  async function ask(method, route, body, ms) {
    if (!uplink) return { error: "this machine isn't logged in to an agentbook-server" };
    try {
      return await uplink.ask(method, route, body, ms);
    } catch (e) {
      return { error: e.message, status: e.status || 503 };
    }
  }

  // --- what an agent is told about agentbook when it starts (context.mjs) ---
  const SELF_URL = (process.env.AGENTBOOK_URL || `http://127.0.0.1:${PORT}`).replace(/\/$/, "");
  const titleOf = (s) => s.own_title || s.title || s.ai_title || (s.prompt || "").split("\n")[0] || "New thread";
  async function wipSoon(root) {
    let data = wipOf(root);
    for (let i = 0; data === undefined && i < 20; i++) {
      await new Promise((r) => setTimeout(r, 100));
      data = wipOf(root);
    }
    return data || null;
  }
  // For a post (`post`), or for an agent starting before its post exists (`launch`, and its `cwd`).
  // `background`: its session says nobody reads its terminal. What's on this machine (git, its WIP) is read here;
  // what's the server's (its link, who sees it, its task and pages, the other posts in its workspace) is asked.
  async function contextFor({ post, launch, cwd, background = false }) {
    const s = post ? state.sessions[post] : null;
    const l = state.launches[s?.launch || launch] || null;
    const agentId = s?.agent || l?.agent;
    const agent = state.agents[agentId];
    const kind = agent?.kind || driverOfAgent(agentId)?.prefix || "claude-code";
    const dir = s?.cwd || cwd || "";
    const g = s ? { root: s.root, repo: s.repo, branch: s.branch } : driverHost.gitInfo(dir);
    const top = dir ? placeOf(dir)?.top : null;
    const place = top && g.root && top !== g.root ? path.relative(g.root, top) : null;
    const entries = g.root ? (await wipSoon(g.root)) || [] : [];
    const mine = entries.find((w) => w.branch === g.branch);
    const base = entries[0]?.base || (["main", "master"].includes(g.branch) ? g.branch : null);
    const wip = g.branch && g.branch === base ? { base, onBase: true } : mine ? { base: mine.base, ahead: mine.ahead, behind: mine.behind, dirty: mine.dirty } : null;
    const remote = (g.root && gitFacts(g.root).remote?.remote) || null;
    const c = await ask("POST", "/context", { post: post || null, launch: l?.id || null, agent: agentId || null, root: g.root || null, remote, branch: g.branch || null, kind, groups_dir: path.join(CLI_HOME, "groups").replace(os.homedir(), "~") });
    const others = c.others || [];
    const lost = loginLost();
    if (lost && post) toldLoginLost.add(post);
    const told = contextText({
      kind,
      agent: agent?.name || (agentId ? agentId[0].toUpperCase() + agentId.slice(1) : null),
      label: s?.label || null,
      person: c.person || owner?.display_name || owner?.username || null,
      link: c.link || null,
      background: background || !s || !!driverOf(s) || (!!l && !l.teleport),
      live: kind === "claude-code" && !!s?.channel,
      task: l?.task || c.task || null,
      page: c.page || null,
      pages: PAGE_WRITERS.includes(kind) ? c.pages || [] : null,
      repo: g.repo,
      place,
      branch: g.branch,
      cwd: dir,
      machine: MACHINE,
      wip,
      sameBranch: others.filter((o) => g.branch && o.branch === g.branch),
      others: others.filter((o) => !g.branch || o.branch !== g.branch),
      visibility: c.visibility || (s ? "private" : (l?.visibility || agent?.visibility) === "public" ? "public" : "private"),
      group: c.group || null,
      guests: c.guests || null,
      untrusted: hosted(),
    });
    return lost ? `${lost}\n\n${told}` : told;
  }
  // Visual mode, for every agent: what its sessions are told
  // when they start (contextFor), and reminded of as each turn starts.
  const VISUAL_REMINDER = "agentbook, Visual mode: the person reads this turn's reply at a glance. Right before your final reply, call ab_verdict (one line, which your reply doesn't repeat; a long reply goes as sections, each a heading, a first line and its number; next: what you do next), ab_checks (what failed, and what you didn't check: not what's theirs to do, that's ab_todo, with answers for a decision) and ab_suggest (what they'd likely say next); and when it fits, show rather than tell: ab_draft (something to send, for their OK), ab_cards (options, prices), ab_slots (times), ab_path (what you tried, dead ends too), ab_highlight (what matters), ab_compare (screenshots side by side, numbers that moved), ab_diagram (boxes and arrows), ab_chart (numbers as lines or bars). Skip them for a one-line answer.";
  // The agents that can write pages: the ones agentbook gives its MCP server to.
  const PAGE_WRITERS = ["claude-code", "codex"];
  route("GET", "/api/procs/:proc/context", async (req, res, { params, query }) => {
    const post = postOf(res, params.proc);
    if (!post) return;
    send(res, 200, await contextFor({ post, background: query.get("background") === "1" }), "text/plain; charset=utf-8");
  });

  // --- sessions: registration and status, from hooks and the MCP server ---
  route("POST", "/api/hello", async (req, res) => {
    const b = await readBody(req);
    if (!b.proc) return fail(res, 400, "proc is required");
    // Not logged in: nothing of this session is kept, and it's told so.
    if (!started) return ok(res, { post: null, login: true });
    heard(String(b.proc), localKeyOk(req));
    // A thread starting (`starting`, from its SessionStart hook) tries once more after its server refused this machine's
    // login, waited for a moment, so what it hears as it starts is how that went.
    if (b.starting && uplink?.status().signed_out) await Promise.race([uplink.tryAgain(), new Promise((r) => setTimeout(r, 2000).unref())]);
    const said = (r) => ok(res, { ...r, ...updateNote() });
    const agentName = str(b.agent || "Claude", 40);
    // Claude Code starts a background session in a worker it made earlier, with the variables of the launch that
    // started its daemon: a launch another thread took already. Its name came with it, so every thread it starts
    // would have that one; it gets a bird of its own instead.
    const told = b.launch && state.launches[b.launch];
    const stale = told?.post && told.post !== (b.session_id || b.proc);
    const label = stale ? bird(String(b.proc)) : b.label;
    // A session in a terminal that has only just started (`claude`, or /clear: `fresh`, from its SessionStart hook)
    // gets its thread at its first prompt, when its hooks call again and find it isn't registered: until then
    // nothing has happened in it, and opening Claude Code and quitting would leave a "New thread" waiting for a
    // prompt. One that already has a thread (a copy of one), that a launch waits for, or that runs in the background
    // registers now. The conversation it moved on from (/clear) is over either way.
    if (b.session_id && !claude.info(b.session_id)) listSoon();
    const own = (b.session_id && foldedInto(state, b.session_id)) || b.session_id || b.proc;
    const awaited = (told && !told.post && !told.error) || Object.values(state.launches).some((l) => l.session && !l.post && !l.error && String(own).startsWith(l.session));
    if (b.fresh && !state.sessions[own] && !awaited && !claude.background(b.session_id)) {
      const was = state.procs[b.proc];
      if (was && was !== own && state.sessions[was] && state.sessions[was].state !== "done") commit({ t: "session.gone", post: was, reason: "Cleared" });
      return said({ post: null, deferred: true });
    }
    const op = {
      t: "session.hello",
      proc: str(b.proc, 120),
      agent: slug(agentName),
      agent_name: agentName,
      kind: str(b.kind || "claude-code", 40),
      label: str(label || "session", 40),
      // AGENTBOOK_LABEL: kept as it is (see freeName in store.mjs). A session from before `named` goes by its name.
      named: !stale && (b.named ?? (!!label && label !== bird(String(b.proc)))),
      session_id: b.session_id ? str(b.session_id, 80) : undefined,
      transcript: typeof b.transcript === "string" ? b.transcript : undefined,
      cwd: b.cwd,
      root: b.root,
      repo: b.repo,
      branch: b.branch,
      pid: b.pid,
      host: b.host,
      channel: !!b.channel,
      launch: b.launch ? str(b.launch, 40) : undefined,
    };
    // Private terminals: a session agentbook didn't start gets no thread. One agentbook may have just started is
    // waited for a moment, and else asked again at its next hook.
    for (let i = 0; i < 25 && startedElsewhere(op) && launchInFlight(); i++) await new Promise((r) => setTimeout(r, 100));
    if (startedElsewhere(op)) {
      if (launchInFlight()) return said({ post: null, deferred: true });
      keepOff(op);
      return said({ post: null, private: true, said: KEPT_OFF });
    }
    keptOff.delete(op.proc);
    commit(op);
    const key = state.procs[b.proc];
    said({ post: key, label: state.sessions[key].label });
  });

  route("POST", "/api/procs/:proc/status", async (req, res, { params }) => {
    const b = await readBody(req);
    const post = postOf(res, params.proc);
    if (!post) return;
    const states = ["working", "idle", "waiting"];
    const turn = b.turn === "start" || b.turn === "end" ? b.turn : undefined;
    const transcript = typeof b.transcript === "string" && b.transcript !== state.sessions[post].transcript ? b.transcript : undefined;
    const failed = turn === "end" && b.failed ? str(b.failed, 40) : undefined;
    const ended = turn === "end" && state.sessions[post].busy; // its turn, not a reminder that it's idle
    commit({ t: "session.status", post, state: states.includes(b.state) ? b.state : undefined, text: str(b.text, 200) || undefined, turn, transcript, failed });
    // Whether it runs in the background decides whether agentbook picks it up, so a session Claude Code's list
    // doesn't have yet is looked up first.
    if (failed && !claude.info(state.sessions[post].session_id)) await claude.refresh().catch(() => {});
    if (failed && pickable(state.sessions[post])) cutOff(post);
    else if (ended) dropCut(post);
    // A Claude Code session got a reply, so Claude Code is signed in.
    if (ended && b.replied && !failed && !driverOf(state.sessions[post]) && !state.sessions[post].cloud) loginBack();
    // A finished or newly started turn means any permission prompt was settled in the terminal, and Claude's
    // questions a hook was waiting on with it.
    if (b.settle_permissions) settlePermissions(post, "terminal");
    // A turn starting: its hook hands the agent Visual mode's reminder.
    const sv = state.sessions[post];
    const lost = turn === "start" && !toldLoginLost.has(post) ? loginLost() : null;
    if (lost) toldLoginLost.add(post);
    ok(res, { ...(turn === "start" && sv.agent && !driverOf(sv) ? { remind: VISUAL_REMINDER } : {}), ...(lost ? { login_lost: lost } : {}) });
  });

  // Close a session's permission prompts, and Claude's questions a hook was waiting on, once something else
  // settled them: the terminal, or stopping the turn they were for.
  function settlePermissions(post, by) {
    for (const q of state.questions) if (q.post === post && (q.kind === "permission" || q.hook) && !q.answered) commit({ t: "question.answer", qid: q.id, value: null, by });
  }

  const turnGoing = (s) => s.busy || ["working", "waiting"].includes(s.state);
  function turnStopped(post) {
    commit({ t: "session.status", post, state: "idle", text: "Stopped, waiting for your next message", turn: "end" });
    settlePermissions(post, "stopped");
  }
  // Esc ends a turn without a word: Claude Code runs no hook for it, and goes on listing a session with a shell running
  // as busy. Only its transcript says so, whoever pressed it (Stop here, which may not see it on the screen, or
  // someone in a terminal). Until the thread hears, it says it's working, and what you send it waits for a turn that's
  // over: one sat idle at its prompt for 40 minutes that way, holding an answer and two messages.
  function saveInterrupt(s) {
    if (!s || s.state === "done" || s.asleep || !turnGoing(s)) return;
    const at = transcripts.interrupted(s);
    if (!at || Date.parse(at) < Date.parse(s.turn_started)) return;
    // Esc says "wait for me" as Stop does (post.stop): its queue holds.
    if (queueOf(s.id).length && !s.queue_paused) commit({ t: "session.paused", post: s.id, paused: "stopped" });
    turnStopped(s.id);
  }

  // Writing to a post whose turn is stopped on you (a permission prompt, Claude's questions, Codex's and
  // OpenClaw's) sets what it asked aside, as Esc does in a terminal, so what you wrote reaches it now rather than
  // after an answer: a permission is denied, a question goes unanswered. Claude's hook hands Claude what you wrote
  // as the reason; a driver's agent gets it right after. ab_ask's polls don't stop a turn, so they stay open.
  function setAside(post) {
    for (const q of state.questions) if (q.post === post && !q.answered && (q.kind === "permission" || q.hook || q.blocks)) commit({ t: "question.answer", qid: q.id, value: q.kind === "permission" ? "deny" : null, by: "comment" });
  }

  route("POST", "/api/procs/:proc/gone", async (req, res, { params }) => {
    const b = await readBody(req);
    const post = state.procs[params.proc];
    // A session agentbook is waking ends only to start again under the same id. A background session whose
    // process ends goes to sleep: its conversation is kept, and writing to its post wakes it.
    if (post && !waking.has(post)) {
      if (claude.background(state.sessions[post].session_id)) asleep(post);
      else commit({ t: "session.gone", post, reason: str(b.reason, 120) || "Ended" });
    }
    ok(res);
  });

  // A background session needs permission for a tool call (its PermissionRequest hook). Nobody's at a
  // terminal to see Claude Code's prompt, so it becomes Allow/Deny on the post and the hook waits for it.
  // Sessions in a terminal get their usual prompt instead.
  // "mcp__plugin_agentbook_agentbook__ab_post" reads as "agentbook ab_post".
  function toolLabel(name) {
    if (!name.startsWith("mcp__")) return name;
    const [, server = "", tool = ""] = name.split("__");
    return `${server.replace(/^plugin_[^_]+_/, "").replace(/^claude_ai_/, "")} ${tool}`;
  }
  function previewOf(tool, input = {}) {
    if (tool === "Bash") return str(input.command, 2000);
    if (input.file_path) return str(input.file_path, 500);
    if (input.url) return str(input.url, 500);
    return str(JSON.stringify(input, null, 2), 2000);
  }
  route("POST", "/api/procs/:proc/permission", async (req, res, { params }) => {
    const b = await readBody(req);
    const post = postOf(res, params.proc);
    if (!post) return;
    const s = state.sessions[post];
    if (!claude.info(s.session_id)) await claude.refresh();
    if (!claude.background(s.session_id)) return ok(res, { wait: false });
    // Claude asking you something (AskUserQuestion): each question is a poll, with its options and room for an
    // answer of your own. The hook waits for them all and hands Claude the answers.
    if (b.tool_name === "AskUserQuestion") {
      const asked = (Array.isArray(b.tool_input?.questions) ? b.tool_input.questions : []).slice(0, 4);
      if (!asked.length) return ok(res, { wait: false });
      const ids = asked.map((one, i) => {
        const op = commit({ t: "question.ask", post, kind: one.multiSelect ? "multi" : "choice", title: str(one.question, 500), detail: str(one.header, 40), options: (one.options || []).slice(0, 6).map((o) => ({ label: str(o.label, 120), detail: str(o.description, 300) || null })), key: `ask:${str(b.tool_use_id, 80) || state.seq}:${i}`, hook: true, other: true });
        return `q${op.seq}`;
      });
      return ok(res, { wait: true, ask: true, ids });
    }
    const tool = str(b.tool_name || "a tool", 120);
    const name = toolLabel(tool);
    const op = commit({ t: "question.ask", post, kind: "permission", title: `Allow ${name}?`, detail: describeTool(tool, b.tool_input || {}, s.cwd), preview: previewOf(tool, b.tool_input || {}), request_id: `h${state.seq + 1}`, tool_name: name });
    ok(res, { wait: true, id: `q${op.seq}` });
  });

  // The hook stopped waiting (after a day): its questions close, and the session waits in Claude Code's own
  // prompt, where only a terminal (claude attach) reaches it.
  route("POST", "/api/procs/:proc/permission/expire", async (req, res, { params }) => {
    const b = await readBody(req);
    const post = postOf(res, params.proc);
    if (!post) return;
    for (const qid of Array.isArray(b.ids) ? b.ids : []) if (state.questions.some((q) => q.id === qid && q.post === post && !q.answered)) commit({ t: "question.answer", qid, value: null, by: "expired" });
    commit({ t: "session.status", post, state: "waiting", text: "Waiting in Claude Code: open it in a terminal to answer" });
    ok(res);
  });

  // Claude Code only treats a channel event as the person speaking when it starts a turn. One that lands
  // mid-turn is marked as untrusted outside input, so an answer or message sent then would be ignored.
  // Live delivery therefore waits for the gap between turns. Permission verdicts go at once: they answer
  // Claude Code's prompt, not Claude.
  const TURN_GRACE_MS = 1500;
  function holdMs(post) {
    const s = state.sessions[post];
    if (!s) return 0;
    if (s.busy) return Infinity;
    return s.turn_ended ? Math.max(0, Date.parse(s.turn_ended) + TURN_GRACE_MS - Date.now()) : 0;
  }
  const switching = (s) => !!s?.model_pick && !driverOf(s) && claude.background(s.session_id);
  const idleNow = (post) => state.sessions[post]?.state === "idle" && !state.sessions[post].busy;
  // The Wake hooks waiting on each post (`idle=1`), and when one last came or went: between two of its polls
  // a hook is away for a moment.
  const wakers = new Map(); // post -> { n, at }
  const wakeable = (post) => (wakers.get(post)?.n || 0) > 0 || Date.now() - (wakers.get(post)?.at || 0) < 5000;

  // Long-poll: the live delivery loop waits here, and hooks and ab_inbox take events without waiting.
  // `idle=1`: the Wake hook of a session sitting at its prompt in a terminal, which wakes it when something
  // arrives. It ends with `idle: false` when the session isn't idle (still finishing its turn), and with
  // `left: true` too once it stops being idle while this waits: that turn's Stop hook starts the next one.
  route("GET", "/api/procs/:proc/events", async (req, res, { params, query }) => {
    const post = postOf(res, params.proc);
    if (!post) return;
    const wait = Math.min(Number(query.get("wait") || 0), 55);
    const deadline = Date.now() + wait * 1000;
    const idleOnly = query.get("idle") === "1";
    if (idleOnly && !idleNow(post)) return ok(res, { events: [], idle: false });
    let closed = false;
    let stop = () => {};
    if (idleOnly) wakers.set(post, { n: (wakers.get(post)?.n || 0) + 1, at: Date.now() });
    res.on("close", () => {
      closed = true;
      stop();
      if (idleOnly) wakers.set(post, { n: Math.max(0, (wakers.get(post)?.n || 1) - 1), at: Date.now() });
    });
    const take = () => {
      // A background session switching models takes what you sent when agentbook wakes it on the new one.
      const held = (wait > 0 && holdMs(post) > 0) || switching(state.sessions[post]);
      // An answer an ab_ask call is waiting for is that call's to return (and to ack), not a hook's or the channel's.
      const taking = query.get("ack") === "1";
      // A slash command isn't for Claude to read: it waits for its turn to end, and agentbook wakes it with it.
      const events = store.pending(post).filter((e) => (!held || e.event.type === "permission") && !(taking && e.event.type === "answer" && mcp.awaited(e.event.question_id)) && !e.event.command);
      if (events.length && taking) commit({ t: "outbox.ack", oids: events.map((e) => e.oid) });
      return events;
    };
    let events = take();
    while (!events.length && !closed && Date.now() < deadline) {
      await new Promise((resolve) => {
        const hold = holdMs(post);
        const timer = setTimeout(resolve, Math.min(deadline - Date.now(), hold > 0 && hold !== Infinity ? hold + 20 : Infinity));
        const set = waiters.get(post) || new Set();
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        set.add(done);
        waiters.set(post, set);
        stop = done;
      });
      if (closed) return; // nobody to hand events to; they stay queued
      if (state.procs[params.proc] !== post) break; // the process moved to another post: re-poll
      if (idleOnly && !idleNow(post)) return ok(res, { events: [], idle: false, left: true });
      events = take();
    }
    // What changed in its group rides along with what it takes, or with its next prompt (`news=1`), never alone.
    if (query.get("ack") === "1" && (events.length || query.get("news") === "1")) {
      const text = await groupNews(post).catch(() => null);
      if (text) events = [...events, { oid: null, post, event: { type: "group", text } }];
    }
    // `open=1` (ab_inbox): the post's own questions still waiting on the person, not its permission prompts.
    const open = query.get("open") === "1" ? state.questions.filter((q) => q.post === post && !q.answered && q.kind !== "permission").map((q) => ({ id: q.id, title: q.title })) : null;
    ok(res, { events, ...(open ? { open } : {}), ...(idleOnly ? { idle: idleNow(post) } : {}) });
  });

  route("POST", "/api/procs/:proc/ack", async (req, res, { params }) => {
    const b = await readBody(req);
    if (!postOf(res, params.proc)) return;
    if (Array.isArray(b.oids) && b.oids.length) commit({ t: "outbox.ack", oids: b.oids.map(String) });
    ok(res);
  });

  // --- agentbook's MCP server (mcp.mjs), over MCP's Streamable HTTP ---
  // One JSON-RPC message (or a batch) per POST, answered as JSON. No event stream and no MCP sessions: what the
  // person sends reaches an agent another way (Codex's next turn, Claude Code's channel through the plugin's
  // bridge). `proc` says which post the tools write to, `cwd` the folder an agent's relative paths are in, and
  // `live=1` that it's a Claude Code session with agentbook's channel. Like /api/procs, this machine's only.
  // `agent=codex` instead of `proc`: Codex's own entry for these tools, in its config (codex.mjs), which every Codex
  // thread gets, wherever it was started. Codex says on each call which thread made it (`_meta.threadId`).
  // Its key in it with its server elsewhere, also while local_key waits (keyOnWhenDone), so it works once that's on.
  const mcpUrl = (proc, cwd, bridged = false) => `${SELF_URL}/api/mcp?${new URLSearchParams({ proc, ...(cwd ? { cwd } : {}), ...(hosted() && !bridged ? { key: mcpKey(proc) } : {}) })}`;
  const codexThreadOf = (m) => {
    const meta = m?.params?._meta;
    return String(meta?.threadId || meta?.["x-codex-turn-metadata"]?.thread_id || "");
  };
  route("POST", "/api/mcp", async (req, res, { query }) => {
    const fixed = query.get("proc");
    const forCodex = !fixed && query.get("agent") === "codex";
    if (!fixed && !forCodex) return fail(res, 400, "Say which thread the tools write to: /api/mcp?proc=…");
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: e.message } });
    }
    const whoFor = (m) => {
      const thread = forCodex && codexThreadOf(m);
      const proc = forCodex ? `codex:${thread ? codex.postOf(thread) : ""}` : fixed;
      const launch = proc.startsWith("launch:") ? state.launches[proc.slice(7)] : null;
      return { proc, live: query.get("live") === "1", codex: forCodex, cwd: query.get("cwd") || state.sessions[postKeyOf(proc)]?.cwd || launch?.root || null, login: !started, loginLost: loginLost() };
    };
    const answers = (await Promise.all((Array.isArray(body) ? body : [body]).map((m) => mcp.handle(m, whoFor(m))))).filter(Boolean);
    if (!answers.length) {
      res.writeHead(202);
      return res.end();
    }
    send(res, 200, Array.isArray(body) ? answers : answers[0]);
  });
  for (const method of ["GET", "DELETE"])
    route(method, "/api/mcp", (req, res) => {
      res.writeHead(405, { allow: "POST" });
      res.end();
    });
  // --- what a session posts ---
  // The pictures on this machine a post's agent names in what it writes (`![](/tmp/shot.png)`, a screenshot it
  // took): read now, since that's often a folder that's emptied soon after, and sent up for the server to keep with
  // the post (post.picture), so they show while this machine is off. Named again, one is sent as it is then. Only a
  // PNG, JPEG, GIF or WebP; for anything else, why not. A path is from the session's folder, ~ or /, or read
  // through its driver (OpenClaw's, on its gateway's machine).
  async function readLocalPicture(s, url) {
    const refuse = (status, message) => Object.assign(new Error(message), { status });
    if (s.cloud) throw refuse(404, "This thread ran in the cloud, so its pictures aren't on this machine.");
    const d = driverOf(s);
    if (d) {
      if (!d.file) throw refuse(404, `${d.name} doesn't hand over its files.`);
      return picture((await d.file(s, url)).bytes || Buffer.alloc(0), path.basename(url));
    }
    const p = url.replace(/^~(?=\/|$)/, os.homedir());
    const tries = path.isAbsolute(p) ? [p] : [s.cwd, s.root].filter(Boolean).map((b) => path.resolve(b, p));
    return readPicture(tries.find((f) => fs.existsSync(f)) || tries[0] || p);
  }
  async function sendPicture(post, url, got) {
    try {
      const { type, buf } = await got;
      const sha = await blobPut(buf, type);
      if (sha) commit({ t: "post.picture", post, url, sha, type, size: buf.length });
    } catch (e) {
      commit({ t: "post.picture", post, url, status: e.status || 500, error: String(e.message).slice(0, 600) });
    }
  }
  const MD_PICTURES = /!\[[^\]]*\]\(([^)\s]+)\)/g;
  function keepPictures(post, text) {
    const s = state.sessions[post];
    if (!s || !text) return;
    for (const [, url] of String(text).matchAll(MD_PICTURES)) if (localPicture(url) && url.length <= 2000) sendPicture(post, url, readLocalPicture(s, url));
  }

  route("POST", "/api/procs/:proc/post", async (req, res, { params }) => {
    const b = await readBody(req);
    const post = postOf(res, params.proc);
    if (!post) return;
    if (b.title || b.text != null) commit({ t: "session.post", post, title: b.title ? str(b.title, 140) : undefined, text: b.text != null ? str(b.text, 4000) : undefined });
    keepPictures(post, b.text);
    ok(res);
  });

  route("POST", "/api/procs/:proc/updates", async (req, res, { params }) => {
    const b = await readBody(req);
    const post = postOf(res, params.proc);
    if (!post) return;
    if (!b.text) return fail(res, 400, "text is required");
    commit({ t: "session.update", post, text: str(b.text, 300), link: /^https?:\/\//.test(b.link || "") ? str(b.link, 500) : null });
    keepPictures(post, b.text);
    if (b.link) agentLinked(post, String(b.link));
    ok(res);
  });

  route("POST", "/api/procs/:proc/attachments", async (req, res, { params }) => {
    const b = await readBody(req);
    const post = postOf(res, params.proc);
    if (!post) return;
    if (!b.key) return fail(res, 400, "key is required");
    const prev = state.sessions[post].attachments[b.key];
    const type = prev?.type || b.type;
    if (!b.remove && !ATTACHABLE.includes(type)) return fail(res, 400, `type must be one of ${ATTACHABLE.join(", ")}`);
    // What the server takes of one: the agent hears it's too big, rather than that it was attached.
    if (b.data && Buffer.byteLength(JSON.stringify(b.data)) > 512 * 1024) return fail(res, 413, "That's too big to attach: 512 KB at most. Attach less, or hand it over as a file (ab_file).");
    // Checked as a page's widget of its kind is, over what it had (widgets.mjs). A field it sent that isn't kept
    // goes as null, so the store's merge doesn't keep what it had there.
    const given = b.data && typeof b.data === "object" && !Array.isArray(b.data) ? b.data : {};
    const out = { errors: [], notes: [] };
    const data = b.remove ? {} : { ...Object.fromEntries(Object.keys(given).map((k) => [k, null])), ...cleanData(type, { ...(prev?.data || {}), ...given }, out) };
    if (out.errors.length) return fail(res, 400, `Nothing was attached:\n${out.errors.join("\n")}`);
    commit({ t: "session.attach", post, key: str(b.key, 60), type, title: b.title ? str(b.title, 120) : undefined, data, remove: !!b.remove });
    if (!b.remove && type === "link" && data.url) agentLinked(post, String(data.url));
    if (!b.remove && b.data) keepPictures(post, JSON.stringify(data));
    ok(res, { notes: noteLines(out.notes) });
  });

  // Whether the session answered on agentbook since the person last spoke, and did nothing after it. If it did,
  // Claude's closing words in the terminal only narrate that answer, so the mirror leaves them out. One that
  // worked on after it (a reply to a comment mid-turn) has more to say: its closing words are the turn's answer.
  function answeredOnDash(post) {
    const said = conversationOf(state, post);
    for (let i = said.length - 1; i >= 0; i--) {
      const m = said[i];
      if (m.from === "human") return false;
      if (m.via === "dash" && m.text) return !(transcripts.digest(state.sessions[post])?.steps || []).some((st) => st.kind === "tool" && st.at > m.at);
    }
    return false;
  }

  route("POST", "/api/procs/:proc/messages", async (req, res, { params }) => {
    const b = await readBody(req);
    const post = postOf(res, params.proc);
    if (!post) return;
    if (!b.text) return fail(res, 400, "text is required");
    const from = b.from === "human" ? "human" : "agent";
    const via = b.via === "terminal" ? "terminal" : "dash";
    // Its closing words stay out when it already answered on agentbook, unless they're what its turn's shape
    // (ab_verdict, ab_checks, ab_suggest) goes on.
    if (from === "agent" && via === "terminal" && answeredOnDash(post) && !state.sessions[post]?.shape) return ok(res, { skipped: "answered on agentbook" });
    commit({ t: "message.add", post, from, via, text: str(b.text, 12000) });
    if (from === "agent") keepPictures(post, b.text);
    ok(res);
  });

  // How its turn went, for the reply that ends it: its verdict and gist (ab_verdict), what it
  // checked (ab_checks), what the person would likely say next (ab_suggest), what it drafted (ab_draft), cards
  // (ab_cards), times (ab_slots), its path (ab_path), what matters (ab_highlight). Each part it sends replaces the
  // turn's, but a draft joins the turn's others.
  route("POST", "/api/procs/:proc/shape", async (req, res, { params }) => {
    const b = await readBody(req);
    const post = postOf(res, params.proc);
    if (!post) return;
    const r = shapeOf(b);
    if (r.error) return fail(res, 400, r.error);
    if (r.shape.drafts) r.shape.drafts = withDraft(state.sessions[post]?.shape?.drafts, r.shape.drafts[0]);
    commit({ t: "session.shape", post, shape: r.shape });
    // Its pictures on this machine (a compare's screenshots, a card's mockup) go up for the server to keep, as a
    // reply's `![](/tmp/shot.png)` does.
    const s = state.sessions[post];
    if (s) for (const url of new Set(localPictures(r.shape))) sendPicture(post, url, readLocalPicture(s, url));
    ok(res, r.notes?.length ? { ok: true, notes: r.notes } : { ok: true });
  });

  route("POST", "/api/procs/:proc/questions", async (req, res, { params }) => {
    const b = await readBody(req);
    const post = postOf(res, params.proc);
    if (!post) return;
    if (!b.title) return fail(res, 400, "title is required");
    // "multi": a poll where you pick several (the answer is their labels, joined with ", ").
    const kinds = ["permission", "approve", "choice", "multi", "text", "file"];
    const kind = kinds.includes(b.kind) ? b.kind : b.options?.length ? "choice" : "text";
    const op = commit({
      t: "question.ask",
      post,
      kind,
      title: str(b.title, 300),
      detail: str(b.detail, 1000),
      preview: str(b.preview, 4000),
      options: options(b.options),
      default: b.default != null ? str(b.default, 200) : null,
      until: parseUntil(b.until),
      key: b.key ? str(b.key, 60) : null,
      request_id: b.request_id ? str(b.request_id, 20) : null,
      tool_name: b.tool_name ? str(b.tool_name, 60) : null,
      other: !!b.other, // a poll that takes an answer of your own too
    });
    ok(res, { id: `q${op.seq}` });
  });

  // A post as the person's tasks know it: its key, the launch it came from, its agent, and where it works.
  const agentMe = (post) => {
    const s = state.sessions[post];
    return { post, launch: s.launch || null, agent: s.agent, root: s.root || null, remote: (s.root && gitFacts(s.root).remote?.remote) || null };
  };
  // An agent's to-do for the person (ab_todo) is one of their tasks, kept on the server, from its post and linked
  // to it: on its thread only, unless it's for `later` (their Tasks). When the agent says it isn't `new`, one that looks like an open task already there isn't added: it
  // hears which one, to link its post to that instead.
  route("POST", "/api/procs/:proc/todos", async (req, res, { params }) => {
    const b = await readBody(req);
    const post = postOf(res, params.proc);
    if (!post) return;
    const text = str(b.text, 4000).trim();
    if (!text) return fail(res, 400, "text is required");
    const r = await ask("POST", "/todos", { ...agentMe(post), text, note: b.note ? str(b.note, 4000) : undefined, answers: Array.isArray(b.answers) ? b.answers.slice(0, 4) : undefined, new: b.new, later: b.later === true });
    r.error ? fail(res, r.status === 409 ? 409 : 502, r.error) : ok(res, r);
  });
  // The person's Tasks as an agent reads them (ab_tasks), from the server. The agent ticks off what's done, and
  // each tick says which post did it, so the person sees who, and can untick it. It links its post to a task.
  route("GET", "/api/procs/:proc/tasks", async (req, res, { params }) => {
    const post = postOf(res, params.proc);
    if (!post) return;
    const r = await ask("POST", "/tasks", agentMe(post));
    if (r.error) return ok(res, { person: owner?.display_name || null, open: [], more: 0, done: [], hub_error: r.error, todos: [] });
    ok(res, { ...r, todos: [], ...(hosted() ? { from_server: "tasks" } : {}) });
  });
  async function agentTaskIds(req, res, params, route, extra) {
    const b = await readBody(req);
    const post = postOf(res, params.proc);
    if (!post) return;
    const ids = [...new Set((Array.isArray(b.ids) ? b.ids : [b.ids]).filter((x) => typeof x === "string" && x.trim()).map((x) => str(x.trim(), 100)))].slice(0, 50);
    if (!ids.length) return fail(res, 400, "Say which tasks, by their ids.");
    const r = await ask("POST", route, { ...agentMe(post), ids, ...extra(b) });
    ok(res, { ...extra(b), results: r.error ? ids.map((id) => ({ id, error: r.error })) : r.results });
  }
  // Tick (`done`, the default) or untick tasks by id.
  route("POST", "/api/procs/:proc/tasks/done", (req, res, { params }) => agentTaskIds(req, res, params, "/tasks/done", (b) => ({ done: b.done !== false })));
  // Link the agent's post to tasks by id (`linked: false` unlinks it).
  route("POST", "/api/procs/:proc/tasks/link", (req, res, { params }) => agentTaskIds(req, res, params, "/tasks/link", (b) => ({ linked: b.linked !== false })));

  route("POST", "/api/procs/:proc/files", async (req, res, { params }) => {
    const b = await readBody(req);
    const post = postOf(res, params.proc);
    if (!post) return;
    if (!b.name || typeof b.content_base64 !== "string") return fail(res, 400, "name and content_base64 are required");
    const buf = Buffer.from(b.content_base64, "base64");
    const name = safeName(b.name);
    const embedded = !!b.embedded;
    // Its bytes go to the server too, so the file opens there while this machine is off.
    const blob = await blobPut(buf);
    const op = commit({ t: "file.add", post, from: "agent", name, title: str(b.title || name, 140), size: buf.length, stored: storeFile(buf, name), draft: !!b.draft, embedded, ...(blob ? { blob } : {}) });
    if (!embedded) commit({ t: "message.add", post, from: "agent", via: "dash", text: "", file_id: `f${op.seq}` });
    ok(res, { id: `f${op.seq}`, url: `/api/files/f${op.seq}` });
  });

  // ?wait=N: hold the request up to N seconds until it's answered.
  route("GET", "/api/questions/:id", async (req, res, { params, query }) => {
    const find = () => state.questions.find((x) => x.id === params.id);
    if (!find()) return fail(res, 404, "No such question");
    const until = Date.now() + Math.min(Number(query.get("wait") || 0), 55) * 1000;
    let closed = false;
    res.on("close", () => (closed = true));
    while (!find()?.answered && !closed && Date.now() < until) await new Promise((r) => setTimeout(r, 300));
    if (closed) return;
    const q = find();
    if (!q) return fail(res, 404, "No such question");
    ok(res, q);
  });

  // --- pages and their routines, kept on the server (ab_page_list, ab_page_read, ab_page_write, ab_routine_*) ---
  // `what`: what an agent reads in the answer, which a server elsewhere wrote (or whoever holds it): the tool that
  // shows it marks it as that (mcp.mjs, context.mjs's fromServer), as group news is.
  const askOr = async (res, method, route, body, ms, what = null) => {
    const r = await ask(method, route, body, ms);
    if (r.error) return fail(res, r.status && r.status < 500 ? r.status : 502, r.error);
    ok(res, what && hosted() ? { ...r, from_server: what } : r);
  };
  route("GET", "/api/procs/:proc/pages", async (req, res, { params }) => {
    const post = postOf(res, params.proc);
    if (post) await askOr(res, "POST", "/pages/list", { post, agent: state.sessions[post].agent }, undefined, "pages");
  });
  route("GET", "/api/procs/:proc/pages/:id", async (req, res, { params }) => {
    const post = postOf(res, params.proc);
    if (post) await askOr(res, "POST", "/pages/read", { post, agent: state.sessions[post].agent, page: params.id }, undefined, "page");
  });
  // The pictures on this machine an agent names in a page it writes, by their whole path (a page has no folder of
  // its own to start from): sent up with the write, for the server to keep with the page.
  async function pagePictures(write) {
    const urls = new Set();
    const walk = (v, key) => {
      if (typeof v === "string") {
        for (const [, url] of v.matchAll(MD_PICTURES)) urls.add(url);
        if (key === "image") urls.add(v.trim());
      } else if (Array.isArray(v)) v.forEach((x) => walk(x));
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
    };
    walk(write);
    const out = [];
    for (const url of urls) {
      const file = url.replace(/^~(?=\/|$)/, os.homedir());
      if (!localPicture(url) || url.length > 2000 || !path.isAbsolute(file) || out.length >= 20) continue;
      try {
        const { type, buf } = readPicture(file);
        const sha = await blobPut(buf, type);
        if (sha) out.push({ url, sha });
      } catch {}
    }
    return out;
  }
  route("POST", "/api/procs/:proc/pages", async (req, res, { params }) => {
    const post = postOf(res, params.proc);
    if (!post) return;
    const write = await readBody(req);
    await askOr(res, "POST", "/pages/write", { post, agent: state.sessions[post].agent, write, pictures: await pagePictures(write) });
  });
  // Dashboards: a page whose panels hold queries, which the server runs through its
  // person's connectors (ab_dashboard_write), and those connectors' sources (ab_source).
  route("POST", "/api/procs/:proc/dashboards", async (req, res, { params }) => {
    const post = postOf(res, params.proc);
    if (post) await askOr(res, "POST", "/dashboards/write", { post, agent: state.sessions[post].agent, write: await readBody(req) }, 90e3);
  });
  route("GET", "/api/procs/:proc/sources", async (req, res, { params }) => {
    const post = postOf(res, params.proc);
    if (post) await askOr(res, "POST", "/sources/list", { post, agent: state.sessions[post].agent }, undefined, "sources");
  });
  for (const what of ["discover", "query"])
    route("POST", `/api/procs/:proc/sources/${what}`, async (req, res, { params }) => {
      const post = postOf(res, params.proc);
      if (post) await askOr(res, "POST", `/sources/${what}`, { ...(await readBody(req)), post, agent: state.sessions[post].agent }, 40e3, "source data");
    });
  // Notes: its person's, which the server keeps. An agent reads them, writes the ones it made,
  // comments, and suggests edits in the rest.
  route("GET", "/api/procs/:proc/notes", async (req, res, { params }) => {
    const post = postOf(res, params.proc);
    if (post) await askOr(res, "POST", "/notes/list", { post, agent: state.sessions[post].agent }, undefined, "notes");
  });
  route("GET", "/api/procs/:proc/notes/:id", async (req, res, { params }) => {
    const post = postOf(res, params.proc);
    if (post) await askOr(res, "POST", "/notes/read", { post, agent: state.sessions[post].agent, note: params.id }, undefined, "note");
  });
  for (const [path_, what] of [["", "write"], ["/:id/suggest", "suggest"], ["/:id/comment", "comment"]])
    route("POST", `/api/procs/:proc/notes${path_}`, async (req, res, { params }) => {
      const post = postOf(res, params.proc);
      if (!post) return;
      const b = await readBody(req);
      await askOr(res, "POST", `/notes/${what}`, { ...b, ...(params.id ? { note: params.id } : {}), post, agent: state.sessions[post].agent });
    });
  // Routines: a page's (`id`), or, without one, the ones the agent wrote, runs as, or are for its thread.
  const readRoutines = async (req, res, { params, query }) => {
    const post = postOf(res, params.proc);
    if (post) await askOr(res, "POST", "/routines/read", { post, agent: state.sessions[post].agent, page: params.id || null, routine: query.get("routine") || null }, undefined, "routines");
  };
  route("GET", "/api/procs/:proc/pages/:id/routines", readRoutines);
  route("GET", "/api/procs/:proc/routines", readRoutines);
  const writeRoutine = async (req, res, { params }) => {
    const post = postOf(res, params.proc);
    if (!post) return;
    const s = state.sessions[post];
    const b = await readBody(req);
    // Its code may be a file in the agent's folder: read here, where the folder is.
    if (b.code == null && b.file) {
      const file = path.resolve(s.cwd || s.root || os.homedir(), String(b.file));
      try {
        b.code = fs.readFileSync(file, "utf8");
      } catch (e) {
        return fail(res, 400, `Couldn't read ${file}: ${e.message}`);
      }
      delete b.file;
    }
    // This machine runs code an agent here wrote without a signature, which it can't ask for from a test.
    if (typeof b.code === "string") gate.wrote(b.code);
    // A test, or a save that tests it, runs its code on a machine first: up to its timeout (5 minutes at most).
    await askOr(res, "POST", "/routines/write", { post, agent: s.agent, page: params.id || null, write: b }, 340e3);
  };
  route("POST", "/api/procs/:proc/pages/:id/routines", writeRoutine);
  route("POST", "/api/procs/:proc/routines", writeRoutine);

  /* ---------- groups (groups.mjs): kept on the server; their folders, here ---------- */

  // A group's folder here, kept the same as its files on the server (group-files.mjs).
  const groupFiles = createGroupFiles({
    home: HOME,
    // A version sent up: its bytes first, then the version, credited to the post that wrote it, or this machine.
    upload: async (gid, p, content, post) => {
      if (content && !(await blobPut(content.buf))) return { error: "its server can't be reached" };
      return ask("POST", "/group/file", { gid, path: p, ...(content ? { sha: content.sha, size: content.buf.length } : { deleted: true }), post: post || null, agent: post ? state.sessions[post]?.agent || null : null });
    },
    fetchBlob: (sha) => fetchBlob({ id: sha }),
    credit: creditGroupFile,
    log,
    hosted,
  });
  const groupDir = (gid) => {
    const dir = groupFiles.dirOf(gid);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  // The folders a thread can write besides its own: its group's.
  const extraDirs = (s) => (s?.group ? [groupDir(s.group)] : []);
  // Who wrote a file in a group's folder: the post in the group whose transcript last wrote it, in the last few
  // minutes. Null: something else on this machine.
  async function creditGroupFile(gid, abs) {
    let best = null;
    for (const s of Object.values(state.sessions)) {
      if (s.group !== gid || (s.state === "done" && Date.now() - Date.parse(s.ended || s.updated) > 600e3)) continue;
      const ed = await editsOf(s).catch(() => null);
      for (const e of ed?.edits || []) if (e.abs === abs && (!best || String(e.at) > String(best.at))) best = { at: e.at, post: s.id };
    }
    return best && Date.now() - Date.parse(best.at) < 600e3 ? best.post : null;
  }
  // What changed in a post's group, and in its WIP of many, since it last heard, as one message (the server keeps
  // both, and marks it told): text, or null when it's in neither, or nothing did.
  async function groupNews(post) {
    if (!state.sessions[post]?.group && !state.sessions[post]?.wip && !state.sessions[post]?.paged) return null;
    const r = await ask("POST", "/group/news", { post });
    if (!r?.text) return null;
    return hosted() ? fromServer("group news", r.text) : r.text;
  }
  // Every group of this machine's person, as the server has it: their folders here, made the same.
  async function syncGroups() {
    const r = await ask("POST", "/group/list", {});
    if (r?.error) return;
    for (const g of r.groups || []) groupFiles.sync(g.id, g.files || [], { archived: !!g.archived }).catch((e) => log(`group ${g.id}: ${e.message}`));
  }

  // --- agents, through the MCP server (ab_group_read, ab_group_write) ---
  // The group (no query), one thread in it (`thread`: its name or id), or a file in it (`file`, `v`).
  route("GET", "/api/procs/:proc/group", async (req, res, { params, query }) => {
    const post = postOf(res, params.proc);
    if (!post) return;
    await askOr(res, "POST", "/group/read", { post, agent: state.sessions[post].agent, thread: query.get("thread") || null, file: query.get("file") || null, v: query.get("v") || null, dir: state.sessions[post].group ? groupFiles.dirOf(state.sessions[post].group).replace(os.homedir(), "~") : null }, undefined, "group");
  });
  // ab_thread_read: the conversation it's in, with guests (the server keeps who's a guest where).
  route("GET", "/api/procs/:proc/thread", async (req, res, { params, query }) => {
    const post = postOf(res, params.proc);
    if (!post) return;
    await askOr(res, "POST", "/thread/read", { post, agent: state.sessions[post].agent, thread: query.get("thread") || null, at: query.get("at") || null }, undefined, "thread");
  });
  // ab_search: threads its person may see. The server has them, with this machine off or not.
  route("GET", "/api/procs/:proc/search", async (req, res, { params, query }) => {
    const post = postOf(res, params.proc);
    if (!post) return;
    await askOr(res, "POST", "/thread/search", { post, agent: state.sessions[post].agent, q: query.get("q") || "", by: query.get("by") || null, workspace: query.get("workspace") || null, since: query.get("since") || null, everyone: query.get("everyone") === "1", n: query.get("n") || null }, undefined, "search results");
  });
  // A file it writes into the group's folder: a version on the server, then in the folder here.
  route("POST", "/api/procs/:proc/group/files", async (req, res, { params }) => {
    const post = postOf(res, params.proc);
    if (!post) return;
    const gid = state.sessions[post].group;
    if (!gid) return fail(res, 404, "This thread isn't in a group. The person puts threads in groups on agentbook.");
    const b = await readBody(req);
    if (!cleanPath(b.path)) return fail(res, 400, "That isn't a path inside the group's folder.");
    try {
      const buf = typeof b.content_base64 === "string" ? Buffer.from(b.content_base64, "base64") : Buffer.from(String(b.text ?? ""), "utf8");
      const v = await groupFiles.write(gid, b.path, buf, post);
      ok(res, { path: v.path, v: v.v, url: v.url });
    } catch (e) {
      fail(res, e.status || 400, e.message);
    }
  });

  /* ---------- reads: what the server asks of this machine when someone looks ---------- */

  const reads = {};
  const commands = {};
  // A read's or a command's answer when it fails: { error, status }.
  const no = (status, error, extra = {}) => ({ error, status, ...extra });

  // The slash commands a thread's agent can run from here: a Claude Code session that
  // agentbook wakes or resumes (one open in a terminal takes them only there), or a driver's that lists its own
  // (OpenClaw's). { runs: true, list, off } or { runs: false, why }.
  function commandsWhere(s) {
    if (!s || s.cloud) return null;
    const d = driverOf(s);
    if (d) return d.commands ? "driver" : null;
    if (state.agents[s.agent]?.kind !== "claude-code" || !s.session_id) return null;
    const a = claude.info(s.session_id);
    return a?.kind === "interactive" && claude.running(a) ? null : "claude";
  }
  reads["read.commands"] = async ({ post }) => {
    const s = state.sessions[post];
    if (!s) return no(404, "No such thread");
    if (!s.cloud && !driverOf(s) && !claude.info(s.session_id)) await claude.refresh().catch(() => {});
    const where = commandsWhere(s);
    if (!where) {
      const a = !s.cloud && !driverOf(s) && claude.info(s.session_id);
      return { runs: false, why: a?.kind === "interactive" ? "terminal" : "agent" };
    }
    try {
      const r = where === "driver" ? await driverOf(s).commands(s) : await claudeCommands({ cwd: resumeDir(s), dirs: extraDirs(s) });
      return { runs: true, list: r.list, off: r.off };
    } catch (e) {
      return no(502, `Couldn't list its commands: ${e.message}`);
    }
  };

  // Every step of a session, read from its transcript.
  reads["read.steps"] = async ({ post }) => {
    const s = state.sessions[post];
    if (!s) return no(404, "No such thread");
    if (s.cloud) return { steps: [], plan: null, turn: 0, diff: s.cloud === "codex" ? await cloud.codexDiff(s.session_id) : null };
    const d = driverOf(s) ? await driverOf(s).steps(s.id).catch(() => null) : transcripts.digest(s);
    return d ? { steps: d.steps, plan: d.plan, turn: d.turn } : { steps: [], plan: null, turn: 0 };
  };
  // One of its workers' steps, its latest (workers.mjs): a Claude Code subagent's, from its own transcript, or its
  // driver's (an OpenClaw subagent's history). A runtime that says only what one last started gives that.
  reads["read.worker"] = async ({ post, worker }) => {
    const s = state.sessions[post];
    const w = workersOf(s).find((x) => x.id === worker);
    if (!w) return no(404, "No such worker");
    const d = driverOf(s);
    if (d?.workerSteps) {
      try {
        return (await d.workerSteps(s.id, worker)) || no(404, "No such worker");
      } catch (e) {
        return no(502, `Couldn't read its steps from ${d.name}: ${e.message}`);
      }
    }
    return { steps: w.steps || (w.step ? [{ id: `${w.id}:last`, at: w.step.at, kind: "tool", title: w.step.title }] : []), n: w.n || 0 };
  };
  // A picture a session's agent saw, the i-th on one of its steps, as { type, data (base64) }.
  reads["read.image"] = async ({ post, step, i }) => {
    const s = state.sessions[post];
    if (!s) return no(404, "No such thread");
    const d = driverOf(s);
    const list = s.cloud ? [] : d ? (d.images ? await d.images(s, step) : []) : transcripts.images(s, step);
    const img = Number.isInteger(i) ? list[i] : null;
    if (!img?.data) return no(404, "Couldn't find this image in the transcript.");
    return { type: img.type, data: img.data, label: s.label || "session" };
  };

  const PEEK_TEXT = 512 * 1024;
  const PEEK_IMAGE = /\.(png|jpe?g|gif|webp|svg|ico|avif)$/i;
  const PEEK_PLAYS = { video: /\.(mp4|m4v|mov|webm)$/i, audio: /\.(mp3|m4a|wav|ogg|oga|opus|flac|aac)$/i };
  const playsAs = (name) => Object.keys(PEEK_PLAYS).find((k) => PEEK_PLAYS[k].test(name)) || null;
  const realOr = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return null;
    }
  };
  const inside = (p, dir) => p === dir || p.startsWith(dir + path.sep);
  const isDir = (p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  const MAX_FOLDERS = 500;
  // A file a session's agent names in what it writes (`docs/plan.md`), for its owner to read on the page:
  // a path from the session's folder, from ~ or from /. Text comes back to show. A page or a picture comes
  // back with a peek root, to load in a sandboxed frame (read.peek); a video or a sound with one to play.
  // A folder comes back as a list. A session whose agent runs elsewhere (OpenClaw, on its gateway's machine)
  // has its driver read it there.
  reads["read.file"] = async ({ post, path: asked }) => {
    const s = state.sessions[post];
    if (!s) return no(404, "No such thread");
    asked = String(asked || "").trim();
    if (!asked) return no(400, "Which file?");
    if (s.cloud) return no(404, "This thread ran in the cloud, so its files aren't on this machine.");
    if (driverOf(s)?.file) return driverFile(driverOf(s), (p) => driverOf(s).file(s, p), s.id, asked, !!driverOf(s).streams?.());
    if (driverOf(s)?.repos) return no(404, "This thread runs in the cloud, so its files aren't on this machine.");
    const p = asked.replace(/^~(?=\/|$)/, os.homedir());
    const tries = path.isAbsolute(p) ? [p] : [s.cwd, s.root].filter(Boolean).map((b) => path.resolve(b, p));
    const full = tries.map(realOr).find(Boolean);
    if (!full) return no(404, `There's no ${asked} ${path.isAbsolute(p) || !tries.length ? `on ${MACHINE}` : `in ${s.cwd || s.root}`}.`);
    const stat = fs.statSync(full);
    const head = { path: full, name: path.basename(full), size: stat.size, modified: stat.mtime.toISOString() };
    // A file that's a secret as a whole (.env, a private key) stays on the machine (redact.mjs).
    const secret = !stat.isDirectory() && secretFileRefusal(full);
    if (secret) return no(403, secret);
    if (stat.isDirectory()) {
      let list;
      try {
        list = fs.readdirSync(full, { withFileTypes: true }).filter((e) => !e.name.startsWith(".")).map((e) => ({ name: e.name, dir: e.isDirectory() || (e.isSymbolicLink() && isDir(path.join(full, e.name))) }));
      } catch {
        return no(403, `agentbook can't read ${full}.`);
      }
      list.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
      return { ...head, kind: "dir", entries: list.slice(0, MAX_FOLDERS), more: Math.max(0, list.length - MAX_FOLDERS) };
    }
    // A page links to the rest of its checkout (a mockup's ../../ui/app.css), so its peek covers the widest
    // folder around it that doesn't reach it through a hidden one: the session's project, its folder, or the
    // checkout it's in (a worktree in .claude/worktrees is inside its project, but hidden from it).
    const reaches = (r) => r && inside(full, r) && !path.relative(r, full).split(path.sep).some((part) => part.startsWith("."));
    const root = [s.root, s.cwd, placeOf(path.dirname(full))?.top].map((r) => r && realOr(r)).filter(reaches).sort((a, b) => a.length - b.length)[0] || path.dirname(full);
    // A file the post touched outside what the machine shares opens alone, not with the folder around it.
    // (Unsigned, as a read is: a thread in the home folder doesn't hand out all of it.)
    allowPeek(root, s.id, (await gate.pathRefusal(root, { post: s.id, narrow: hosted() })) ? { only: full } : {});
    const peek = { root, via: s.id, path: path.relative(root, full).split(path.sep).join("/") };
    if (PEEK_IMAGE.test(full)) return { ...head, kind: "image", peek };
    if (playsAs(full)) return { ...head, kind: playsAs(full), peek };
    let buf;
    try {
      const fd = fs.openSync(full, "r");
      buf = Buffer.alloc(Math.min(stat.size, PEEK_TEXT));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
    } catch {
      return no(403, `agentbook can't read ${full}.`);
    }
    if (buf.subarray(0, 8000).includes(0)) return { ...head, kind: "binary", peek };
    const page = /\.html?$/i.test(full);
    return { ...head, kind: page ? "html" : "text", text: buf.toString("utf8"), truncated: stat.size > buf.length, ...(page ? { peek } : {}) };
  };
  // The same, read by a driver where its agent runs (`open`: a path -> the file, for the post or agent `via`). It
  // reads text and pictures; a file of another kind plays or downloads a piece at a time when the driver can hand
  // it over that way (`streams`), and otherwise shows without a way to download it. Its peek reads through the
  // driver too, so a page's stylesheet comes from its machine.
  async function driverFile(d, open, via, asked, streams = false) {
    const secret = secretFileRefusal(asked);
    if (secret) return no(403, secret);
    let f;
    try {
      f = await open(asked);
    } catch (e) {
      return no(e.status || 502, e.status ? e.message : `${d.name} couldn't open ${asked}: ${e.message}`);
    }
    const head = { path: f.path, name: f.name, size: f.size ?? 0, modified: f.modified || null };
    const named = !f.entries && secretFileRefusal(f.path || f.name || "");
    if (named) return no(403, named);
    if (f.entries) return { ...head, kind: "dir", entries: f.entries.slice(0, MAX_FOLDERS), more: Math.max(0, f.entries.length - MAX_FOLDERS), truncated: !!f.truncated };
    allowPeek(f.root, via, { open, streams, d });
    const peek = { root: f.root, via, path: path.posix.relative(f.root, f.path) };
    if (!f.bytes && typeof f.text !== "string") return streams ? { ...head, kind: playsAs(f.name) || "binary", peek } : { ...head, kind: "binary" };
    if (f.bytes || PEEK_IMAGE.test(f.name)) return { ...head, kind: "image", peek };
    const page = /\.html?$/i.test(f.name);
    return { ...head, kind: page ? "html" : "text", text: f.text, truncated: false, ...(page ? { peek } : {}) };
  }

  // Peeks: the files in a folder a read named, served a file at a time through the server to a sandboxed frame.
  // Only a folder a read handed out (read.file, read.agent_file) is served, for an hour, and never its hidden
  // files (.env, .git). One outside what's shared serves only the files opened alone there (`only`): a thread's
  // screenshots, all in one temp folder, each keep theirs.
  const peeks = new Map(); // "via|root" -> { root, via, open, streams, d, only, until }
  function allowPeek(root, via, extra = {}) {
    const now = Date.now();
    for (const [k, p] of peeks) if (p.until < now) peeks.delete(k);
    const only = extra.only ? new Set([...(peeks.get(`${via}|${root}`)?.only || []), extra.only]) : null;
    peeks.set(`${via}|${root}`, { root, via, ...extra, ...(only ? { only } : {}), until: now + 60 * 60e3 });
  }
  const PEEK_PIECE = 8 * 1024 * 1024;
  // A whole text file a peek serves (a page, its stylesheet, a JSON file it loads) goes up as bytes, which the uplink
  // doesn't read: its secrets are replaced here (redact.mjs). A piece of one (what plays) isn't text.
  const cleanBytes = (buf) => {
    if (gate.settings().redact === false || buf.length > 4 * 1024 * 1024 || buf.subarray(0, 8000).includes(0)) return buf;
    const text = buf.toString("utf8");
    const out = redact(text);
    return out === text ? buf : Buffer.from(out);
  };
  const byteRange = (header, size) => {
    const m = /^bytes=(\d*)-(\d*)$/.exec(header || "");
    if (!m || (!m[1] && !m[2])) return null;
    const start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    return start <= end && start < size ? { start, end } : "unsatisfiable";
  };
  // One file in a peeked folder: { status, type?, headers, data (base64) }, a piece at a time for what plays.
  reads["read.peek"] = async ({ root, path: rel0, via = "", range = null }) => {
    const p = peeks.get(`${via}|${root}`);
    if (!p || p.until < Date.now()) return no(404, "This link has run out. Open the file again.");
    const rel = path.normalize(String(rel0 || ""));
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.split(path.sep).some((part) => part.startsWith(".")) || secretFileRefusal(rel)) return no(404, "Not found");
    if (p.open) {
      const posix = rel.split(path.sep).join("/");
      if (p.streams && playsAs(rel) && p.d?.stream) return streamed(() => (p.via.startsWith("ws:") ? p.d.workspaceStream(p.via.slice(3), path.posix.join(p.root, posix), { range }) : p.d.stream(state.sessions[p.via], path.posix.join(p.root, posix), { range })));
      const g = await p.open(path.posix.join(p.root, posix)).catch(() => null);
      const buf = g?.bytes || (typeof g?.text === "string" ? Buffer.from(g.text) : null);
      if (!buf) return no(404, "Not found");
      return { status: 200, headers: {}, data: cleanBytes(buf).toString("base64") };
    }
    // And what it is once links are followed: a link with an ordinary name to a secret file isn't served either.
    const full = realOr(path.join(p.root, rel));
    if (!full || !inside(full, p.root) || (p.only && !p.only.has(full)) || secretFileRefusal(full) || !fs.statSync(full).isFile()) return no(404, "Not found");
    const size = fs.statSync(full).size;
    const r = byteRange(range, size);
    if (r === "unsatisfiable") return { status: 416, headers: { "content-range": `bytes */${size}` }, data: "" };
    const want = r || (playsAs(full) && size > PEEK_PIECE ? { start: 0, end: PEEK_PIECE - 1 } : { start: 0, end: size - 1 });
    const end = Math.min(want.end, want.start + PEEK_PIECE - 1, size - 1);
    const buf = Buffer.alloc(Math.max(0, end - want.start + 1));
    const fd = fs.openSync(full, "r");
    fs.readSync(fd, buf, 0, buf.length, want.start);
    fs.closeSync(fd);
    const partial = !!r || end < size - 1;
    return { status: partial ? 206 : 200, headers: { "accept-ranges": "bytes", ...(partial ? { "content-range": `bytes ${want.start}-${end}/${size}` } : {}) }, data: (partial ? buf : cleanBytes(buf)).toString("base64") };
  };
  // What a driver hands over a piece at a time, as one piece: { status, type, headers, data }.
  async function streamed(open) {
    let up;
    try {
      up = await open();
    } catch (e) {
      return no(e.status || 502, e.message);
    }
    const headers = {};
    for (const h of ["content-range", "accept-ranges", "content-length"]) if (up.headers.get(h)) headers[h] = up.headers.get(h);
    const buf = Buffer.from(await up.arrayBuffer());
    return { status: up.status, type: up.headers.get("content-type"), headers, data: buf.toString("base64") };
  }

  /* ---------- what a session changed ---------- */

  // Whether another session worked in the same folder between two times. Then what a command changed while it
  // ran may have been the other one's, so only what it names counts.
  function crowded(s, from, to) {
    const dir = s.root || s.cwd;
    return !!dir && Object.values(state.sessions).some((o) => o.id !== s.id && (o.root || o.cwd) === dir && o.started <= to && (!o.ended || o.ended >= from));
  }

  // A post's edits and commits, from its transcript or its driver; for a Codex Cloud task, its diff.
  async function editsOf(s) {
    if (s.cloud === "codex") {
      const diff = await cloud.codexDiff(s.session_id);
      return { cloud: parseUnified(diff), edits: [], commits: [], turn: 0 };
    }
    if (s.cloud) return null;
    const drv = driverOf(s);
    const d = drv ? await drv.steps(s.id).catch(() => null) : transcripts.digest(s);
    if (!d) return null;
    const edits = (d.edits || []).filter((e) => e.kind !== "command" || e.claimed || !crowded(s, e.from || e.at, e.at));
    return { edits, commits: d.commits || [], turn: d.turn || 0, disk: !drv || drv.localFiles !== false };
  }

  // The files a scope of a post changed: "all", a turn ("3"), or a step ("s:<id>").
  function scoped(s, ed, scope) {
    if (ed.cloud) return ed.cloud.map((f) => ({ path: f.path, kind: f.kind === "rename" ? "edit" : f.kind, ...sizeOf(f.hunks), edits: 1, exact: true, by: "edit", ...(f.binary ? { nodiff: true } : {}), hunks: f.hunks }));
    const match = scope === "all" ? () => true : scope.startsWith("s:") ? (e) => e.step === scope.slice(2) : (e) => e.turn === Number(scope);
    return changes.changes(s.id, ed.edits, s, scope, match, ed.disk);
  }
  const scopeOf = (q, fallback = "all") => {
    const v = String(q.get("turn") || q.get("scope") || fallback);
    return v === "all" || v === "auto" || /^\d+$/.test(v) ? v : fallback;
  };
  const withoutHunks = ({ hunks, abs, ...f }) => f;
  const withHunks = ({ abs, hunks, ...f }) => ({ ...f, ...capped(hunks) });

  // The commits a session made in the scope: ones a commit command's output named, or made while it ran.
  const commitCache = new Map(); // cwd -> { at, since, list }
  async function commitsOf(s, ed, scope) {
    const runs = ed.commits.filter((c) => scope === "all" || (scope.startsWith("s:") ? c.step === scope.slice(2) : c.turn === Number(scope)));
    if (!runs.length || !s.cwd) return [];
    const since = new Date(Date.parse(runs[0].from) - 60e3).toISOString();
    let c = commitCache.get(s.cwd);
    if (!c || Date.now() - c.at > 5000 || c.since > since) {
      c = { at: Date.now(), since, list: await commitsSince(s.cwd, since) };
      commitCache.set(s.cwd, c);
    }
    const mine = c.list.filter((x) => runs.some((r) => (r.sha && x.sha.startsWith(r.sha)) || (x.at >= Date.parse(r.from) - 2000 && x.at <= Date.parse(r.to) + 2000)));
    return mine.map((x) => ({ sha: x.sha, short: x.sha.slice(0, 7), subject: x.subject, at: new Date(x.at).toISOString(), files: x.files, add: x.add, del: x.del }));
  }
  // What a post changed: its files with their sizes, totals, and its commits. `scope`: a turn ("3"), `all` for
  // the whole session, `auto` (the default) for the turn it's on while it has one that changed something.
  reads["read.changes"] = async ({ post, scope: asked = "auto" }) => {
    const s = state.sessions[post];
    if (!s) return no(404, "No such thread");
    const ed = await editsOf(s).catch(() => null);
    if (!ed) return { scope: "all", latest: 0, turns: 0, files: [], totals: { files: 0, add: 0, del: 0 }, commits: [] };
    const latest = ed.turn;
    const turns = new Set(ed.edits.map((e) => e.turn)).size;
    const latestHas = totals(scoped(s, ed, String(latest))).files > 0;
    let scope = /^(all|auto|\d+)$/.test(asked) ? asked : "auto";
    if (scope === "auto") scope = s.state !== "done" && latestHas && turns > 1 ? String(latest) : "all";
    const files = scoped(s, ed, scope);
    return { scope, latest, latest_has: latestHas, turns, files: files.map(withoutHunks), totals: totals(files), commits: await commitsOf(s, ed, scope).catch(() => []) };
  };
  // One file's change in a scope, with its hunks.
  reads["read.change_file"] = async ({ post, path: file, scope = "all" }) => {
    const s = state.sessions[post];
    if (!s) return no(404, "No such thread");
    const ed = await editsOf(s).catch(() => null);
    const f = ed && scoped(s, ed, /^(all|\d+)$/.test(scope) ? scope : "all").find((x) => x.path === file);
    return f ? withHunks(f) : no(404, "It didn't change that file.");
  };
  // What one step changed: an edit's file, a command's files, or what a subagent changed.
  reads["read.step_diff"] = async ({ post, step }) => {
    const s = state.sessions[post];
    if (!s) return no(404, "No such thread");
    const ed = await editsOf(s).catch(() => null);
    return { files: ed && !ed.cloud ? scoped(s, ed, `s:${step}`).map(withHunks) : [] };
  };
  // One of the session's commits, with its change.
  reads["read.commit"] = async ({ post, sha }) => {
    const s = state.sessions[post];
    if (!s) return no(404, "No such thread");
    const ed = await editsOf(s).catch(() => null);
    const c = ed && !ed.cloud && /^[0-9a-f]{7,40}$/.test(sha) ? (await commitsOf(s, ed, "all")).find((x) => x.sha.startsWith(sha)) : null;
    if (!c) return no(404, "It didn't make that commit.");
    let text;
    try {
      text = await showCommit(s.cwd, c.sha);
    } catch (e) {
      return no(500, `Couldn't read the commit: ${e.message}`);
    }
    const files = parseUnified(text).map((f) => ({ path: f.path, kind: f.kind === "rename" ? "edit" : f.kind, ...sizeOf(f.hunks), ...(f.binary ? { nodiff: true } : {}), ...capped(f.hunks) }));
    return { ...c, files };
  };
  reads["read.cloud_diff"] = async ({ post }) => {
    const s = state.sessions[post];
    if (!s || s.cloud !== "codex") return no(404, "No such Codex Cloud task");
    return { diff: await cloud.codexDiff(s.session_id) };
  };

  // When a turn ends having changed files, the post says so: "Changed 3 files, +40 −8". Once per turn, after the
  // transcript (followed once a second) has caught up.
  async function reportTurn(post) {
    const s = state.sessions[post];
    if (!s || s.cloud) return;
    const ed = await editsOf(s).catch(() => null);
    if (!ed?.edits.length) return;
    const scope = String(ed.turn);
    const mine = ed.edits.filter((e) => e.turn === ed.turn);
    const files = scoped(s, ed, scope).filter((f) => !f.elsewhere);
    if (!files.length || !mine.length) return;
    const last = `${mine.at(-1).at}:${mine.at(-1).path}`;
    if ((state.sessions[post]?.updates || []).some((u) => u.changes?.last === last)) return;
    const t = totals(files);
    const what = files.length === 1 ? files[0].path : `${files.length} files`;
    // How far it reaches (reach.mjs): the repo by folder, with what imports what it changed.
    const reach = await reachIn(s.cwd, files).catch((e) => (log(`couldn't work out how far ${s.label || post}'s change reaches: ${e.message}`), null));
    // Its files as tiles on the page, each as wide as its change: the biggest 16.
    const tiles = [...files].sort((a, b) => (b.add || 0) + (b.del || 0) - ((a.add || 0) + (a.del || 0))).slice(0, 16).map((f) => ({ path: String(f.path).slice(0, 200), add: f.add || 0, del: f.del || 0 }));
    commit({ t: "session.update", post, text: `Changed ${what}${sizeText(t)}`, changes: { turn: ed.turn, ...t, last, tiles, ...(reach ? { reach } : {}) } });
  }
  // git in a folder, for reach.mjs: its output, "" when it found nothing (git grep's exit code 1).
  const gitOut = (cwd) => (args) =>
    new Promise((resolve, reject) => execFile("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 15000, maxBuffer: 64 << 20 }, (err, out) => (err && err.code !== 1 ? reject(err) : resolve(out || ""))));
  async function reachIn(cwd, files) {
    if (!cwd || !files.some((f) => f.abs)) return null;
    const root = String(await gitOut(cwd)(["rev-parse", "--show-toplevel"])).trim();
    // Its files as the repo has them, through symlinks (/var is /private/var on a Mac).
    const real = (p) => {
      try {
        return fs.realpathSync(p);
      } catch {
        return p;
      }
    };
    return root ? reachOf({ files: files.map((f) => ({ ...f, abs: f.abs && real(f.abs) })), root: real(root), git: gitOut(root) }) : null;
  }

  /* ---------- a post's work, up to the server (work.mjs) ---------- */

  const changesSent = new Map(); // post -> when what it changed was last worked out while it worked
  // Bytes kept on the server, by their sha256: the sha, or null when the server can't be reached now.
  async function blobPut(buf, type) {
    if (!uplink?.blobPut) return null;
    try {
      return await uplink.blobPut(buf, type);
    } catch (e) {
      log(`couldn't send a file's bytes to the server: ${e.message}`);
      return null;
    }
  }
  // Files a month old that its server has go from here (file-keep.mjs): a minute after it connects, and every few
  // hours after that.
  const fileKeep = createFileKeep({ store, filesDir: FILES_DIR, blobPut, log });
  let fileSweeps = null;
  function sweepFiles(ms = 60e3) {
    const go = () => fileKeep.sweep().catch((e) => log(`files: ${e.message}`));
    setTimeout(go, ms).unref?.();
    fileSweeps ||= setInterval(go, 6 * 3600e3);
    fileSweeps.unref?.();
  }
  // What a post changed, by scope: everything, each turn that changed something, and each step that did.
  async function changesOf(s) {
    const ed = await editsOf(s);
    if (!ed) return null;
    if (ed.cloud) {
      const files = scoped(s, ed, "all");
      return { scopes: { all: { files: files.map(withHunks), totals: totals(files), commits: [] } }, meta: { latest: 0, latest_has: false, turns: 0 } };
    }
    const scopes = {};
    const turnsWith = [...new Set(ed.edits.map((e) => e.turn))];
    for (const scope of ["all", ...turnsWith.map(String)]) {
      const files = scoped(s, ed, scope);
      scopes[scope] = { files: files.map(withHunks), totals: totals(files), commits: await commitsOf(s, ed, scope).catch(() => []) };
    }
    for (const id of new Set(ed.edits.map((e) => e.step).filter(Boolean))) scopes[`s:${id}`] = { files: scoped(s, ed, `s:${id}`).map(withHunks) };
    const latest = ed.turn;
    return { scopes, meta: { latest, latest_has: totals(scoped(s, ed, String(latest))).files > 0, turns: turnsWith.length } };
  }
  const work = createWork({
    store,
    historyFrom,
    stepsOf: async (s) => {
      const d = driverOf(s) ? await driverOf(s).steps(s.id).catch(() => null) : transcripts.digest(s);
      return d ? { steps: d.steps || [], plan: d.plan ?? null, turn: d.turn ?? 0 } : null;
    },
    imagesOf: async (s, step) => (driverOf(s) ? (driverOf(s).images ? await driverOf(s).images(s, step) : []) : transcripts.images(s, step)),
    changesOf,
    blobPut: async (buf, type) => {
      const sha = await blobPut(buf, type);
      if (!sha) throw new Error("the server can't be reached");
      return sha;
    },
    log,
  });

  /* ---------- commands: what the person did on the page ---------- */

  // Files you sent with a message or a start: kept on the server, fetched here into this machine's files folder,
  // and named to the agent by their path here. Each keeps its upload's id. -> [file id]
  async function fetchFiles(list = [], post = null, more = { pending: true }) {
    const ids = [];
    for (const ref of list) {
      if (!fileOf(state, ref.id)) {
        const buf = await fetchBlob(ref);
        const name = safeName(ref.name);
        commit({ t: "file.add", fid: ref.id, post, from: "human", name, title: name, size: buf.length, stored: storeFile(buf, name), blob: ref.sha || null, ...more });
      }
      ids.push(ref.id);
    }
    return ids;
  }
  async function fetchBlob(ref) {
    if (!uplink?.blob) throw Object.assign(new Error("this machine can't fetch files from its server"), { status: 502 });
    return uplink.blob(ref);
  }

  // A message from you, with any files you attached. On an ended post, it resumes the conversation; while that
  // session is still starting, more messages wait for it.
  // `routine`: a routine's run, sent to its thread (from the server's scheduler, routines.mjs).
  // `queue`: while its turn runs, it waits in the post's queue for the turn to end (releaseNext), setting nothing
  // aside; once it's done, it goes now ({ went: true }).
  // `command`: a slash command's name, when that's what you wrote (`text` is the command as typed), for a thread that
  // runs them from here; elsewhere it goes as words.
  commands["post.deliver"] = async ({ post, text = "", files: refs = [], bare = false, note = null, routine = null, queue = false, command = null }, c = null) => {
    const s = state.sessions[post];
    if (!s) return no(404, "No such thread");
    // From someone its owner lets operate it: its agent reads who, before their words (and again if it's sent again).
    const user = operatorOf(c);
    const typed = !!command && text.startsWith(`/${command}`) && /^(\s|$)/.test(text.slice(command.length + 1));
    if (command && (!typed || !commandsWhere(s) || refs.length)) command = null;
    if (s.cloud === "codex") return no(409, "Codex Cloud takes replies on its own page.");
    // A file on its own, sent to the post: it reaches the session as a file, and shows on the post as yours.
    if (bare) {
      if (s.state === "done") return no(409, "This thread has ended.");
      setAside(post);
      const [fid] = await fetchFiles(refs.slice(0, 1), post, {});
      if (fid) commit({ t: "message.add", post, from: "human", via: "dash", text: "", file_id: fid });
      return { fid };
    }
    const blocked = driverOf(s)?.replyBlocked(s);
    if (blocked) return no(409, blocked);
    const files = await fetchFiles(refs, post);
    if (!text && !files.length) return no(400, "Write something, or attach a file.");
    // An ended Claude Code session resumes with your message. A driver's session picks it up by itself.
    if (s.state === "done" && !driverOf(s) && !s.cloud && !resuming(s)) return resume(s, text, files, command ? null : note, routine, command, user);
    // A command waits for the turn to end whichever way it was sent: it never goes into a turn that's running (Claude
    // Code's and Codex's; OpenClaw queues one itself).
    const between = command && (commandsWhere(s) === "claude" || !!driverOf(s)?.commandsWait);
    const waits = ((queue || between) && s.busy && !s.cloud) || (queue && goingNow(s));
    if (!routine && !waits) setAside(post);
    // `note`: what the pages and widgets it names showed, which its agent gets with it (the thread keeps what you wrote).
    commit({ t: "message.add", post, from: "human", via: "dash", text, files, ...(note && !command ? { note } : {}), ...(routine ? { routine } : {}), ...(waits ? { queue: true } : {}), ...(command ? { command } : {}), ...(user ? { user, intro: operatorLine(user) } : {}) });
    if (waits) return { held: true };
    if (queue) return { went: true };
    // One idle in a terminal with nothing to wake it (no channel, a plugin or Claude Code without the Wake hook)
    // gets it only once someone types there.
    if (driverOf(s) || s.cloud || s.channel || !idleNow(post) || wakeable(post)) return {};
    if (!claude.info(s.session_id)) await claude.refresh().catch(() => {});
    if (!claude.background(s.session_id)) return { stuck: "terminal" };
    return {};
  };
  // A message of yours that couldn't be delivered: sent again, as it was kept here, or deleted.
  const failedMessage = (post, mid) => conversationOf(state, post).find((m) => m.id === mid && m.from === "human");
  commands["post.resend"] = async ({ post, mid }) => {
    const s = state.sessions[post];
    const m = s && failedMessage(post, mid);
    if (!m) return no(404, "No such message");
    if (!m.failed) return no(409, "It was delivered.");
    // An ended Claude Code session only takes a message by resuming, with one written to it.
    if (s.state === "done" && !driverOf(s) && !s.cloud) return no(409, "This thread has ended. Write to it again to resume it.");
    commit({ t: "message.retry", post, mid });
    return {};
  };
  commands["post.discard"] = async ({ post, mid }) => {
    const m = failedMessage(post, mid);
    if (!m) return no(404, "No such message");
    if (!m.failed) return no(409, "It was delivered, so it stays.");
    commit({ t: "message.drop", post, mids: [mid] });
    return {};
  };
  // Retry, on a thread an API error cut off: picked up now rather than at its next try, whatever the error (a usage
  // limit that has reset, one tried MAX_PICKUPS times already). The tries it has left by itself stay as they were.
  // Not while Claude's API doesn't answer from here: it would be cut off the same way.
  commands["post.pickup"] = async ({ post }) => {
    const s = state.sessions[post];
    if (!s) return no(404, "No such thread");
    // Going again already, or about to (a message of yours wakes it).
    if (!s.failed || s.busy || waking.has(post) || starting(s) || store.pending(post).some((o) => o.event.type !== "permission")) return {};
    if (!claude.info(s.session_id)) await claude.refresh().catch(() => {});
    if (!resumable(s)) return no(409, s.asleep || claude.background(s.session_id) ? "agentbook can't pick this one up. Write to it to pick it up." : "It's in a terminal. Write to it there to pick it up.");
    if (sleeping.has(post)) return no(409, "It's being put to sleep. Try again in a moment.");
    const c = cut.get(post) || { step: 0, pickups: 0 };
    if (!(await apiAnswers())) return no(503, `Claude's API still doesn't answer from ${MACHINE}. ${c.timer ? "agentbook keeps trying by itself." : "Try again once it does."}`);
    if (waking.has(post)) return {}; // its next try picked it up meanwhile
    clearTimeout(c.timer);
    Object.assign(c, { timer: null, at: null });
    cut.set(post, c);
    try {
      await carryOn(s, c, `agentbook: an API error cut your last turn off (${s.failed.text || s.failed.error}). Your thread's Retry was pressed on agentbook, so carry on where you left off.`);
      return {};
    } catch (e) {
      if (pickable(s)) cutOff(post, false);
      else dropCut(post);
      return no(500, `It couldn't be picked up: ${e.message}`);
    }
  };
  // Claude Code signed in again, from a thread's Login expired card: its link to sign in to claude.ai with ("start"),
  // then the code claude.ai showed you ("code"), which picks up the threads an expired login cut off.
  commands["claude.login"] = async ({ step, code }) => (step === "code" ? signin.code(code) : signin.start());
  // Its queue: one sent now or dropped (Edit puts it back in your box, Remove), or all of it paused, going again,
  // or cleared.
  commands["post.queue"] = async ({ post, op, mid = null }) => {
    const s = state.sessions[post];
    if (!s) return no(404, "No such thread");
    const queue = queueOf(post);
    if (op === "pause") {
      if (queue.length && s.queue_paused !== "you") commit({ t: "session.paused", post, paused: "you" });
      return {};
    }
    if (op === "resume") {
      if (s.queue_paused) commit({ t: "session.paused", post, paused: null });
      return {};
    }
    if (op === "clear") {
      if (queue.length) commit({ t: "message.drop", post, mids: queue.map((m) => m.id) });
      return {};
    }
    const m = queue.find((x) => x.id === mid);
    if (!m) return no(409, "It isn't queued any more: it went in already.");
    if (op === "drop") {
      commit({ t: "message.drop", post, mids: [m.id] });
      return {};
    }
    return sendQueued(s, m);
  };
  // Something to tell a post that isn't a message: the answer to a question the server asked on it (a routine's OK).
  commands["post.notify"] = async ({ post, event }) => {
    if (!state.sessions[post]) return no(404, "No such thread");
    commit({ t: "event.deliver", post, event });
    return {};
  };
  // The passkeys this machine is to take signed commands from, as its person turns signing on for it (its gate let
  // them in only while it keeps none), and a change of them, signed by one it keeps (its gate checked it).
  commands["keys.pin"] = async ({ pin }) => {
    let keys;
    try {
      keys = pinOf(pin);
    } catch (e) {
      return no(400, e.message);
    }
    gate.importKeys(keys);
    await keysSaid();
    return { pinned: keys.keys.length };
  };
  commands["keys.change"] = async ({ change }) => {
    const r = gate.applyKeysChange(change);
    await keysSaid();
    return r;
  };
  // Who else may operate one of its agents, as its gate checked it.
  commands["operators.change"] = async ({ change }) => {
    const r = gate.applyOperatorsChange(change);
    await keysSaid();
    return r;
  };
  // Someone this machine's owner lets operate one of its agents, when a command is theirs rather than the owner's (the
  // gate let only what they may do through), and what its agent is told of it with their words: made here, from who
  // the command says it's from (signed, on a machine that keeps keys), never from what the server says.
  const operatorOf = (c) => (c?.by && owner?.username && c.by !== owner.username ? c.by : null);
  const operatorLine = (user) => `This is from @${user}, not from ${owner?.username || "your owner"}: ${owner?.username || "your owner"} lets @${user} operate you on agentbook, so they message you and start threads with you as ${owner?.username || "your owner"} does.`;
  // The keys it keeps now reach the server before its answer does, so the page shows them as it hears back.
  async function keysSaid() {
    pageChanged();
    await uplink?.flush();
  }
  // Your answer to one of its questions: an option, words, a file, or skipping it.
  commands["post.answer"] = async ({ post, qid, value = null, skip = false, archived = false, user = null, file = null }) => {
    const q = state.questions.find((x) => x.id === qid && x.post === post);
    if (!q) return no(404, "No such question");
    if (q.answered) return no(409, "Already answered");
    // Its thread was archived: closed unanswered, and its agent hears why, as a skip.
    if (archived) commit({ t: "question.answer", qid, value: null, by: "archived" });
    else if (skip) commit({ t: "question.answer", qid, value: null, by: "skipped" });
    else if (file) {
      const [fid] = await fetchFiles([file], q.post, { silent: true });
      const f = state.files.find((x) => x.id === fid);
      commit({ t: "question.answer", qid, value: f.name, by: "human", file_id: fid, file: { name: f.name, size: f.size, path: path.join(FILES_DIR, f.stored) } });
    } else commit({ t: "question.answer", qid, value: str(value, 2000), by: "human", user });
    return {};
  };
  // Stop what a session is doing, as Esc does in its terminal: its turn is cancelled and it waits for your
  // next message. A background Claude Code session is interrupted through `claude attach`, a driver's turn
  // through its driver.
  commands["post.stop"] = async ({ post, force = false }) => {
    const s = state.sessions[post];
    if (!s) return no(404, "No such thread");
    if (s.cloud) return no(409, "It runs in the cloud. Stop it there.");
    // Stopping says "wait for me": its queue holds rather than starting the next thing as the turn ends (and lets
    // go again if nothing stopped).
    const pausing = queueOf(post).length && !s.queue_paused;
    if (pausing) commit({ t: "session.paused", post, paused: "stopped" });
    const r = await (force ? forceStop(s) : stopTurn(s, post));
    if (pausing && r.error) commit({ t: "session.paused", post, paused: null });
    return r;
  };
  // Stop that Esc didn't do (its process hangs, or it never answers): Claude Code ends the process, even a frozen one,
  // within seconds. The thread stays: it's asleep, and what you've sent it or send next resumes it with its conversation.
  async function forceStop(s) {
    if (driverOf(s)) return no(409, "Only a Claude Code thread can be force-stopped.");
    try {
      await claude.refresh();
      if (!claude.background(s.session_id)) return no(409, "It's running in a terminal. Press Esc there.");
      if (!claude.running(claude.info(s.session_id))) return no(409, "It isn't working on anything right now.");
      await putToSleep(s, "Force-stopped");
      return {};
    } catch (e) {
      return no(500, e.message);
    }
  }
  async function stopTurn(s, post) {
    try {
      if (driverOf(s)) {
        await driverOf(s).stop(post);
        return {};
      }
      if (!claude.background(s.session_id)) return no(409, "It's running in a terminal. Press Esc there.");
      await claude.refresh();
      const a = claude.info(s.session_id);
      // Not because Claude Code says busy: it says that of a session with a shell running, long after its turn ended.
      const working = s.busy || s.state !== "idle" || a?.status === "waiting";
      if (!working || !claude.running(a)) return no(409, "It isn't working on anything right now.");
      const seen = await claude.interrupt(s.session_id);
      saveInterrupt(s);
      if (!turnGoing(state.sessions[post])) return {};
      if (!seen) {
        await claude.refresh();
        if (claude.info(s.session_id)?.status === "busy") return no(500, "It didn't stop. Force stop ends its process and keeps the thread.", { force: true });
      }
      // Claude Code runs no hook for an interrupted turn, so the post says so itself.
      turnStopped(post);
      return {};
    } catch (e) {
      return no(500, e.message, driverOf(s) ? {} : { force: true });
    }
  }
  // Switch a session's model, from its next turn. Codex takes it with the next turn it starts; a Claude Code
  // session in the background or one that ended switches when agentbook wakes or resumes it. A session in a
  // terminal or in the cloud picks its model there. An empty model undoes the pick.
  commands["post.model"] = async ({ post, model: asked }) => {
    const s = state.sessions[post];
    if (!s) return no(404, "No such thread");
    const model = modelName(asked);
    if (asked && !model) return no(400, "That isn't a model name.");
    if (s.cloud) return no(409, "It runs in the cloud. Pick its model there.");
    if (driverOf(s) && !driverOf(s).switchesModel) return no(409, `agentbook can't switch ${driverOf(s).name}'s model.`);
    if (!driverOf(s)) {
      if (state.agents[s.agent]?.kind !== "claude-code" || !s.session_id) return no(409, "agentbook can't switch this session's model.");
      if (s.state !== "done" && !claude.background(s.session_id)) return no(409, "It's open in a terminal. Switch it there with /model.");
    }
    commit({ t: "session.model", post, model: model || null });
    return { model: model || null };
  };
  // Archiving a background session puts it to sleep, whatever it has going. Writing to it wakes it.
  commands["post.sleep"] = async ({ post, reason }) => {
    const s = state.sessions[post];
    if (!s) return no(404, "No such thread");
    if (!claude.info(s.session_id)) await claude.refresh();
    const stops = s.state !== "done" && !driverOf(s) && !s.cloud && claude.background(s.session_id) && claude.running(claude.info(s.session_id));
    if (stops) await putToSleep(s, reason || "Archived").catch((e) => log(`couldn't stop ${s.label}: ${e.message}`));
    // Nor does agentbook pick it up after an API error, though it was asleep already.
    if (s.failed) commit({ t: "session.status", post, failed: null });
    dropCut(post);
    return { slept: !!stops && !!state.sessions[post].asleep };
  };
  // Apply a Codex Cloud task's change in a local checkout of its repository.
  commands["post.apply"] = async ({ post, root: asked }) => {
    const s = state.sessions[post];
    if (!s) return no(404, "No such thread");
    if (s.cloud !== "codex") return no(409, "Only Codex Cloud tasks apply.");
    const root = asked || publicState(state).folders.find((f) => f.name === s.repo)?.root;
    const cmd = `codex cloud apply ${s.session_id}`;
    if (!root) return no(409, `No checkout of ${s.repo || "its repository"} here. Run ${cmd} in one.`, { cmd });
    try {
      return { root, output: await cloud.codexApply(s.session_id, root) };
    } catch (e) {
      return no(500, e.message, { cmd });
    }
  };
  // Pull from the cloud. A Codex Cloud task comes here with its status and its change. A Claude Code cloud
  // session teleports into `root`, a checkout of its repository, in a terminal: Claude Code checks out its
  // branch there (asking before it stashes anything) and copies its conversation into a session here, whose
  // post takes the place of this launch's.
  commands["cloud.pull"] = async ({ ref, root = "", visibility, lid: given }) => {
    if (given && !/^[\w-]{1,100}$/.test(given)) return no(400, "That isn't a launch id.");
    if (codexTaskId(ref)) {
      brought.add(codexTaskId(ref));
      try {
        return { id: await cloud.pullCodexTask(ref), kind: "codex" };
      } catch (e) {
        return no(400, e.message);
      }
    }
    const id = cloudSessionId(ref);
    if (!id) return no(400, "Paste a claude.ai/code session link, or a Codex Cloud task link (chatgpt.com/codex/tasks/…).");
    if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) return no(400, "Pick the project to teleport it into: a checkout of its repository.");
    const lid = given || launchId();
    commit({ t: "launch.add", lid, agent: "claude", root, prompt: `https://claude.ai/code/${id}`, teleport: id, visibility: isLevel(visibility) ? visibility : undefined });
    const cmd = cloud.teleportCommand(id, { root, lid });
    try {
      await openTerminal(cmd);
      return { kind: "claude", lid, opened: true, cmd };
    } catch (e) {
      return { kind: "claude", lid, opened: false, cmd, error: e.message };
    }
  };

  // The kinds of agent this machine runs, for the Add agents page: each one agentbook finds by itself, and
  // whether it found it.
  reads["read.runtimes"] = async () => {
    const cx = codex.status();
    const hm = hermes.status();
    const ds = dsh.status();
    const oc = openclaw.connection();
    const claudeOk = claude.listedAt() > 0;
    const off = (k) => process.env[k] === "0";
    const openclawRow = () => {
      if (off("AGENTBOOK_OPENCLAW")) return { ok: false, status: "Off", detail: "AGENTBOOK_OPENCLAW=0 leaves it off." };
      if (oc.mode === "gateway") {
        if (oc.state === "connected") return { ok: true, status: "Connected", detail: `Through its gateway at ${oc.url}.` };
        if (oc.state === "pairing") return { ok: false, status: "Waiting for approval", detail: "Approve agentbook on the gateway, below." };
        return { ok: false, status: "Can't reach it", detail: oc.error || `Connecting to ${oc.url}…` };
      }
      if (oc.connected) return { ok: true, status: "Connected", detail: "Through this machine's openclaw command." };
      return { ok: false, status: "Not connected", detail: "Connect to its gateway below, on this machine or another one." };
    };
    const remoteRow = (d, flag, where) => {
      const st = d.status();
      if (off(flag)) return { remote: true, ok: false, status: "Off", detail: `${flag}=0 leaves it off.` };
      if (st.error) return { remote: true, ok: false, status: "Can't reach it", detail: st.error };
      return { remote: true, ok: st.connected, status: st.connected ? "Connected" : "Not connected", detail: st.connected ? where : `${where} Add its key below.` };
    };
    return {
      machine: MACHINE,
      runtimes: [
        { kind: "claude-code", agent: "claude", name: "Claude Code", ok: claudeOk, status: claudeOk ? "Ready" : off("AGENTBOOK_CLAUDE_CODE") ? "Off" : "Not found", detail: claudeOk ? "Threads you start from agentbook run in the background, under Claude Code's own supervisor." : off("AGENTBOOK_CLAUDE_CODE") ? "AGENTBOOK_CLAUDE_CODE=0 leaves it off." : "Install Claude Code here (the claude command), then restart agentbook." },
        { kind: "codex", agent: "codex", name: "Codex", ok: !!cx.connected, status: cx.connected ? "Connected" : off("AGENTBOOK_CODEX") ? "Off" : !cx.enabled ? "Not found" : "Can't reach it", detail: cx.connected ? "Through Codex's own daemon, the one the Codex apps use." : !cx.enabled ? "Install Codex here (the codex command), then restart agentbook." : cx.error || "Starting Codex's daemon…" },
        { kind: "hermes", agent: "hermes", name: "Hermes", ok: !!hm.connected, status: hm.connected ? "Ready" : off("AGENTBOOK_HERMES") ? "Off" : "Not found", detail: hm.connected ? "Its conversations come from its database as threads, and agentbook steers them through hermes acp." : "Install Hermes Agent here. Once you've used it, it shows up as an agent." },
        { kind: "openclaw", agent: "openclaw", name: "OpenClaw", ...openclawRow() },
        { kind: "dsh", agent: "dsh", name: "DeepSeek Harness", ok: ds.enabled && (ds.installed || ds.plugin.length > 0), status: !ds.enabled ? "Off" : ds.installed || ds.plugin.length ? "Ready" : "Not found", detail: !ds.enabled ? "AGENTBOOK_DSH=0 leaves it off." : ds.installed || ds.plugin.length ? `${ds.startsIn ? `Threads you start from agentbook run in ${ds.startsIn === "web" ? "DeepSeek's web app" : ds.startsIn === "desktop" ? "DeepSeek's desktop app" : `dsh (${ds.startsIn})`}, on its models and keys${ds.installed ? ", and in dsh's ACP server while it's closed" : ""}.` : ds.installed ? "Threads you start from agentbook run in dsh's ACP server, with the DeepSeek key you gave dsh." : "agentbook can't start threads in it: it doesn't find the dsh command."} ${ds.plugin.length ? `Its sessions in ${[...new Set(ds.plugin.map((p) => p.profile))].join(" and ")} are threads too (agentbook's plugin ${ds.plugin[0].version || ""}).` : `For the sessions you start in dsh's own apps too: dsh plugin --profile web add file:${path.join(PLUGIN_ROOT, "dsh")}, then restart dsh.`}${ds.error ? ` Last time: ${ds.error}` : ""}` : "Install DeepSeek Harness here (the dsh command, on Node 24), then restart agentbook." },
        { kind: "claude-agent", agent: "claude-agent", name: "Claude Agent", ...remoteRow(managed, "AGENTBOOK_MANAGED", "Runs in Anthropic's cloud, on your API key.") },
        { kind: "devin", agent: "devin", name: "Devin", ...remoteRow(devin, "AGENTBOOK_DEVIN", "Runs in Devin's cloud, on your API key.") },
      ],
    };
  };
  // This machine's connection to an OpenClaw gateway on another machine: a setup code, or its address and token
  // (which never come back out), and whether the gateway has approved agentbook as a device yet.
  reads["read.openclaw"] = async () => openclaw.connection();
  // Agents that run on their vendor's computers, connected on this machine with a key that stays here.
  const remoteDrivers = { "claude-agent": managed, devin };
  reads["read.remote"] = async () => Object.fromEntries(Object.entries(remoteDrivers).map(([k, d]) => [k, d.connection()]));
  commands["remote.connect"] = async (b) => {
    const d = remoteDrivers[b.vendor];
    if (!d) return no(400, "That isn't an agent agentbook can connect.");
    if (b.budget && !(Number(b.budget) > 0)) return no(400, "A thread's budget is an amount in dollars.");
    if (!d.status().enabled) return no(409, `${d.name} is off on this machine.`);
    try {
      return { connection: await d.configure({ disconnect: !!b.disconnect, key: str(b.key, 500).trim() || undefined, org: str(b.org, 200).trim() || undefined, github_token: b.github_token === undefined ? undefined : str(b.github_token, 500).trim(), budget: b.budget === undefined ? undefined : str(b.budget, 20).trim() }) };
    } catch (e) {
      return no(e.status === 401 || e.status === 403 ? 403 : 502, e.message);
    }
  };
  commands["openclaw.pair"] = async (b) => {
    if (b.disconnect) return openclaw.configure(null);
    if (b.setup_code != null) {
      let setup;
      try {
        setup = decodeSetupCode(str(b.setup_code, 8000));
      } catch (e) {
        return no(400, e.message);
      }
      return openclaw.configure(setup);
    }
    // "https://gateway.example" means its WebSocket, "wss://gateway.example".
    const raw = str(b.url, 500).trim().replace(/^http(s?):\/\//, "ws$1://");
    let url;
    try {
      url = new URL(raw);
    } catch {}
    if (!url || !["ws:", "wss:"].includes(url.protocol)) return no(400, "That isn't a gateway address: it starts with wss:// (or ws:// on a private network).");
    const token = str(b.token, 500).trim();
    const password = str(b.password, 500);
    if (!token && !password) return no(400, "Paste the gateway's token (or its password).");
    return openclaw.configure({ url: url.toString().replace(/\/$/, ""), token: token || undefined, password: token ? undefined : password });
  };

  const MIME = {
    ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
    ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8", ".csv": "text/plain; charset=utf-8",
    ".json": "application/json", ".log": "text/plain; charset=utf-8", ".diff": "text/plain; charset=utf-8", ".patch": "text/plain; charset=utf-8",
    ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
    ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".ogg": "audio/ogg",
  };
  // A file its driver keeps elsewhere (`remote`: a picture, video, sound or file in an OpenClaw message) comes
  // from there the first time it's wanted, and stays here like any other. It's written to <stored>.part as it
  // comes, so a video plays from what's here while the rest comes, and it takes as long as it takes: only
  // MEDIA_STALL_MS with nothing coming stops it (a gateway far away is slow, not stuck). One that stopped is
  // asked for again the next time it's opened, or when its driver connects again (refetch).
  // -> its fetch, { done (a promise of its path), part, got, size, ended, error }, or null once it's here.
  const MEDIA_STALL_MS = Number(process.env.AGENTBOOK_MEDIA_STALL_MS || 60e3);
  const fetching = new Map(); // file id -> its fetch
  const unfetched = new Set(); // file ids whose fetch stopped short
  function remoteFile(f) {
    const p = path.join(FILES_DIR, f.stored);
    if (fs.existsSync(p)) return null;
    if (fetching.has(f.id)) return fetching.get(f.id);
    const s = state.sessions[f.post];
    const d = driverOf(s);
    const job = { part: `${p}.part`, got: 0, size: null, ended: false, error: null, waiters: new Set() };
    const wake = () => job.waiters.forEach((w) => w());
    job.done = (async () => {
      if (!f.remote || !d?.media) throw Object.assign(new Error("File is gone"), { status: 410 });
      const ctl = new AbortController();
      const res = await d.media(s, f.remote, { signal: ctl.signal });
      const fd = fs.openSync(job.part, "w");
      const idle = setTimeout(() => ctl.abort(new Error("OpenClaw stopped sending this file.")), MEDIA_STALL_MS);
      try {
        job.size = Number(res.headers.get("content-length")) || null;
        wake();
        for await (const chunk of res.body || []) {
          idle.refresh();
          fs.writeSync(fd, chunk);
          job.got += chunk.length;
          wake();
        }
      } finally {
        clearTimeout(idle);
        fs.closeSync(fd);
      }
      fs.renameSync(job.part, p);
      unfetched.delete(f.id);
      if (f.size !== job.got) commit({ t: "file.size", fid: f.id, size: job.got });
      return p;
    })()
      .catch((e) => {
        fs.rmSync(job.part, { force: true });
        if (e.status !== 413) log(`file ${f.id} (${f.name}): ${e.message}`);
        if (e.status === 413) streamOnly.add(f.id);
        else if (e.status !== 404 && e.status !== 410) unfetched.add(f.id);
        job.error = e;
        throw e;
      })
      .finally(() => {
        job.ended = true;
        fetching.delete(f.id);
        wake();
      });
    job.done.catch(() => {}); // whoever waits on it hears how it went; nobody has to
    fetching.set(f.id, job);
    return job;
  }
  function fetchFile(fid) {
    const f = fileOf(state, fid);
    if (f) remoteFile(f)?.done.catch(() => {}); // remoteFile logs how it failed
  }
  // Until `ready()`, its fetch ends, or `ms` pass.
  const fetched = (job, ready, ms) =>
    new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        job.waiters.delete(check);
        resolve();
      };
      const check = () => (ready() || job.ended) && done();
      const t = setTimeout(done, ms);
      job.waiters.add(check);
      check();
    });
  // A read waits for what it asks for no longer than this (the server gives up on it at two minutes).
  const MEDIA_WAIT_MS = 90e3;
  const MEDIA_AHEAD = Number(process.env.AGENTBOOK_MEDIA_AHEAD || 4 << 20); // a piece asked for further on than this from what's come comes on its own
  const MEDIA_SOME = Number(process.env.AGENTBOOK_MEDIA_SOME || 1 << 20); // what a piece waits for while the rest comes, so a player isn't sent crumbs
  // A piece from `r.start` of a file here, `has` bytes of it so far (all of it, but for one still coming), no
  // more than PEEK_PIECE; or all of it, unasked (`r` null) and no bigger than that.
  function piece(f, p, size, r, has = size) {
    const want = r || { start: 0, end: size - 1 };
    const end = Math.min(want.end, want.start + PEEK_PIECE - 1, has - 1);
    const buf = Buffer.alloc(Math.max(0, end - want.start + 1));
    if (buf.length) {
      const fd = fs.openSync(p, "r");
      fs.readSync(fd, buf, 0, buf.length, want.start);
      fs.closeSync(fd);
    }
    const partial = !!r || end < size - 1;
    return { status: partial ? 206 : 200, name: f.name, size, headers: { "accept-ranges": "bytes", ...(partial ? { "content-range": `bytes ${want.start}-${end}/${size}` } : {}) }, data: buf.toString("base64"), nocache: true };
  }
  // What's asked of a driver for a piece: PEEK_PIECE of it at most, as a player asks for all the rest ("bytes=0-").
  const pieceOf = (range) => {
    const m = /^bytes=(\d+)-(\d*)$/.exec(range || "bytes=0-");
    if (!m) return range;
    const start = Number(m[1]);
    return `bytes=${start}-${Math.min(m[2] ? Number(m[2]) : Infinity, start + PEEK_PIECE - 1)}`;
  };
  // A file of a post, for the server to keep or hand over: { name, type, size, data (base64) }, a piece at a time
  // (`range`) for one too big to send whole. One its driver keeps elsewhere comes from there: while it comes, a
  // piece asked for (as a player asks) is what's come of it, or, further on than it's got to, that piece from
  // there; one asked for whole waits for all of it.
  reads["read.media"] = async ({ post, file, range = null }) => {
    const f = fileOf(state, file);
    if (!f || (post && f.post !== post)) return no(404, "Unknown file");
    const p = path.join(FILES_DIR, f.stored || "-");
    const s = state.sessions[f.post];
    if (!fs.existsSync(p)) {
      if (!f.remote) return no(410, "File is gone");
      const d = driverOf(s);
      const job = streamOnly.has(f.id) ? null : remoteFile(f);
      if (job) {
        const until = Date.now() + MEDIA_WAIT_MS;
        const left = () => Math.max(0, until - Date.now());
        await fetched(job, () => range && job.size, left());
        const r = range && job.size && !job.ended ? byteRange(range, job.size) : null;
        if (r === "unsatisfiable") return { status: 416, headers: { "content-range": `bytes */${job.size}` }, data: "", name: f.name, nocache: true };
        if (r && r.start <= job.got + MEDIA_AHEAD) {
          const some = Math.min(r.end, r.start + MEDIA_SOME - 1);
          await fetched(job, () => job.got > some, left());
          if (!fs.existsSync(p) && fs.existsSync(job.part) && job.got > r.start) return piece(f, job.part, job.size, r, job.got);
        } else if (!r) await fetched(job, () => false, left());
        if (!fs.existsSync(p)) {
          if (job.error && job.error.status !== 413) return no(job.error.status || 502, job.error.message);
          if (!r && !job.error) return no(504, "This file is still coming from OpenClaw. Try again in a moment.");
        }
      }
      if (!fs.existsSync(p)) {
        if (!d?.streamMedia) return no(502, "This file can't come from where it is a piece at a time.");
        const r = await streamed(() => d.streamMedia(s, f.remote, { range: pieceOf(range) }));
        if (r.error) log(`file ${f.id} (${f.name}): ${r.error}`);
        const total = Number(/\/(\d+)$/.exec(r.headers?.["content-range"] || "")?.[1]) || (r.status === 200 ? Number(r.headers?.["content-length"]) : 0);
        if (streamOnly.has(f.id) && total && f.size !== total) commit({ t: "file.size", fid: f.id, size: total });
        return { ...r, name: f.name, nocache: true };
      }
    }
    const size = fs.statSync(p).size;
    const r = byteRange(range, size);
    if (r === "unsatisfiable") return { status: 416, headers: { "content-range": `bytes */${size}` }, data: "", name: f.name, nocache: true };
    return piece(f, p, size, r);
  };
  const streamOnly = new Set(); // file ids

  // --- WIP: a project's branches with work that isn't on main yet (see wip.mjs) ---
  // A project is a folder sessions ran in, so these reach no other folder on the machine.
  function wipAsked(root, branch) {
    if (!root || !Object.values(state.sessions).some((s) => s.root === root)) return no(404, `agentbook has no project at ${root || "that folder"}.`);
    if (!branch || branch.length > 250 || /^-|\.\.|[\s~^:?*[\\]|@\{/.test(branch)) return no(400, "That isn't a branch name.");
    return null;
  }
  reads["read.wip"] = async ({ root, branch }) => {
    const bad = wipAsked(root, branch);
    if (bad) return bad;
    try {
      const d = await wipDetail(root, branch, MACHINE);
      wipOf(root, true);
      return d;
    } catch (e) {
      return no(e.status || 400, e.message);
    }
  };
  reads["read.wip_diff"] = async ({ root, branch, path: file = "", scope }) => {
    const bad = wipAsked(root, branch);
    if (bad) return bad;
    try {
      return await wipDiff(root, branch, file, scope === "uncommitted" ? "uncommitted" : "committed");
    } catch (e) {
      return no(e.status || 400, e.message);
    }
  };
  // Clean up: remove a WIP's worktree and delete its branch, once everything on it is on main and nobody's
  // working there (wip.mjs refuses the rest).
  commands["wip.clean"] = async ({ root, branch }) => {
    const bad = wipAsked(root, branch);
    if (bad) return bad;
    const busy = Object.values(state.sessions).find((s) => s.root === root && s.branch === branch && !s.asleep && (s.state === "working" || s.state === "waiting"));
    if (busy) return no(409, `${busy.label} is working on ${branch}.`);
    try {
      const done = await cleanUp(root, branch);
      log(`wip: cleaned up ${branch} in ${root}${done.removed ? `, removing ${done.removed}` : ""}`);
      for (const s of Object.values(state.sessions)) if (s.root === root && s.branch === branch) commit({ t: "session.landed", post: s.id, branch });
      wipOf(root, true);
      branchesOf(root, true);
      return done;
    } catch (e) {
      return no(e.status || 400, e.message);
    }
  };
  // Discard: the same, with what isn't on main or isn't committed thrown away. Its posts don't say it landed.
  commands["wip.discard"] = async ({ root, branch, sha }) => {
    const bad = wipAsked(root, branch);
    if (bad) return bad;
    const busy = Object.values(state.sessions).find((s) => s.root === root && s.branch === branch && !s.asleep && (s.state === "working" || s.state === "waiting"));
    if (busy) return no(409, `${busy.label} is working on ${branch}.`);
    try {
      const done = await discard(root, branch, sha);
      log(`wip: discarded ${branch} (at ${done.sha}) in ${root}${done.removed ? `, removing ${done.removed}` : ""}`);
      wipOf(root, true);
      branchesOf(root, true);
      return done;
    } catch (e) {
      return no(e.status || 400, e.message);
    }
  };
  // A repo none of the person's machines has a checkout of, cloned here when they add it as a workspace.
  commands["workspace.clone"] = async ({ url: asked }) => {
    const url = cloneUrl(str(asked, 1000));
    if (!url) return no(400, "That isn't a repo agentbook can clone.");
    const job = cloneHere(url);
    return { dir: job.dir, exists: !!job.exists, cloning: !job.exists };
  };
  // What Claude Code says when it won't start a background session in a folder it doesn't trust, and the folder it
  // names (the one it checked: the session's own, for one it wakes).
  const UNTRUSTED = /^Workspace not trusted\. Run `claude` in /;
  const untrustedIn = (error) => /^Workspace not trusted\. Run `claude` in (\/.+?) once and accept/.exec(error || "")?.[1] || null;
  // A thread whose session Claude Code wouldn't wake or resume because it didn't trust its folder (`l`, the start that
  // failed), once it does: your messages that couldn't wake it go again, as Try again sends them, or what you wrote
  // to an ended one resumes it. (The server puts the start that failed away once this answers, so it's done once.)
  const trustingFor = new Set(); // posts whose folder is being trusted
  async function trustAndWake(l, dir) {
    const s = state.sessions[l.post];
    if (!s || !UNTRUSTED.test(l.error || "")) return no(409, "It didn't fail for want of trust.");
    if ((untrustedIn(l.error) || l.root) !== dir) return no(409, "That thread is in another folder.");
    if (trustingFor.has(s.id)) return {};
    trustingFor.add(s.id);
    try {
      if (await trustFolder(dir)) log(`trusted ${dir} in Claude Code`);
      const stuck = conversationOf(state, s.id).filter((m) => m.from === "human" && /Workspace not trusted\. Run `claude` in /.test(m.failed?.error || ""));
      for (const m of stuck) commit({ t: "message.retry", post: s.id, mid: m.id });
      // Claude Code stopped an idle one before it refused to wake it: asleep now (syncRuntime), so it's woken.
      if (stuck.length) await syncRuntime().then(deliverQueued);
      else if (s.state === "done") return await resume(s, l.prompt, l.files, null, l.routine);
      return { post: s.id };
    } catch (e) {
      return no(500, e.message);
    } finally {
      trustingFor.delete(s.id);
    }
  }
  // A folder you added as a workspace, trusted in Claude Code (see trustHere). With `lid`: a Claude Code session
  // that couldn't start because Claude Code didn't trust its folder, started again there once it does, with what
  // it was given. It's the same start, so its card goes back to starting. Or a thread's (trustAndWake).
  commands["folder.trust"] = async ({ path: dir, lid }) => {
    const l = lid ? state.launches[lid] : null;
    if (lid && !l) return no(404, "No such start.");
    if (l?.resume && l.post) return trustAndWake(l, dir);
    if (l && (!UNTRUSTED.test(l.error || "") || !l.named || l.resume || l.teleport || l.archived)) return no(409, "It didn't fail for want of trust.");
    if (l && (l.cwd || l.root) !== dir) return no(409, "That start was in another folder.");
    if (l) commit({ t: "launch.retry", lid: l.id }); // first, so a second tap finds it starting
    try {
      if (await trustFolder(dir)) log(`trusted ${dir} in Claude Code`);
      if (!l) return { trusted: dir };
      commit({ t: "launch.started", lid: l.id, session: (await claude.start({ cwd: dir, prompt: withFiles(l.prompt, l.files), lid: l.id, model: l.model || undefined, effort: l.effort || undefined })).id });
      return { lid: l.id };
    } catch (e) {
      if (l) commit({ t: "launch.fail", lid: l.id, error: e.message });
      return no(500, e.message);
    }
  };

  // This machine's folders, for picking one to add: the folders in `path` (your home folder to start), each
  // marked when it's a git checkout, with the repo it's a clone of. Above the folders the machine shares, only
  // the ones that lead to them (the gate's `only`).
  reads["read.folders"] = async ({ path: asked0 }, c = {}) => {
    const home = os.homedir();
    const asked = asked0 || home;
    if (!path.isAbsolute(asked)) return no(400, "A folder's path starts at /.");
    let dir;
    let entries;
    try {
      dir = fs.realpathSync(asked);
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return no(e.code === "ENOENT" ? 404 : 403, e.code === "ENOENT" ? `There's no folder ${asked} on ${MACHINE}.` : `agentbook can't read ${asked}.`);
    }
    const names = entries.filter((e) => !e.name.startsWith(".") && (e.isDirectory() || (e.isSymbolicLink() && isDir(path.join(dir, e.name)))) && (!c.only || c.only.includes(e.name))).map((e) => e.name);
    names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    const folders = names.slice(0, MAX_FOLDERS).map((name) => {
      const p = path.join(dir, name);
      return { name, path: p, git: fs.existsSync(path.join(p, ".git")), ...(remoteOf(p) || {}) };
    });
    return { machine: MACHINE, home, path: dir, parent: dir === path.parse(dir).root ? null : path.dirname(dir), git: fs.existsSync(path.join(dir, ".git")), ...(remoteOf(dir) || {}), folders, more: Math.max(0, names.length - MAX_FOLDERS) };
  };
  // A checkout's branches, for one the composer has no list of (no session has worked in it yet).
  reads["read.branches"] = async ({ root = "" }) => {
    if (!path.isAbsolute(root)) return no(400, "A folder's path starts at /.");
    const b = await branches(root).catch(() => null);
    return b || no(404, `${root} isn't a git checkout.`);
  };

  // Writing on an agent's wall starts a session in the background. Files you attach are named, with their
  // paths, at the end of its first prompt. A driver whose agents may run on another machine (OpenClaw's), where
  // a path here means nothing, sends the files themselves (`sendsFiles`).
  const ATTACHED = "Attached files:";
  function withFiles(prompt, files) {
    const attached = files.map((fid) => state.files.find((f) => f.id === fid)).map((f) => `- ${f.name}: ${path.join(FILES_DIR, f.stored)}`);
    return [prompt, attached.length ? `${ATTACHED}\n${attached.join("\n")}` : ""].filter(Boolean).join("\n\n");
  }
  const filesOf = (ids) => ids.map((fid) => state.files.find((f) => f.id === fid)).filter(Boolean).map((f) => ({ id: f.id, name: f.name, size: f.size, path: path.join(FILES_DIR, f.stored) }));
  const launchId = () => `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  // A launch's session, started in `cwd`: by its agent's driver, or by Claude Code in the background. `note`: what
  // the pages and widgets its prompt names showed (from the server); `dirs`: folders it can write besides its own
  // (its group's).
  // `intro`: who it's from, before what they wrote, when that isn't its owner (an operator).
  async function startSession({ agent, cwd, prompt, note = null, intro = null, files = [], lid, model, effort, dirs = [], repo }) {
    const said = [intro, prompt, note].filter(Boolean).join("\n\n");
    const drv = driverOfAgent(agent);
    // Its thread shows what you wrote (`shown`), not the note it was told with it.
    if (drv?.sendsFiles) await drv.start({ agent, cwd, prompt: said, ...(note || intro ? { shown: prompt } : {}), files: filesOf(files), lid, model, effort, dirs, repo });
    else if (drv) await drv.start({ agent, cwd, prompt: withFiles(said, files), ...(note || intro ? { shown: withFiles(prompt, files) } : {}), lid, model, effort, dirs });
    else commit({ t: "launch.started", lid, session: (await claude.start({ cwd, prompt: withFiles(said, files), lid, model, effort, dirs })).id });
  }
  // A Claude Code start the server sent again: what it said the first time, once the session Claude Code started
  // then is found (it saves it within seconds), or null to start it now, when Claude Code never got it. One with a
  // driver's agent, cloning or making its worktree goes as before.
  async function startedAgain(l, note, user = null) {
    const said = { lid: l.id, cwd: l.cwd || l.root, ...(l.branch ? { branch: l.branch } : {}) };
    if (l.error) return no(500, l.error);
    if (driverOfAgent(l.agent) || l.cloning || l.step) return null;
    if (l.post || l.session) return said;
    const prompt = withFiles([user ? operatorLine(user) : null, l.prompt, note].filter(Boolean).join("\n\n"), l.files || []);
    for (let i = 0; i < 30; i++) {
      const session = claude.startedWith({ prompt, cwd: l.cwd || l.root, since: Date.parse(l.at) });
      if (session) {
        commit({ t: "launch.started", lid: l.id, session });
        return said;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  }
  // A thread for a page that names no folder works in one of its own here, in agentbook's folder (not one of the
  // person's, so there's nothing for the gate to check), and Claude Code trusts it, as trustHere allows.
  const PAGES_DIR = path.join(CLI_HOME, "pages");
  function pageDir(page) {
    const dir = path.join(PAGES_DIR, String(page).replace(/[^\w.-]+/g, "_").slice(0, 80) || "new");
    fs.mkdirSync(dir, { recursive: true });
    trustHere(fs.realpathSync(dir));
    return dir;
  }
  // The same for a thread started from a comment on a note that names no folder.
  const NOTES_DIR = path.join(CLI_HOME, "notes");
  function noteDir(note) {
    const dir = path.join(NOTES_DIR, String(note).replace(/[^\w.-]+/g, "_").slice(0, 80) || "note");
    fs.mkdirSync(dir, { recursive: true });
    trustHere(fs.realpathSync(dir));
    return dir;
  }
  // And for a thread you started yourself whose agents have no workspace to work in.
  const TALKS_DIR = path.join(CLI_HOME, "threads");
  function talkDir(talk) {
    const dir = path.join(TALKS_DIR, String(talk).replace(/[^\w.-]+/g, "_").slice(0, 80) || "thread");
    fs.mkdirSync(dir, { recursive: true });
    trustHere(fs.realpathSync(dir));
    return dir;
  }
  // And for a thread started with no workspace: a temp folder of its own, which the system clears in time. mkdtemp
  // makes it for this user alone, even in a /tmp others share. Threads show their folder's name, so that's `temp`.
  async function tempDir() {
    const dir = path.join(fs.mkdtempSync(TEMP_DIRS), "temp");
    fs.mkdirSync(dir);
    await trustHere(dir);
    return dir;
  }
  // A start making its worktree when agentbook-cli stopped never finishes it: it says so, rather than showing it
  // making it forever.
  const WORKTREE_STEP = "Making its worktree";
  for (const l of Object.values(state.launches)) if (l.step === WORKTREE_STEP && !l.post && !l.error) commit({ t: "launch.fail", lid: l.id, error: "agentbook-cli stopped while it made this one's worktree. Start it again." });
  // Worktrees being checked out, by repo and branch, with the starts waiting for each: one on the same branch
  // meanwhile waits for it too, rather than starting in a half-made folder. Each hears how far it got.
  const making = new Map(); // `${real root}\t${branch}` -> { cwd, done, lids }
  const makingKey = (root, branch) => `${fs.realpathSync(root)}\t${branch}`;
  function makeWorktree(root, cwd, branch, make) {
    const m = { cwd, lids: new Set() };
    const key = makingKey(root, branch);
    let said = 0;
    m.done = make(({ done, total }) => {
      if (Date.now() - said < 1000) return;
      said = Date.now();
      for (const lid of m.lids) commit({ t: "launch.step", lid, step: WORKTREE_STEP, done, total });
    }).finally(() => making.delete(key));
    making.set(key, m);
    return m;
  }
  commands["post.start"] = async (b, c = null) => {
    const prompt = str(b.prompt, 12000).trim();
    if (!prompt) return no(400, "Say what the agent should do.");
    // One its owner lets someone else start (an operator): its agent is told who, before
    // their words, and the start says whose they are.
    const user = operatorOf(c);
    if (!/^[\w-]{1,100}$/.test(String(b.lid || ""))) return no(400, "That isn't a launch id.");
    const agent = b.agent;
    // The group it's started in: it joins it when it starts (the server sees to that), and can write its folder.
    const group = b.group && /^[a-z0-9-]{1,80}$/.test(b.group) ? b.group : undefined;
    // Folders it can write besides its own: its group's.
    const dirs = group ? [groupDir(group)] : [];
    // The root its gate checked, whole; a page's, or a folder of the page's own; or, with none, its group's folder.
    let root = str(b.root, 2000) || (b.page ? (b.page !== "new" && b.page_root) || pageDir(b.page) : "") || (b.for_note ? noteDir(b.for_note) : "") || (b.for_talk ? talkDir(b.for_talk) : "") || (group ? dirs[0] : "");
    // With none of those it starts in a temp folder, if it works in folders at all. Not when it's to be on a branch, or
    // when it's an operator's: they start threads only where its agent's work.
    const inTemp = !root && !b.clone && driverOfAgent(agent)?.folders !== false;
    if (inTemp && (user || b.worktree || b.branch || b.base || b.fresh)) return no(400, "Pick a folder for it to work in.");
    const lid = b.lid;
    // The server sends a start again when agentbook-cli stopped before answering it (restarted while `claude --bg`
    // ran): the session Claude Code started for it then is its own, rather than a second one.
    if (state.launches[lid]) {
      const again = await startedAgain(state.launches[lid], b.note || null, user);
      if (again) return again;
    }
    if (inTemp) root = state.launches[lid]?.root || (await tempDir());
    const files = await fetchFiles(b.files || []);
    const model = modelName(b.model) || undefined;
    if (b.model && !model) return no(400, "That isn't a model name.");
    const effort = b.effort ? str(b.effort, 20).trim() : undefined;
    if (effort && !/^[a-z]+$/.test(effort)) return no(400, "That isn't an effort level.");
    const task = str(b.task, 500).trim() || undefined;
    const page = b.page || undefined;
    // A routine's run: marked with the routine it's from.
    const routine = b.routine || undefined;
    // The repo a thread that doesn't run here clones where it runs (Claude Agent, Devin): nothing's cloned here.
    const repo = driverOfAgent(agent)?.repos ? str(b.repo, 1000).trim() || undefined : undefined;
    const start = (cwd) => startSession({ agent, cwd, prompt, note: b.note || null, intro: user ? operatorLine(user) : null, files, lid, model, effort, dirs, repo });
    // A repo this machine has no checkout of: clone it into the clone folder (or use a checkout of it already
    // there, or wait for the clone adding its workspace started), then start in it. A clone can take minutes, so
    // this answers right away and the post shows it cloning, then starting, or why it couldn't.
    if (b.clone) {
      const url = cloneUrl(str(b.clone, 1000));
      if (!url) return no(400, "That isn't a repo agentbook can clone.");
      const job = cloneHere(url);
      commit({ t: "launch.add", lid, agent, root: job.dir, prompt, files, named: !driverOfAgent(agent), cloning: job.exists ? null : job.repo, task, page, model, effort, routine, group, noted: b.note ? true : undefined });
      (async () => {
        const dir = await job.promise;
        if (!job.exists) commit({ t: "launch.cloned", lid });
        await start(dir);
      })().catch((e) => commit({ t: "launch.fail", lid, error: e.message }));
      return { lid, cwd: job.dir, cloning: !job.exists };
    }
    // Another branch, a new one, or a worktree: get the checkout ready first, refusing to switch a folder that
    // has uncommitted changes or another session working in it.
    const worktree = !!b.worktree;
    const branch = str(b.branch, 200).trim();
    const base = str(b.base, 200).trim();
    let cwd = root;
    let onBranch;
    let make;
    const refresh = () => {
      gitCache.delete(root);
      branchesOf(root, true);
    };
    let m = worktree && branch && !base ? making.get(makingKey(root, branch)) : null;
    if (m) {
      cwd = m.cwd;
      onBranch = branch;
    } else if (worktree || branch || base || b.fresh) {
      const inFolder = (s) => s.cwd && (s.cwd === root || s.cwd.startsWith(root + path.sep)) && !s.cwd.startsWith(path.join(root, ".claude", "worktrees") + path.sep);
      const busy = Object.values(state.sessions).find((s) => s.state !== "done" && !s.cloud && inFolder(s))?.label;
      try {
        ({ cwd, branch: onBranch, make } = await prepare({ root, worktree, branch, fresh: !!b.fresh, base, prompt, busy }));
      } catch (e) {
        return no(409, e.message);
      } finally {
        refresh();
      }
    }
    // Who can see it, when it differs from its agent: kept on the post once its session registers.
    const visibility = isLevel(b.visibility) ? b.visibility : undefined;
    if (make) m = makeWorktree(root, cwd, onBranch, make);
    commit({ t: "launch.add", lid, agent, root, cwd: cwd !== root ? cwd : undefined, branch: onBranch, prompt, files, named: !driverOfAgent(agent), visibility, task, page, model, effort, routine, group, noted: b.note ? true : undefined, ...(m ? { step: WORKTREE_STEP } : {}), ...(user ? { user } : {}) });
    // A new worktree is checked out first, which can take minutes (in a 62k-file monorepo), so this answers right
    // away and the post shows how far the checkout got (every second or so), then starting, or why it couldn't.
    if (m) {
      m.lids.add(lid);
      (async () => {
        try {
          await m.done;
        } finally {
          m.lids.delete(lid);
          refresh();
        }
        commit({ t: "launch.step", lid, step: null });
        await start(cwd);
      })().catch((e) => commit({ t: "launch.fail", lid, error: e.message }));
      return { lid, cwd, branch: onBranch, making: true };
    }
    try {
      await start(cwd);
      return { lid, cwd, branch: onBranch };
    } catch (e) {
      commit({ t: "launch.fail", lid, error: e.message });
      return no(500, e.message);
    }
  };

  // Writing on an ended post resumes its conversation in the background (`claude --resume … --bg`), with your
  // message as its next prompt. Its post comes back when it starts.
  const RESUME_WAIT_MS = 90e3;
  const resuming = (s) => Object.values(state.launches).some((l) => l.resume && l.post === s.id && !l.error && s.launch !== l.id && Date.now() - Date.parse(l.at) < RESUME_WAIT_MS);

  // Claude Code finds a conversation by the folder it started in, whose path names the transcript's folder
  // (~/.claude/projects/-Users-me-dev-app), so resume there.
  function resumeDir(s) {
    const dirs = [s.cwd, s.root].filter(Boolean);
    const project = s.transcript && path.basename(path.dirname(s.transcript));
    return dirs.find((d) => d.replace(/[^a-zA-Z0-9]/g, "-") === project) || dirs[0];
  }
  // A thread whose folder is gone (another tool cleaned up its worktree) can't be resumed: Claude Code finds a
  // conversation by the folder it started in. Its page asks what can put the folder back when it opens it, ended
  // (git.mjs goneFolder), and puts it back with a button (folder.restore).
  // Its agent hears what happened with the next message it gets.
  const restored = new Map(); // post -> what its agent is told as it's resumed
  reads["read.folder"] = async ({ post }) => {
    const s = state.sessions[post];
    if (!s) return no(404, "No such thread");
    if (s.cloud || driverOf(s) || !s.session_id) return { gone: null };
    const gone = await goneFolder({ cwd: resumeDir(s), root: s.root, branch: s.branch });
    // The thread working in the folder that has its branch, to go to instead.
    const real = (p) => {
      try {
        return fs.realpathSync(p);
      } catch {
        return p;
      }
    };
    const by = gone?.taken && Object.values(state.sessions).filter((x) => x.id !== post && x.cwd && real(x.cwd) === real(gone.taken)).sort((a, b) => String(b.updated).localeCompare(String(a.updated)))[0];
    return { gone: by ? { ...gone, taken_by: by.id, taken_label: by.label || null } : gone };
  };
  commands["folder.restore"] = async ({ post, way }) => {
    const s = state.sessions[post];
    if (!s) return no(404, "No such thread");
    if (s.cloud || driverOf(s) || !s.session_id) return no(409, "agentbook doesn't keep this thread's folder.");
    const cwd = resumeDir(s);
    let g;
    try {
      g = await restoreFolder({ cwd, root: s.root, branch: s.branch, way });
    } catch (e) {
      return no(500, `Couldn't put its folder back: ${e.message}`);
    }
    if (!g) return {}; // back already
    // The thread reads it short, with ~ for home; its agent gets whole paths.
    const home = os.homedir();
    const what = (full) => {
      const at = full || !cwd.startsWith(home + path.sep) ? cwd : `~${cwd.slice(home.length)}`;
      if (way === "empty") return `made an empty folder at ${at}, where its folder was`;
      if (way === "copy") return `put a copy of ${s.branch} (${g.sha}, not on the branch${full ? `: ${g.taken} has it` : ""}) at ${at}, where its folder was`;
      if (way === "base") return `checked out ${g.base} (${g.sha}) at ${at}, where its folder was: ${s.branch} is gone`;
      return `checked out ${s.branch} (${g.sha}${g.remote ? ", from origin" : ""}) at ${at}, where its folder was`;
    };
    commit({ t: "message.add", post, from: "agent", via: "dash", text: `agentbook ${what(false)}.` });
    restored.set(post, `agentbook: your folder was deleted after your last turn, and agentbook ${what(true)}. ${way === "empty" ? "It's empty: your repo's files aren't in it." : "Anything you hadn't committed there is gone."}`);
    return {};
  };

  async function resume(s, text, files, note = null, routine = null, command = null, user = null) {
    if (!s.session_id || state.agents[s.agent]?.kind !== "claude-code") return no(409, "This thread has ended, and agentbook can't resume it.");
    // Claude Code resumes from the transcript, which a session writes once something is said in it (and Claude Code
    // clears out old ones): without it, `--resume` starts and then fails.
    if (s.transcript && !fs.existsSync(s.transcript)) return no(409, "Claude Code has no conversation saved for this thread, so it can't be resumed. Start a new thread instead.");
    const lid = launchId();
    const cwd = resumeDir(s);
    if (command) commandLaunches.add(lid);
    commit({ t: "launch.add", lid, agent: s.agent, root: cwd, prompt: text, files, post: s.id, resume: true, ...(routine ? { routine } : {}), ...(user ? { user } : {}) });
    try {
      // A slash command goes as it's written; what agentbook did to its folder waits for the next message.
      const back = command ? null : restored.get(s.id);
      resumed(s, await claude.resume({ sessionId: s.session_id, cwd, prompt: withFiles([user ? operatorLine(user) : null, text, note, back].filter(Boolean).join("\n\n"), files), lid, label: s.label, model: s.model_pick, dirs: extraDirs(s) }));
      if (back) restored.delete(s.id);
      commit({ t: "message.add", post: s.id, from: "human", via: "dash", text, files, resume: lid, ...(routine ? { routine } : {}), ...(command ? { command } : {}), ...(user ? { user } : {}) });
      resumes.add(lid);
      if (command) commanded.set(s.id, { name: command, bare: text.trim() === `/${command}`, at: Date.now() });
      return { lid, resumed: true };
    } catch (e) {
      commit({ t: "launch.fail", lid, error: e.message });
      return no(500, e.message);
    }
  }

  // An agent's routines and their runs: they're how it's set up, like its folders. Claude's are on claude.ai and
  // in its posts (loops), OpenClaw's are its cron jobs, Codex's the ChatGPT app's automations. A run is read from
  // its own session; Run now and Pause act on the routine.
  const gatewayError = (e, d) => no(e.status && e.status < 500 ? e.status : 502, d?.name && !e.message.startsWith(d.name) ? `${d.name}: ${e.message}` : e.message);
  const routinesDriver = (id) => {
    const d = routinesOfAgent(id);
    return state.agents[id] && d?.routines ? d : null;
  };
  reads["read.agent_routines"] = async ({ agent }) => {
    const d = routinesDriver(agent);
    if (!d) return no(404, "No such agent");
    try {
      return (await d.routines(agent)) ?? no(404, "No routines here");
    } catch (e) {
      return gatewayError(e, d);
    }
  };
  // How much of its plan's usage limits an agent has used (limits.mjs): Claude Code's on claude.ai, Codex's ChatGPT
  // plan's, the providers' its OpenClaw gateway signs in to. Hermes's aren't known.
  reads["read.agent_limits"] = async ({ agent }) => {
    const d = routinesOfAgent(agent);
    if (!state.agents[agent] || !d?.limits) return no(404, "No such agent");
    try {
      return (await d.limits(agent)) ?? no(404, "No usage limits here");
    } catch (e) {
      return gatewayError(e, d);
    }
  };
  reads["read.agent_routine"] = async ({ agent, job, offset = 0 }) => {
    const d = routinesDriver(agent);
    if (!d) return no(404, "No such agent");
    try {
      return (await d.routine(agent, job, { offset: Math.max(0, Number(offset) || 0) })) ?? no(404, "No such routine");
    } catch (e) {
      return gatewayError(e, d);
    }
  };
  reads["read.agent_routine_run"] = async ({ agent, job, session }) => {
    const d = routinesDriver(agent);
    if (!d) return no(404, "No such agent");
    try {
      return (await d.routineRun(agent, job, str(session, 500))) ?? no(404, "No such run");
    } catch (e) {
      return gatewayError(e, d);
    }
  };
  commands["routine.do"] = async ({ agent, job, action }) => {
    const d = routinesDriver(agent);
    if (!d) return no(404, "No such agent");
    try {
      const r = await d.routineDo(agent, job, action);
      return r === false ? no(404, "No such routine") : {};
    } catch (e) {
      return gatewayError(e, d);
    }
  };
  // An agent's workspace (an OpenClaw agent's own folder, on its gateway's machine): what's in it (or in one of its
  // folders, `dir`, by its path from its root), and one of its files (or folders), opened as a post's are.
  const workspaceDriver = (id) => {
    const d = driverOfAgent(id);
    return state.agents[id] && d?.workspace ? d : null;
  };
  reads["read.agent_files"] = async ({ agent, dir = "" }) => {
    const d = workspaceDriver(agent);
    if (!d) return no(404, "No such agent");
    const parts = String(dir).split("/").filter(Boolean);
    if (parts.some((p) => p === "." || p === "..")) return no(400, "Which folder?");
    try {
      const r = await d.workspace(agent, parts.join("/"));
      return r === null ? no(404, "No workspace here") : { ...r, host: d.machine?.() || null };
    } catch (e) {
      return no(e.status || 502, e.status ? e.message : `${d.name}: ${e.message}`);
    }
  };
  reads["read.agent_file"] = async ({ agent, path: asked }) => {
    const d = workspaceDriver(agent);
    if (!d) return no(404, "No such agent");
    if (!String(asked || "").trim()) return no(400, "Which file?");
    return driverFile(d, (p) => d.workspaceFile(agent, p), `ws:${agent}`, String(asked).trim(), !!d.streams?.());
  };
  // One skill's SKILL.md, when it can be found on this machine, or, for an agent on another machine (OpenClaw's,
  // on its gateway's), when its driver hands it over.
  reads["read.skill"] = async ({ agent, name, roots = [] }) => {
    const sessions = Object.values(state.sessions).filter((s) => s.agent === agent).sort((a, b) => a.started.localeCompare(b.started));
    let listed = null;
    for (const s of sessions) listed = (s.skills || []).find((k) => k.name === name) || listed;
    const d = driverOfAgent(agent);
    if (d?.localFiles === false) {
      const text = listed?.file && d.skillFile ? await d.skillFile(agent, listed.file).catch(() => null) : null;
      return text != null ? { doc: splitFrontmatter(text.slice(0, 200_000)), file: listed.file } : { doc: null, file: null };
    }
    const file = listed?.file && fs.existsSync(listed.file) ? listed.file : findSkillFile(name, [...new Set([...sessions.map((s) => s.root || s.cwd), ...roots].filter(Boolean))]);
    if (!file) return { doc: null, file: null };
    try {
      return { doc: splitFrontmatter(fs.readFileSync(file, "utf8").slice(0, 200_000)), file: file.replace(os.homedir(), "~") };
    } catch {
      return { doc: null, file: null };
    }
  };
  // Where Claude Code keeps a skill: "plugin:skill" in an installed plugin (or this one), "dir/sub:skill" in a
  // subfolder's .claude/skills, a bare name in a project's or the user's skills folder.
  function findSkillFile(name, roots) {
    const cut = name.lastIndexOf(":");
    const prefix = cut > 0 ? name.slice(0, cut) : null;
    const skill = cut > 0 ? name.slice(cut + 1) : name;
    const safe = (part) => /^[\w.-]+$/.test(part) && part !== "." && part !== "..";
    if (!safe(skill) || (prefix && !prefix.split("/").every(safe))) return null;
    const claude = path.join(os.homedir(), ".claude");
    const inDir = (dir) => path.join(dir, skill, "SKILL.md");
    const subdirs = (dir) => {
      try {
        return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name));
      } catch {
        return [];
      }
    };
    const tries = [];
    if (prefix) {
      if (prefix === "agentbook") tries.push(inDir(path.join(PLUGIN_ROOT, "skills")));
      try {
        const installed = JSON.parse(fs.readFileSync(path.join(claude, "plugins", "installed_plugins.json"), "utf8")).plugins || {};
        for (const [key, entries] of Object.entries(installed)) if (key.split("@")[0] === prefix) for (const e of entries) tries.push(inDir(path.join(e.installPath, "skills")));
      } catch {}
      for (const market of subdirs(path.join(claude, "plugins", "marketplaces"))) tries.push(inDir(path.join(market, "plugins", prefix, "skills")));
      for (const root of roots) tries.push(inDir(path.join(root, prefix, ".claude", "skills")));
    }
    for (const root of roots) tries.push(inDir(path.join(root, ".claude", "skills")));
    tries.push(inDir(path.join(claude, "skills")));
    for (const bucket of subdirs(path.join(claude, "skills", "synced"))) tries.push(inDir(bucket));
    return tries.find((f) => fs.existsSync(f)) || null;
  }

  // A SKILL.md's YAML frontmatter, enough of it for the description; the rest is markdown.
  function splitFrontmatter(text) {
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!m) return { description: "", body: text.trim() };
    const lines = m[1].split(/\r?\n/);
    let description = "";
    const i = lines.findIndex((l) => /^description:/.test(l));
    if (i >= 0) {
      const first = lines[i].replace(/^description:\s*/, "");
      const more = [];
      for (const l of lines.slice(i + 1)) {
        if (!/^\s+\S/.test(l)) break;
        more.push(l.trim());
      }
      description = (/^[>|][-+]?$/.test(first) ? more : [first, ...more]).join(" ").trim().replace(/^(["'])([\s\S]*)\1$/, "$2");
    }
    return { description, body: text.slice(m[0].length).trim() };
  }

  // A page routine's code, once, as the server asks: what it returned, unchecked (the server checks it against
  // the page and writes it), and its log.
  // A group's files as they stand on the server: its folder here is made the same (group-files.mjs).
  commands["group.sync"] = async ({ gid, files = [], archived = false }) => {
    if (!/^[a-z0-9-]{1,80}$/.test(gid)) return no(400, "That isn't a group.");
    await groupFiles.sync(gid, files, { archived });
    return {};
  };
  // The group a post is in now (null: none), as its server says.
  commands["post.group"] = async ({ post, gid = null }) => {
    if (!state.sessions[post]) return no(404, "No such thread");
    if (gid && !/^[a-z0-9-]{1,80}$/.test(gid)) return no(400, "That isn't a group.");
    commit({ t: "session.group", post, gid });
    if (gid) groupDir(gid);
    return {};
  };
  // The task that ships a post is in now (null: none), as its server says: it hears its news. (session.wip keeps
  // its name from when these were WIPs.)
  commands["post.wip"] = async ({ post, sid = null }) => {
    if (!state.sessions[post]) return no(404, "No such thread");
    if (sid && !/^k[0-9a-z]{6,18}$/.test(sid)) return no(400, "That isn't a task.");
    if ((state.sessions[post].wip || null) !== sid) commit({ t: "session.wip", post, sid });
    return {};
  };
  // The page a post's person put it on by hand (null: took it off one), as its server says: it hears so.
  commands["post.page"] = async ({ post, pid = null }) => {
    if (!state.sessions[post]) return no(404, "No such thread");
    if (pid && !/^[\w.-]{1,120}$/.test(pid)) return no(400, "That isn't a page.");
    if (state.sessions[post].paged?.page !== pid) commit({ t: "session.paged", post, pid });
    return {};
  };
  // A code block of one of a post's messages, run in its folder (runs.mjs), and one running, stopped.
  commands["post.run"] = async (args, c) => codeRuns.start(args, c?.by || null);
  commands["post.run_stop"] = async (args) => codeRuns.stop(args);
  // A routine for no page and no thread runs its commands in the home folder.
  commands["page_routine.run"] = async (args) => routineRunner.execute({ ...args, root: args.root || os.homedir() });
  // A thread's terminal, opened (or the one it has).
  commands["term.lease"] = async ({ tid }) => (terminals.renew(tid) ? {} : no(404, "No such terminal"));
  commands["term.open"] = async ({ tid, post, cols, rows }) => {
    const s = state.sessions[post];
    if (!s) return no(404, "No such thread");
    if (s.cloud) return no(409, "It runs in the cloud, so there's no folder of it here.");
    const dir = s.cwd || s.root;
    if (!dir || !fs.existsSync(dir)) return no(410, dir ? `${dir} isn't there any more.` : "It has no folder on this machine.");
    if (!uplink) return no(503, "This machine isn't logged in to a server.");
    try {
      return await terminals.start({ tid, post, cwd: dir, cols, rows });
    } catch (e) {
      return no(e.status || 500, e.message);
    }
  };

  /* ---------- the gate: what this machine lets its server make it do (gate.mjs) ---------- */

  // The threads whose folders are on this machine.
  const followed = () => Object.values(state.sessions).filter((s) => !s.cloud && !driverOf(s)?.file);
  const gate = createGate({
    home: HOME,
    // What it shares without being told: its clone folder, and the checkouts its agents worked in here.
    // (A session's root is its checkout, or the folder it ran in, as its hooks say at hello.)
    roots: () => [cloneDir(), ...followed().map((s) => s.root || s.cwd)],
    readRoots: () => [cloneDir(), ...followed().filter((s) => !retiredThread(s)).map((s) => s.root || s.cwd)],
    // A post's own folder, and the files it touched: the ones it changed, and the pictures its agent saw (a
    // screenshot it took, a picture it read), wherever they are.
    postOf: async (post) => {
      const s = state.sessions[post];
      if (!s) return null;
      if (driverOf(s)?.file) return { elsewhere: true };
      const ed = s.cloud ? null : await editsOf(s).catch(() => null);
      const base = s.cwd || s.root;
      const changed = (ed?.edits || []).map((e) => e.path).filter(Boolean).map((p) => (path.isAbsolute(p) || !base ? p : path.resolve(base, p)));
      return { dirs: [s.cwd, s.root].filter(Boolean), files: [...changed, ...(s.cloud || driverOf(s) ? [] : transcripts.pictures(s))], retired: retiredThread(s) };
    },
    // The agent a post here is of, and the folders that agent's threads here work in: an operator of it starts threads
    // only there.
    agentOf: async (post) => state.sessions[post]?.agent || null,
    agentRoots: (agent) => [...new Set(Object.values(state.sessions).filter((s) => s.agent === agent && !s.cloud && !driverOf(s)?.file).flatMap((s) => [s.root, s.cwd]).filter(Boolean))],
    report: (line) => commit({ t: "machine.audit", ...line }),
    notify: notifyHere,
    log,
    hosted,
  });
  // Once, the first time this runs here: a machine with threads has hooks that send no key yet (see keyRefused).
  if (typeof gate.settings().local_key !== "boolean") gate.agree({ local_key: !Object.keys(state.sessions).length });
  // The threads live now, whose hooks may be from before signed calls: waited for until they call with the key, end
  // or fall asleep (keyOnWhenDone). Agentbook's own drivers' threads take addresses from this one, with their key.
  if (gate.settings().local_key === false)
    for (const [proc, post] of Object.entries(state.procs)) {
      const s = state.sessions[post];
      if (s && s.state !== "done" && !s.asleep && !s.cloud && !driverOf(s)) before.add(proc);
    }
  // A command waits for an OK on this machine: a notification says so (macOS).
  function notifyHere(c) {
    if (process.platform !== "darwin" || process.env.AGENTBOOK_NOTIFY === "0") return;
    const text = `@${c.by || "someone"} wants this machine to do ${c.kind}. Run agentbook-cli approve to see it.`;
    execFile("osascript", ["-e", `display notification ${JSON.stringify(text)} with title "agentbook"`], { timeout: 8000 }, () => {});
  }

  // A command or a read from the server: through the gate (its kind, its fields, whose it is, where it reaches,
  // how often), done, and answered.
  async function onCommand(c) {
    const refused = await gate.check(c, { owner: owner?.username || null });
    if (refused) return no(refused.status, `agentbook-cli refused it: ${refused.error}`);
    const fn = commands[c.kind] || reads[c.kind];
    if (!fn) return no(501, `agentbook-cli doesn't do ${c.kind} yet`);
    return fn(c.args || {}, c);
  }

  /* ---------- this machine's own routes, on loopback ---------- */

  // Only this machine's sessions reach these: from this machine, by its own name for itself (so a web page you
  // visit can't reach them through DNS rebinding).
  const LOCAL = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
  const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
  const fromHere = (req) => LOOPBACK.has(req.socket.remoteAddress) && LOCAL.has(req.headers.host || "");
  const sessionRoute = (req, url) => isSessionRoute(req.method, url.pathname);

  // What changes something comes from a process on this machine, never a web page you visit (whose browser would
  // send it from here too): another site can't post as a session.
  function sameSite(req) {
    if (req.method === "GET" || req.method === "HEAD") return true;
    const origin = req.headers.origin;
    if (origin && origin !== "null") {
      try {
        if (new URL(origin).host !== req.headers.host) return false;
      } catch {
        return false;
      }
    } else if (origin === "null") return false;
    const site = req.headers["sec-fetch-site"];
    return !site || site === "same-origin" || site === "none";
  }

  // A request for this machine's sessions: handled (true), or not one of theirs (false).
  async function handle(req, res, url) {
    if (!sessionRoute(req, url)) return false;
    if (!sameSite(req)) {
      fail(res, 403, "agentbook only takes changes from its own page.");
      return true;
    }
    if (!fromHere(req)) {
      fail(res, 403, "That's for this machine's own sessions.");
      return true;
    }
    // A signed call: checked against its body too, and its answer proves it's from here (x-agentbook-proof).
    const auth = req.headers[AUTH_HEADER];
    if (auth) {
      if (req.method !== "GET" && req.method !== "HEAD" && !req.rawBody) {
        try {
          req.rawBody = await readBody(req, true);
        } catch (e) {
          fail(res, 413, e.message);
          return true;
        }
      }
      req.signed = signedBy(auth, req.method, req.url, req.rawBody || "");
      if (req.signed) res.setHeader(PROOF_HEADER, proofOf(localKey, req.signed.nonce));
    }
    heard(procOfCall(url), localKeyOk(req) || mcpKeyOk(url));
    if (keyRefused(req, url)) {
      fail(res, 403, "That takes this machine's key (cli/local.key), which agentbook's own hooks and tools sign with.");
      return true;
    }
    try {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        const params = Object.fromEntries(Object.entries(m.groups || {}).map(([k, v]) => [k, (() => { try { return decodeURIComponent(v); } catch { return v; } })()]));
        await r.handler(req, res, { params, query: url.searchParams });
        return true;
      }
      fail(res, 404, "No such endpoint");
    } catch (err) {
      if (!res.headersSent) fail(res, 400, err.message);
    }
    return true;
  }

  // A server that has nothing of this machine yet, or less than it had (restored from a backup): its posts' work goes
  // to it again, the last two weeks of it.
  function fresh() {
    work.reset();
    setTimeout(() => work.backfill(), 1000).unref();
  }

  // Once it's logged in: until then nothing here looks at this machine's agents (see runCli).
  function start() {
    if (started) return;
    started = true;
    // The work of the last two weeks' posts, for a server that doesn't have it yet.
    if (uplink) setTimeout(() => work.backfill(), 3000).unref();
    syncRuntime()
      .then(pickUpAll)
      .catch(() => {});
    for (const d of drivers) d.begin();
    cloud.begin();
    claudeRoutines.begin();
    groupFiles.start();
    // The threads' terminals still open from before it started, then the runs that were going in them.
    terminals
      .adopt()
      .catch((e) => log(`terminals: ${e.message}`))
      .finally(() => codeRuns.begin());
    // Agents' to-dos from before they were tasks: until they've all moved, now and every 10 minutes.
    if (state.todos.length) {
      const moving = setInterval(() => (state.todos.length ? moveTodos().catch((e) => log(`agentbook: moving to-dos: ${e.message}`)) : clearInterval(moving)), 600e3).unref();
      moveTodos().catch((e) => log(`agentbook: moving to-dos: ${e.message}`));
    }
  }
  // Agents' to-dos from before they were tasks: each becomes a task of the machine's person, on the server, as it
  // was, from its post and linked to it. What the server doesn't take waits for next time.
  let movingTodos = null; // one move at a time
  function moveTodos() {
    movingTodos ||= moveTodosNow().finally(() => (movingTodos = null));
    return movingTodos;
  }
  async function moveTodosNow() {
    for (const t of [...state.todos].sort((a, b) => a.at.localeCompare(b.at))) {
      const me = state.sessions[t.post] ? agentMe(t.post) : { post: t.post, root: null, remote: null };
      const r = await ask("POST", "/todos", { ...me, text: t.text, was: { added: t.at, done: !!t.done, done_at: t.done_at || undefined } });
      if (r.error) return log(`agentbook: couldn't move the to-dos to the server yet: ${r.error}`);
      commit({ t: "todo.remove", tid: t.id });
    }
  }

  return {
    store,
    name: MACHINE,
    handle,
    // A WebSocket: DeepSeek Harness's plugin, from a dsh process on this machine (/api/dsh/ws, drivers/dsh.mjs). A
    // page in a browser could open one too, and a browser always says which page: no page may.
    upgrade(req, socket, head) {
      const at = new URL(req.url, "http://localhost");
      if (at.pathname !== "/api/dsh/ws") return refuseWs(socket, 404, "Not here");
      if (req.headers.origin) return refuseWs(socket, 403, "Not from a page");
      if (!started) return refuseWs(socket, 409, "Not logged in");
      // Signed as a call is (for its path, with no body), so the key isn't in its address; its first message proves
      // this is agentbook-cli, before the plugin takes anything from it.
      const auth = at.searchParams.get("auth");
      const signed = auth ? signedBy(auth, "GET", at.pathname, "") : null;
      if (keyed() && !signed) return refuseWs(socket, 403, "It takes this machine's key");
      const ws = acceptWs(req, socket, head);
      if (!ws) return;
      // A dsh plugin from before signed lines: local_key waits until its line closes (keyOnWhenDone).
      if (!signed && keyWaits()) {
        keylessLines.add(socket);
        socket.once("close", () => keylessLines.delete(socket) && keyOnWhenDone());
      }
      if (signed) ws.send(JSON.stringify({ t: "proof", proof: proofOf(localKey, signed.nonce) }));
      dsh.connect(ws);
    },
    onCommand,
    fresh,
    info,
    start,
    historyFrom,
    // Its server, once it's logged in to one (it may be after it started).
    setUplink(u, url = null) {
      uplink = u;
      serverUrl = url;
      keyOnWhenDone();
      if (started) setTimeout(() => work.backfill(), 3000).unref();
    },
    // Connected to its server: agents' to-dos from before they were tasks can move there now, and what drivers
    // couldn't send up before (an agent's picture) goes.
    connected() {
      // A stop for a refused login is over, so the next one is told again.
      toldLoginLost.clear();
      // What its database kept from before the split goes, now that a server has this machine.
      try {
        forgetLeftovers({ store, home: CLI_HOME, log });
      } catch (e) {
        log(`agentbook: couldn't clear what's left from before the split: ${e.message}`);
      }
      if (state.todos.length) moveTodos().catch((e) => log(`agentbook: moving to-dos: ${e.message}`));
      sweepFiles(Number(process.env.AGENTBOOK_FILE_SWEEP_MS || 60e3));
      // Groups' folders, as they stand on the server (a machine that was off missed what changed).
      syncGroups().catch((e) => log(`agentbook: groups: ${e.message}`));
      terminals.wake();
      for (const d of drivers) d.connected?.();
    },
    // Whose machine this is, as the server says: the gate holds it to its first answer.
    setOwner(username) {
      owner = username ? { username } : null;
      gate.pin(username);
    },
    // The newest agentbook-cli, as the server says with each poll: a version number or nothing, as sessions hear it.
    setLatest(v) {
      latest = isVersion(v) ? v : null;
    },
    // Its person's settings, as the server says with each poll: Private terminals.
    setPrefs(p) {
      const next = { private_terminals: !!p?.private_terminals };
      if (next.private_terminals === !!prefs.private_terminals) return;
      prefs = next;
      log(`private terminals: ${next.private_terminals ? "on: only threads started in agentbook are on it" : "off"}`);
      // Turned off: what was kept off gets its thread at its next hook.
      if (!next.private_terminals) keptOff.clear();
      try {
        fs.mkdirSync(CLI_HOME, { recursive: true });
        fs.writeFileSync(PREFS_FILE, JSON.stringify(next));
      } catch (e) {
        log(`private terminals: couldn't keep the setting: ${e.message}`);
      }
    },
    gate,
    // What goes up to its server, its secrets replaced (redact.mjs), unless its gate.json says "redact": false.
    clean: (v) => (gate.settings().redact === false ? v : redactDeep(v)),
    flush: () => uplink?.flush(),
  };
}
