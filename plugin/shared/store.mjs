// agentbook store: the state the server works on, in memory, kept in a SQLite database (db.mjs).
// Every change is an op, and apply() is the only place state changes. Each op is written to the database
// as it's committed; the state itself is written as a checkpoint every few seconds and at exit. Starting
// up loads the checkpoint and replays the ops after it, so the state comes back exactly, including which
// events were already delivered to sessions. The database keeps every thread's whole history; memory holds
// some threads' (warm), so what reads one thread's goes through warm(), conversationOf() or fileOf().
//
// The model: an agent (Claude) has sessions, and each session is a post. A post is keyed by Claude Code's
// session id, so resuming a conversation brings back its post and /clear starts a new one. `procs` maps
// each running Claude Code process to the post it's on; hooks and the MCP server address it by process.

import { isPicture, lifeKept, lifeOf } from "./life.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, createTables, isCorrupt, leaveOpen, migrate, moveAside, transaction } from "./db.mjs";
import { applyRoutine } from "./routines.mjs";
import { mentionNote, plainMentions } from "./mentions.mjs";
import { applyPage, pageSummary, postPages } from "./pages.mjs";
import { applyGroup, groupSummary, taskNews } from "./groups.mjs";
import { applyNote } from "./notes.mjs";
import { applyGuest } from "./guests.mjs";
import { applyTalk } from "./talks.mjs";
import { applyTaskShip, rekeyShip } from "./task-ship.mjs";
import { typedPart } from "./text.mjs";
import { isLevel } from "./visibility.mjs";
import { BIRDS } from "./ids.mjs";

// The data folder, and where files are kept in it (or elsewhere, e.g. on a bigger disk).
export const HOME = process.env.AGENTBOOK_HOME || path.join(os.homedir(), ".agentbook");
// agentbook-cli's own folder in it (agentbook-server's is server/).
export const CLI_HOME = path.join(HOME, "cli");
export const FILES_DIR = process.env.AGENTBOOK_FILES || path.join(CLI_HOME, "files");
export const DB_FILE = path.join(CLI_HOME, "agentbook.db");
const CHECKPOINT_MS = Number(process.env.AGENTBOOK_CHECKPOINT_MS || 5000);
// How long a machine's log keeps an op its server has (AGENTBOOK_LOG_DAYS, a day at least): long enough that a server
// restored from a backup up to a week old gets back what it lost (uplink.mjs). Its server keeps them for good.
const ACKED_DAYS = Math.max(1, Number(process.env.AGENTBOOK_LOG_DAYS) || 7);
// `messages`: how many memory holds, of whole threads; the database keeps them all (warm, settle). The rest are
// each post's own: its results, its "changed N files" and pull request lines, its code blocks' runs.
const LIMITS = { messages: Number(process.env.AGENTBOOK_MEMORY_MESSAGES || 8000), updates: 40, changes: 8, prs: 12, runs: 40 };
// A thread's history: what of it can be out of memory, its rows kept (db.mjs's `paged`).
const HISTORY = ["questions", "files", "messages"];
// The ops that change a thread's history, which need all of it in memory.
const HISTORY_OPS = new Set(["message.add", "message.release", "message.files", "message.text", "message.drop", "message.fail", "message.retry", "question.ask", "file.add"]);
const FILE_OPS = new Set(["file.remove", "file.blob", "file.size"]);
// A thread used within this stays in memory.
const QUIET_MS = 3600e3;
// Ticking a task or a to-do, or unticking it. `done_by` says who: "you", or "agent" when an agent ticked it
// from its post (`by`, its key, which is `done_post`). A connector's sync says "sync" (task.sync).
// Ticked, by an agent from its post (`by`) or by a person (`user`: their account's id, on a task shared with them, so
// its page says who did).
const tick = (op, now) => (op.done !== false ? { done: true, done_at: now, done_by: op.by ? "agent" : "you", done_post: op.by || null, done_user: op.user || null } : { done: false, done_at: null, done_by: null, done_post: null, done_user: null });
// An archived thread you write on (a comment, a prompt in its terminal, a message from Discord or Telegram, an
// answer) is going again, so it comes back to the feed, or to Hidden if you hid it. Not for what was said
// before you archived it and copied in since, nor for a cron job's run, which nobody wrote: you archived a job's
// thread to stop seeing it.
const unarchive = (post, at) => {
  if (post?.archived && !(at < post.archived_at)) Object.assign(post, { archived: false, archived_at: null });
};
// A task's posts: any number of them, and a post can be on any number of tasks. Each link says when it was made
// and how: "sent" (the task went to the post's agent), "you" (linked from the page) or "agent" (from its post); and,
// from the page, who (`user`, an account's id: someone on a task shared with them).
const linkPost = (t, post, at, by, user) => {
  if (post && !t.posts.some((e) => e.post === post)) t.posts.push({ post, at, by, ...(user ? { user } : {}) });
};
// A task's pages, as many as its threads: { page, at, by } each, `by` "you" or "agent" (a page's checklist an agent
// wrote). One from when a task had one `page` gets it as its first.
const taskPages = (t) => {
  if (!Array.isArray(t.pages)) t.pages = t.page ? [{ page: t.page, at: t.at, by: t.from ? "agent" : "you" }] : [];
  delete t.page;
  return t.pages;
};
const linkPage = (t, page, at, by) => {
  if (page && !taskPages(t).some((e) => e.page === page)) t.pages.push({ page, at, by });
};
// A post's pull requests, by link: { url, number, repo, at, how, off, gh }. Its transcript, its agent, you and
// GitHub each say part of it. How it came to be linked keeps the strongest (pulls.mjs), and when the earliest;
// one you unlinked (off) stays unlinked whatever finds it again, and where it stands (gh) is GitHub's to say.
const PR_HOW = ["opened", "worked", "you", "agent", "branch"];
function linkPr(prs, url, add) {
  const key = Object.keys(prs).find((k) => k.toLowerCase() === String(url).toLowerCase()) || url;
  const was = prs[key] || {};
  const how = [was.how, add.how].filter(Boolean).sort((a, b) => PR_HOW.indexOf(a) - PR_HOW.indexOf(b))[0] || "opened";
  const at = [was.at, add.at].filter(Boolean).sort()[0] || null;
  return { ...prs, [key]: { ...was, url: key, number: add.number ?? was.number, repo: add.repo ?? was.repo, at, how, ...(add.off !== undefined ? { off: !!add.off } : {}), ...(add.gh !== undefined ? { gh: add.gh } : {}) } };
}
// A Claude Code session that ended before anything happened in it (`claude`, then quit; or /clear or /resume
// before a first prompt): no prompt, no turn, nothing said, asked, sent or linked. Claude Code saved no
// conversation for it, so there's nothing to come back to, and its post goes instead of staying as an empty
// "New thread".
function untouched(state, s) {
  if (state.agents[s.agent]?.kind !== "claude-code" || s.launch || s.prompt || s.turn_started || s.title || s.text || s.ai_title) return false;
  if (s.updates?.length || Object.keys(s.attachments || {}).length || Object.keys(s.prs || {}).length || state.group_posts?.[s.id]) return false;
  const on = (x) => x.post === s.id;
  if (state.cold?.has(s.id) || [state.messages, state.questions, state.todos, state.files, state.outbox, Object.values(state.launches)].some((list) => list.some(on))) return false;
  return !Object.values(state.tasks).some((t) => t.posts.some(on) || t.sent.some(on));
}

// The post a session id is a copy of (session.fold), or null: a copy is known by its id or the start of it.
export const foldedInto = (state, id) => (id ? Object.values(state.sessions).find((s) => s.id !== id && s.copies?.some((c) => String(id).startsWith(c)))?.id || null : null);
// The post-in-waiting (launch) a session saying hello answers (`key`: its post's id): a resume of this post, or a new
// session Claude Code named when it started it (`claude --bg` printed its id). A background session's environment
// can't say which: Claude Code starts it in a worker made earlier, with an earlier launch's variables. Only a launch
// that isn't named that way (Codex's, or one from before) goes by what the session says. Null: agentbook didn't
// start it.
export function helloLaunch(state, key, op) {
  const resumed = Object.values(state.launches).filter((l) => l.resume && l.post === key && !l.arrived && !l.error).at(-1);
  const told = op.launch && state.launches[op.launch];
  return resumed || Object.values(state.launches).find((l) => l.session && !l.post && !l.error && String(key).startsWith(l.session)) || (told && !told.named && !told.resume && !told.post ? told : null);
}

// A store: the state, its database, and the ops that change it. `file` is its database; `filesDir` where the files
// its ops name are kept. One the server keeps for a machine (`outbox: false`) has nothing to deliver to sessions:
// what reaches them goes to that machine as commands. `legacy`: an events.jsonl from before the database, in the
// database's folder, is imported once.
// A new thread's name, one no other open thread has, so that "petrel" in a message means one thread. Its bird
// comes from its process (bird() in lib/common.mjs); when another open thread has it, the next bird no open
// thread has, and when all have one, a number after it ("heron 2"). A name given by hand (AGENTBOOK_LABEL, the
// hello's `named`) stays.
function freeName(state, op, key) {
  const label = op.label;
  const taken = new Set(Object.values(state.sessions).filter((s) => s.id !== key && s.state !== "done" && !s.archived).map((s) => s.label));
  if (op.named || !taken.has(label) || !BIRDS.includes(label)) return label;
  const at = BIRDS.indexOf(label);
  for (let i = 1; i < BIRDS.length; i++) if (!taken.has(BIRDS[(at + i) % BIRDS.length])) return BIRDS[(at + i) % BIRDS.length];
  for (let n = 2; ; n++) if (!taken.has(`${label} ${n}`)) return `${label} ${n}`;
}

// `acks`: a machine's store (agentbook-cli's), whose ops go to a server: its log keeps every op the server hasn't
// acknowledged, however old (setAcked), and prunes what it has once it's a week old (ACKED_DAYS), not 30 days.
export function createStore({ file = DB_FILE, filesDir = FILES_DIR, outbox = true, legacy = true, acks = false, moveCorrupt = false } = {}) {
  const home = path.dirname(file);
  const LOG = path.join(home, "events.jsonl"); // before the database: imported once, then kept as a backup
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(filesDir, { recursive: true });
  const state = { seq: 0, agents: {}, sessions: {}, procs: {}, launches: {}, questions: [], todos: [], files: [], messages: [], outbox: [], workspaces: {}, tasks: {}, pages: {}, page_versions: [], routines: {}, routine_code: [], routine_runs: [], groups: {}, group_notes: [], group_files: [], group_events: [], group_posts: {}, notes: {}, note_versions: [], thread_guests: {}, thread_seen: {}, talks: {}, wip_sets: {}, page_posts: {}, agent_follows: {}, person_follows: {}, feed_archived: {}, machine_cloud: {}, images: {}, image_builds: {}, boxes: {} };
  const listeners = new Set();

  // Memory holds each thread's history (its questions, files and messages) whole or not at all. Past
  // LIMITS.messages, the threads used least lately go back to the database after a checkpoint (settle), and come
  // back whole when anything reads or changes them (warm); their rows stay either way. `cold`: what the feed shows
  // of each thread that's out (feedOf). `used`: when each thread's history was last read or changed (ms).
  const cold = new Map();
  const used = new Map();
  function warm(post, at = Date.now()) {
    if (!post) return;
    if (!(used.get(post) > at)) used.set(post, at);
    if (!cold.has(post)) return;
    cold.delete(post);
    for (const part of HISTORY) {
      const back = tables.pageIn(part, post);
      if (back.length) state[part] = tables.inOrder(part, [...state[part], ...back]);
    }
  }
  const warmFile = (fid) => {
    if (fid && cold.size && !state.files.some((f) => f.id === fid)) warm(tables.postOf("files", fid));
  };
  // Right after a checkpoint, when the database has all of it: threads back to it until memory holds no more
  // messages than it should. Not one asking you something, holding messages of yours (queued, or to send again),
  // or used within the hour.
  function settle() {
    if (state.messages.length <= LIMITS.messages) return;
    const count = new Map();
    for (const m of state.messages) count.set(m.post, (count.get(m.post) || 0) + 1);
    const stays = new Set();
    for (const q of state.questions) if (!q.answered) stays.add(q.post);
    for (const m of state.messages) if (m.queued || m.failed) stays.add(m.post);
    const lately = (p) => Math.max(used.get(p) || 0, Date.parse(state.sessions[p]?.updated) || 0);
    const now = Date.now();
    const going = new Set();
    let left = state.messages.length;
    for (const p of [...count.keys()].filter((p) => !stays.has(p) && now - lately(p) > QUIET_MS).sort((a, b) => lately(a) - lately(b))) {
      if (left <= LIMITS.messages) break;
      going.add(p);
      left -= count.get(p);
    }
    if (!going.size) return;
    const gone = {};
    for (const part of HISTORY) {
      const out = state[part].filter((x) => going.has(x.post));
      state[part] = state[part].filter((x) => !going.has(x.post));
      tables.pageOut(part, out);
      for (const x of out) ((gone[x.post] ||= {})[part] ||= []).push(x);
    }
    for (const p of going) {
      cold.set(p, feedOf(gone[p].messages, gone[p].files, gone[p].questions, state.sessions[p]));
      used.delete(p);
    }
  }
  // For what reads a thread's history (warm, fileOf, outOfMemory below), not part of what's saved.
  Object.defineProperty(state, "cold", {
    value: {
      has: (post) => cold.has(post),
      summary: (post) => cold.get(post),
      warm: (post) => warm(post),
      file: warmFile,
      rows: (part, posts) => (cold.size ? tables.rows(part, (p) => cold.has(p) && (!posts || posts.has(p))) : []),
    },
  });

  const touch = (s, now) => {
    s.updated = s.updated && s.updated > now ? s.updated : now;
    s.rev = (s.rev || 0) + 1;
  };

  function apply(op) {
    state.seq = Math.max(state.seq, op.seq);
    const now = op.at;
    const id = (prefix) => `${prefix}${op.seq}`;
    const post = op.post && state.sessions[op.post];
    // `mid`: the message it is, for one of yours that may not get there (message.fail). `held`: one that waits in
    // its post's queue for its turn to end (message.release).
    const deliver = (event, mid = null, held = false) => outbox && state.outbox.push({ oid: id("o"), post: op.post, event, at: now, delivered: false, ...(mid ? { mid } : {}), ...(held ? { held: true } : {}) });
    // A post whose queue is empty again isn't paused: what you queue next goes when its turn ends.
    const unpause = () => {
      if (post?.queue_paused && !state.messages.some((m) => m.post === op.post && m.queued)) delete post.queue_paused;
    };
    if (HISTORY_OPS.has(op.t)) warm(op.post, Date.parse(now) || Date.now());
    else if (FILE_OPS.has(op.t)) warmFile(op.fid);

    switch (op.t) {
      case "session.hello": {
        if (!state.agents[op.agent]) state.agents[op.agent] = { id: op.agent, name: op.agent_name || op.agent, kind: op.kind || "claude-code", glyph: (op.agent_name || op.agent)[0].toUpperCase(), created: now };
        // A copy of a post's conversation (session.fold) is that post.
        const key = (op.session_id && foldedInto(state, op.session_id)) || op.session_id || op.proc;
        const was = state.procs[op.proc];
        if (was && was !== key && state.sessions[was]) {
          if (was === op.proc && !state.sessions[key]) {
            // A post made for this process before its session id was known: keep it, under the real id.
            warm(was);
            state.sessions[key] = { ...state.sessions[was], id: key };
            delete state.sessions[was];
            for (const list of [state.questions, state.todos, state.files, state.messages, state.outbox]) for (const x of list) if (x.post === was) x.post = key;
            for (const l of Object.values(state.launches)) if (l.post === was) l.post = key;
            for (const t of Object.values(state.tasks)) for (const e of [...t.sent, ...t.posts]) if (e.post === was) e.post = key;
            for (const t of [...state.todos, ...Object.values(state.tasks)]) if (t.done_post === was) t.done_post = key;
            for (const t of Object.values(state.tasks)) if (t.from === was) t.from = key;
          } else if (state.sessions[was].state !== "done") {
            // /clear: the process moved on to a new conversation, so the old one is over.
            Object.assign(state.sessions[was], { state: "done", busy: false, ended: now, end_reason: "Cleared" });
            touch(state.sessions[was], now);
            if (untouched(state, state.sessions[was])) delete state.sessions[was];
          }
        }
        const prev = state.sessions[key];
        const launch = helloLaunch(state, key, op);
        // The same process saying hello again is still in the turn it was in: Claude Code runs SessionStart again
        // after compacting, mid-turn too. A new process (a resume, a restart) starts between turns.
        const again = prev && prev.state !== "done" && prev.proc === op.proc;
        state.sessions[key] = {
          ...(prev || { id: key, started: op.started || now, title: null, text: null, prompt: op.prompt || null, updates: [], attachments: {}, prs: {}, rev: 0 }),
          agent: op.agent,
          label: prev?.label || op.label, // a resumed post keeps its name
          cwd: op.cwd ?? prev?.cwd,
          root: op.root ?? prev?.root,
          repo: op.repo ?? prev?.repo,
          branch: op.branch ?? prev?.branch,
          host: op.host ?? prev?.host,
          pid: op.pid ?? prev?.pid,
          proc: op.proc,
          session_id: op.session_id || prev?.session_id || null,
          transcript: op.transcript || prev?.transcript || null,
          channel: !!op.channel,
          // Claude Desktop or VS Code (appOf): the same process keeps it, a resume elsewhere (a terminal, the background) doesn't.
          app: op.app || (prev?.proc === op.proc ? prev?.app : null) || null,
          launch: launch?.id || prev?.launch || null,
          cloud: op.cloud || prev?.cloud || null, // "claude" or "codex": runs in their cloud, not on a machine
          url: op.url || prev?.url || null,
          state: prev && prev.state !== "done" ? prev.state : "idle",
          busy: again ? !!prev.busy : false,
          ended: null,
          end_reason: null,
          asleep: false,
          slept: null,
          sleep_reason: null,
        };
        touch(state.sessions[key], prev ? now : op.updated || now);
        state.procs[op.proc] = key;
        if (launch) adopt(launch, key, op);
        break;
      }
      case "session.status": {
        if (!post) break;
        if (op.state) post.state = op.state;
        // What the last turn ended on ("Waiting for your next message") isn't what this one is doing. Only Claude Code
        // says at the start of a turn; the drivers' turns start with no words.
        if (op.turn === "start" && !op.text) post.doing = null;
        if (op.text) post.doing = op.text;
        if (op.transcript) post.transcript = op.transcript;
        if (op.app) post.app = op.app;
        // Hooks mark where Claude's turns start and end, so events can wait for the gap between turns.
        if (op.turn === "start") Object.assign(post, { busy: true, turn_started: now });
        // What the last turn said of itself and no reply took (session.shape) isn't this turn's.
        if (op.turn === "start") delete post.shape;
        if (op.turn === "end") Object.assign(post, { busy: false, turn_ended: now });
        // `failed`: the API error that ended its turn (Claude Code's kind of it: "server_error", "rate_limit"…), with
        // what it said; null once nothing should pick it up (archived). The next turn's start clears it.
        if (op.turn === "start" || op.failed === null) post.failed = null;
        if (op.failed) post.failed = { error: op.failed, text: op.text || null, at: now };
        touch(post, now);
        break;
      }
      case "session.gone": {
        if (!post) break;
        // The first word on how it ended stands ("Stopped", then the session's own "Session ended").
        if (post.state !== "done") {
          Object.assign(post, { state: "done", busy: false, ended: op.ended || now, end_reason: op.reason || "Ended" });
          touch(post, op.ended || now);
        }
        for (const [proc, key] of Object.entries(state.procs)) if (key === op.post) delete state.procs[proc];
        // Nothing can answer its questions any more.
        for (const q of state.questions) if (q.post === op.post && !q.answered) Object.assign(q, { answered: now, value: null, by: "gone" });
        if (untouched(state, post)) delete state.sessions[op.post];
        break;
      }
      case "session.sleep": {
        // A background session whose process stopped (agentbook put it to sleep, Claude Code retired it, you
        // archived it) isn't over: its post stays, and writing to it wakes it. Only the prompts its process was
        // holding go; questions it asked get their answers when it wakes.
        if (!post || post.state === "done" || post.asleep) break;
        Object.assign(post, { asleep: true, slept: now, sleep_reason: op.reason || null, state: "idle", busy: false });
        for (const [proc, key] of Object.entries(state.procs)) if (key === op.post) delete state.procs[proc];
        for (const q of state.questions) if (q.post === op.post && !q.answered && (q.kind === "permission" || q.hook)) Object.assign(q, { answered: now, value: null, by: "gone" });
        touch(post, now);
        break;
      }
      case "session.post": {
        if (!post) break;
        if (op.title) post.title = op.title;
        if (op.text != null) post.text = op.text;
        touch(post, now);
        break;
      }
      case "session.update": {
        if (!post) break;
        // `changes`: agentbook's own line for a turn that changed files. Only the newest few stay, so they
        // don't crowd out the session's results.
        // `pr`: agentbook's own line for a change in one of its pull requests ({ url, number, kind }), as few.
        for (const [k, n] of [["changes", LIMITS.changes], ["pr", LIMITS.prs]]) {
          if (!op[k]) continue;
          const lines = post.updates.filter((u) => u[k]);
          for (const u of lines.slice(0, Math.max(0, lines.length - n + 1))) post.updates.splice(post.updates.indexOf(u), 1);
        }
        // `notify`: its agent put this one on its person's bell too (ab_update's notify, once a turn; server/news.mjs).
        post.updates.push({ at: now, text: op.text, link: op.link || null, ...(op.changes ? { changes: op.changes } : {}), ...(op.pr ? { pr: op.pr } : {}), ...(op.notify === true ? { notify: true } : {}) });
        if (post.updates.length > LIMITS.updates) post.updates.splice(0, post.updates.length - LIMITS.updates);
        touch(post, now);
        break;
      }
      case "session.pr": {
        // One of its pull requests linked (how), unlinked or linked again (off), or read from GitHub (gh). GitHub
        // telling where it stands isn't the post doing something: it isn't touched.
        if (!post || !op.url) break;
        post.prs = linkPr(post.prs || {}, op.url, op);
        if (op.how) touch(post, now);
        else post.rev = (post.rev || 0) + 1;
        break;
      }
      case "session.attach": {
        if (!post) break;
        if (op.remove) delete post.attachments[op.key];
        else {
          const prev = post.attachments[op.key];
          post.attachments[op.key] = { key: op.key, type: op.type || prev?.type, title: op.title || prev?.title || "", data: { ...(prev?.data || {}), ...(op.data || {}) }, created: prev?.created || now, updated: now };
        }
        touch(post, now);
        break;
      }
      case "session.shape": {
        // How its turn went (ab_verdict, ab_checks, ab_suggest): kept until the reply that ends the turn takes it. Each
        // part replaces what the turn had of it. Not shown until then, so the post isn't touched.
        if (!post || !op.shape || typeof op.shape !== "object") break;
        post.shape = { ...(post.shape || {}), ...op.shape };
        break;
      }
      case "session.run": {
        // A code block of one of its messages, run on its machine: its latest run, by the message and which of its
        // blocks it is. Only the newest few stay. Running one isn't its agent doing something: it isn't touched.
        if (!post) break;
        const runs = (post.runs ||= {});
        const key = `${op.mid}:${op.block}`;
        const was = runs[key];
        delete runs[key];
        runs[key] = { mid: op.mid, block: op.block, state: op.state, by: op.by ?? was?.by ?? null, started: op.started || was?.started || now, ended: op.ended ?? null, exit: op.exit ?? null, signal: op.signal ?? null, out: op.out || "", cut: !!op.cut, error: op.error ?? null };
        for (const k of Object.keys(runs).slice(0, Math.max(0, Object.keys(runs).length - LIMITS.runs))) delete runs[k];
        post.rev = (post.rev || 0) + 1;
        break;
      }
      case "session.flag": {
        // Pinned keeps a post at the top of the feed, archived moves it out of the feed into Archived, and
        // hidden into Hidden, still going.
        if (!post) break;
        if (typeof op.pinned === "boolean") Object.assign(post, { pinned: op.pinned, pinned_at: op.pinned ? now : null });
        if (typeof op.archived === "boolean") Object.assign(post, { archived: op.archived, archived_at: op.archived ? now : null });
        if (typeof op.hidden === "boolean") Object.assign(post, { hidden: op.hidden, hidden_at: op.hidden ? now : null });
        touch(post, now);
        break;
      }
      case "session.group": {
        // The group a post is in, as its server says (a machine's own note of it: its folder is one the session may
        // write, and it hears the group's news).
        if (post) post.group = op.gid || null;
        break;
      }
      case "session.wip": {
        // The task a post is on that ships more than it does, as its server says: it hears that task's news (task-ship.mjs).
        if (post) post.wip = op.sid || null;
        break;
      }
      case "session.paged": {
        // The page its person put a post on by hand (or none: they took it off one), as its server says: it hears so.
        if (post) post.paged = { page: op.pid || null };
        break;
      }
      case "agent.hello": {
        // An agent a driver lists (OpenClaw's), with a profile before it has any sessions. Its name follows the agent's,
        // and `host` is the machine it runs on when that isn't this one (OpenClaw's gateway's, "gpu"). `version` is
        // its runtime's on this machine (Claude Code's, Codex's), said again when it changes.
        const a = state.agents[op.agent];
        if (!a) state.agents[op.agent] = { id: op.agent, name: op.agent_name || op.agent, kind: op.kind, glyph: (op.agent_name || op.agent)[0].toUpperCase(), ...(op.host ? { host: op.host } : {}), ...(op.version ? { version: op.version } : {}), created: now };
        else {
          if (op.agent_name && a.name !== op.agent_name) Object.assign(a, { name: op.agent_name, glyph: op.agent_name[0].toUpperCase() });
          if (op.host) a.host = op.host;
          if (op.version) a.version = op.version;
        }
        break;
      }
      case "agent.profile": {
        const a = state.agents[op.agent];
        if (a) {
          if (typeof op.bio === "string") a.bio = op.bio;
          if (op.avatar !== undefined) a.avatar = op.avatar;
        }
        break;
      }
      case "agent.avatar": {
        // The avatar you set for an agent (null: back to its own), or with `default`, the one its runtime gives it.
        const a = state.agents[op.agent];
        if (a) a[op.default ? "avatar_default" : "avatar"] = op.avatar || null;
        break;
      }
      case "agent.visibility": {
        // Private (only its owner) or public (anyone signed in). Its posts follow it unless set themselves.
        const a = state.agents[op.agent];
        if (a && ["private", "public"].includes(op.visibility)) a.visibility = op.visibility;
        break;
      }
      case "agent.hidden": {
        // Off its owner's sidebar and feed, or back on them.
        const a = state.agents[op.agent];
        if (a) a.hidden = !!op.hidden;
        break;
      }
      case "agent.visual": {
        // Visual mode had a switch per agent; it's on for every agent now, so an old switch's op
        // only clears what it left.
        const a = state.agents[op.agent];
        if (a) delete a.visual;
        break;
      }
      case "session.visibility": {
        // A post's own setting (null: as its agent; private, followers or public, visibility.mjs), and whether others
        // see its work (steps, files).
        if (!post) break;
        if (op.visibility === null || isLevel(op.visibility)) post.visibility = op.visibility;
        if (typeof op.show_work === "boolean") post.show_work = op.show_work;
        touch(post, now);
        break;
      }
      case "session.where": {
        // The session moved to another checkout, or switched branch (from its transcript).
        if (!post) break;
        for (const k of ["cwd", "root", "repo", "branch"]) if (op[k] !== undefined) post[k] = op[k];
        touch(post, now);
        break;
      }
      case "session.landed": {
        // Its branch was cleaned up with everything on it on main (WIP's Clean up), so once the branch is gone
        // the post still says its work landed.
        if (post && op.branch) post.landed = op.branch;
        break;
      }
      case "session.skills": {
        if (post) post.skills = op.skills || [];
        break;
      }
      case "session.paused": {
        // Its queue held (`paused`: "stopped", "ended" or "you"), or going again (null).
        if (!post) break;
        if (op.paused) post.queue_paused = op.paused;
        else delete post.queue_paused;
        post.rev = (post.rev || 0) + 1;
        break;
      }
      case "session.from": {
        // The thread it was started from: a Claude Desktop session another one started (cli/desktop.mjs), or the one
        // its person picked on its page (`by: "you"`, on the server), which may be none. What they picked stays:
        // Desktop's doesn't replace it, nor bring back one they took off. Not news of its own: it keeps its place in
        // the lists.
        if (!post || op.started_from === post.id) break;
        const picked = op.by === "you";
        if (!picked && (!op.started_from || post.from_by === "you")) break;
        if ((post.started_from || null) === (op.started_from || null) && (!picked || post.from_by === "you")) break;
        if (op.started_from) post.started_from = op.started_from;
        else delete post.started_from;
        if (picked) post.from_by = "you";
        post.rev = (post.rev || 0) + 1;
        break;
      }
      case "session.model": {
        // The model you picked for the session's next turn; null once it's switched (or the pick is undone).
        if (!post) break;
        post.model_pick = op.model || null;
        touch(post, now);
        break;
      }
      case "session.fold": {
        // A copy Claude Code started when asked to resume this post (`copy`: its session id, or the start of it, as
        // `claude --bg` printed it): a new session with this post's conversation in it, which went on there. It's
        // this post: what the copy's own post has (messages, results, questions, files, pull requests) moves here,
        // and its session too with `follow` (the thread goes on in the copy). Its hello finds this post (`copies`).
        const into = post;
        if (!into || !op.copy || op.copy === op.post) break;
        const key = Object.keys(state.sessions).find((k) => k !== op.post && (k === op.copy || k.startsWith(op.copy)));
        const from = key && state.sessions[key];
        into.copies = [...new Set([...(into.copies || []), key || op.copy, ...(from?.copies || [])])];
        if (from) {
          warm(key);
          warm(op.post);
          for (const list of [state.questions, state.todos, state.files, state.messages, state.outbox]) for (const x of list) if (x.post === key) x.post = op.post;
          for (const l of Object.values(state.launches)) if (l.post === key) l.post = op.post;
          for (const t of Object.values(state.tasks)) {
            for (const e of [...t.sent, ...t.posts]) if (e.post === key) e.post = op.post;
            t.posts = t.posts.filter((e, i) => t.posts.findIndex((x) => x.post === e.post) === i);
            if (t.from === key) t.from = op.post;
          }
          for (const t of [...state.todos, ...Object.values(state.tasks)]) if (t.done_post === key) t.done_post = op.post;
          for (const [proc, k] of Object.entries(state.procs)) if (k === key) state.procs[proc] = op.post;
          if (state.group_posts[key] && !state.group_posts[op.post]) state.group_posts[op.post] = state.group_posts[key];
          delete state.group_posts[key];
          if (state.page_posts?.[key] && !state.page_posts[op.post]) state.page_posts[op.post] = state.page_posts[key];
          if (state.page_posts) delete state.page_posts[key];
          rekeyShip(state, key, op.post);
          into.updates = [...into.updates, ...from.updates].sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-LIMITS.updates);
          for (const [url, p] of Object.entries(from.prs || {})) into.prs = linkPr(into.prs || {}, url, p);
          for (const [k, a] of Object.entries(from.attachments || {})) if (!into.attachments[k] || a.updated > into.attachments[k].updated) into.attachments[k] = a;
          if (!into.title && from.title) Object.assign(into, { title: from.title, text: from.text });
          // Put away only if both were: one of them going on is the thread going on.
          for (const f of ["archived", "hidden"]) if (into[f] && !from[f]) Object.assign(into, { [f]: false, [`${f}_at`]: null });
          if (op.follow) {
            for (const k of ["session_id", "transcript", "proc", "pid", "host", "channel", "app", "cloud", "url", "state", "busy", "doing", "turn_started", "turn_ended", "failed", "ended", "end_reason", "asleep", "slept", "sleep_reason", "ai_title", "model", "plan", "stats", "context", "skill_uses", "loops", "shape"]) {
              if (from[k] !== undefined) into[k] = from[k];
            }
          }
          delete state.sessions[key];
        } else if (op.follow && op.session_id) {
          // A copy that never said hello (Claude Code stopped it before its turn: no login) has no post to move here,
          // but what you sent is in it: with its `session_id`, the thread goes on in it, and a resume resumes it.
          into.session_id = op.session_id;
          if (into.transcript) into.transcript = into.transcript.replace(/[^/\\]+\.jsonl$/, `${op.session_id}.jsonl`);
        }
        touch(into, now);
        break;
      }
      case "session.snapshot": {
        // What the transcript says about the session, kept so summaries survive a restart.
        if (!post) break;
        for (const k of ["ai_title", "model", "plan", "stats", "context", "skill_uses"]) if (op[k] !== undefined) post[k] = op[k];
        // It began earlier than agentbook knew (OpenClaw's history goes further back): never later.
        if (op.started && op.started < post.started) post.started = op.started;
        if (op.prs) for (const [url, p] of Object.entries(op.prs)) post.prs = linkPr(post.prs || {}, url, { url, number: p.number, repo: p.repo, at: p.at, how: p.how || "opened" });
        // Its loops (/loop), by id: a transcript read from its middle, after a restart, may know fewer of them,
        // or fewer of their runs.
        if (op.loops) {
          const was = Object.fromEntries((post.loops || []).map((l) => [l.id, l]));
          for (const l of op.loops) {
            const runs = [...(was[l.id]?.runs || []).filter((r) => r.at < (l.runs[0]?.at || "~") && l.at <= r.at), ...l.runs].slice(-100);
            // That someone started it (/loop) may be before what was read.
            const slash = l.slash || (was[l.id]?.slash && was[l.id].at === l.at);
            was[l.id] = { ...l, runs, ...(slash ? { slash } : {}) };
          }
          post.loops = Object.values(was);
        }
        touch(post, now);
        break;
      }
      case "launch.add": {
        // `resume`: picking up an ended post's conversation, with the message you wrote on it. `named`: the
        // session will be known by the id Claude Code gives it (launch.started). `teleport`: a Claude Code cloud
        // session coming here; its conversation is the cloud's, so what's typed first is typed, not posted.
        // `task`: the text of the task it was sent for, which its agent is told. `page`: the page it's for, "new" for
        // one to make, which its agent is told too. `cwd`: where it started, when that isn't `root` (a worktree);
        // with `model` and `effort`, what starting it again needs. `routine`: the routine it's a run of
        // ({ id, name }, routines.mjs). `user`: who started it, when that isn't the machine's owner: someone its owner lets
        // operate the agent. `side_of`: a side thread's, the thread whose conversation it goes on from (claude --fork-session).
        state.launches[op.lid] = { id: op.lid, agent: op.agent, root: op.root, cwd: op.cwd || null, branch: op.branch || null, prompt: op.prompt, files: op.files || [], at: now, post: op.post || null, resume: !!op.resume, named: !!op.named, teleport: op.teleport || null, mirrored: !!op.teleport, visibility: op.visibility || null, cloning: op.cloning || null, step: op.step || null, task: op.task || null, page: op.page || null, group: op.group || null, model: op.model || null, effort: op.effort || null, routine: op.routine || null, ...(op.noted ? { noted: true } : {}), ...(op.user ? { user: op.user } : {}), ...(op.side_of ? { side_of: op.side_of } : {}), error: null };
        break;
      }
      case "launch.cloned": {
        if (state.launches[op.lid]) state.launches[op.lid].cloning = null;
        break;
      }
      case "launch.step": {
        const l = state.launches[op.lid];
        if (l) Object.assign(l, { step: op.step || null, progress: op.step && op.total ? { done: op.done || 0, total: op.total } : null });
        break;
      }
      case "launch.started": {
        // Claude Code started the session as `session` (its id, or the start of it). It may have registered already.
        const l = state.launches[op.lid];
        if (!l) break;
        l.session = op.session;
        const s = !l.post && Object.values(state.sessions).find((x) => x.session_id?.startsWith(op.session));
        if (s) adopt(l, s.id, op);
        break;
      }
      case "launch.fail": {
        if (state.launches[op.lid]) state.launches[op.lid].error = op.error;
        break;
      }
      case "launch.retry": {
        // A start that failed, starting again (its folder trusted since).
        const l = state.launches[op.lid];
        if (l) Object.assign(l, { error: null, at: now });
        break;
      }
      case "launch.archive": {
        // A start that failed, out of the feed. It's kept for the task it was sent for.
        if (state.launches[op.lid]) state.launches[op.lid].archived = now;
        break;
      }
      case "question.ask": {
        if (!post) break;
        // Asking again with the same key replaces the open question.
        if (op.key) for (const q of state.questions) if (q.post === op.post && q.key === op.key && !q.answered) Object.assign(q, { answered: now, value: null, by: "replaced" });
        state.questions.push({
          id: op.qid || id("q"),
          post: op.post,
          kind: op.kind || "choice",
          title: op.title,
          detail: op.detail || "",
          preview: op.preview || "",
          options: op.options || [],
          default: op.default ?? null,
          until: op.until || null,
          key: op.key || null,
          request_id: op.request_id || null,
          tool_name: op.tool_name || null,
          hook: !!op.hook, // a hook waits for the answer itself (Claude's AskUserQuestion in a background session)
          blocks: !!op.blocks, // its turn can't go on without the answer (Codex's and OpenClaw's questions)
          other: !!op.other, // takes an answer of your own besides its options
          routine: op.routine || null, // the OK for a page routine's version: { rid, v, yes } (routines.mjs)
          asked: now,
          answered: null,
          value: null,
          by: null,
        });
        touch(post, now);
        break;
      }
      case "question.answer": {
        const q = state.questions.find((x) => x.id === op.qid);
        if (!q || q.answered) break;
        Object.assign(q, { answered: now, value: op.value, by: op.by || "human", file_id: op.file_id || null, file: op.file || null });
        if (q.by === "human") unarchive(state.sessions[q.post], now);
        // The OK for a routine's version: its first option uses it, the other keeps the one that runs.
        if (q.routine && op.by === "human") applyRoutine(state, { t: "routine.ok", rid: q.routine.rid, v: q.routine.v, use: op.value === q.routine.yes, by: { user: op.user || null } }, now);
        if (q.hook || op.by === "expired") {
          // The hook that asked takes the answer from here; nothing to send.
        } else if (q.kind === "permission") {
          if (op.by !== "terminal" && op.value && outbox) state.outbox.push({ oid: id("o"), post: q.post, event: { type: "permission", request_id: q.request_id, behavior: op.value === "allow" ? "allow" : "deny" }, at: now, delivered: false });
        } else if (op.by !== "terminal" && op.by !== "gone" && outbox) {
          state.outbox.push({ oid: id("o"), post: q.post, event: { type: "answer", question_id: q.id, key: q.key, question: q.title, value: op.value, by: q.by, skipped: op.by === "skipped" || op.by === "archived", file: op.file || null }, at: now, delivered: false });
        }
        const s = state.sessions[q.post];
        // Its last open question answered, a session that was waiting on you carries on.
        if (s?.state === "waiting" && op.by !== "expired" && !state.questions.some((x) => x.post === q.post && !x.answered)) Object.assign(s, { state: s.busy ? "working" : "idle", doing: s.busy ? "Carrying on" : s.doing });
        if (s) touch(s, now);
        break;
      }
      // Agents' to-dos from before they were tasks: replayed from the log, then moved (moveTodos in server.mjs).
      case "todo.add": {
        if (!post) break;
        state.todos.push({ id: id("t"), post: op.post, text: op.text, at: now, done: false, done_at: null });
        touch(post, now);
        break;
      }
      case "todo.done": {
        const t = state.todos.find((x) => x.id === op.tid);
        if (!t) break;
        Object.assign(t, tick(op, now));
        if (state.sessions[t.post]) touch(state.sessions[t.post], now);
        break;
      }
      case "todo.remove": {
        state.todos = state.todos.filter((t) => t.id !== op.tid);
        break;
      }
      case "file.add": {
        // `remote`: where a driver fetches it from when it's first opened (a picture in an OpenClaw message).
        // `blob`: its bytes on the server (sha256); `ref`: the upload it came from there, for one you sent.
        // `artifact`: the claude.ai artifact it's a copy of (ab_artifact), by its link.
        const f = { id: op.fid || id("f"), post: op.post || null, from: op.from, name: op.name, title: op.title || op.name, size: op.size, stored: op.stored, draft: !!op.draft, embedded: !!op.embedded, pending: !!op.pending, at: now, ...(op.remote ? { remote: op.remote } : {}), ...(op.blob ? { blob: op.blob } : {}), ...(op.ref ? { ref: op.ref } : {}), ...(op.type ? { type: op.type } : {}), ...(op.artifact ? { artifact: op.artifact } : {}) };
        state.files.unshift(f);
        if (op.from === "human" && post && !op.silent && !op.pending) deliver({ type: "file", file_id: f.id, name: f.name, size: f.size, path: path.join(filesDir, f.stored) });
        if (post) touch(post, now);
        break;
      }
      case "file.remove": {
        state.files = state.files.filter((f) => f.id !== op.fid);
        state.outbox = state.outbox.filter((o) => o.delivered || o.event.type !== "file" || o.event.file_id !== op.fid);
        break;
      }
      case "file.blob": {
        // A file whose bytes the server keeps now (fetched from its machine once): where, and how big.
        const f = state.files.find((x) => x.id === op.fid);
        if (!f) break;
        f.blob = op.blob;
        if (op.size != null) f.size = op.size;
        break;
      }
      case "file.size": {
        // A file a driver keeps elsewhere, once fetched: how big it is (one an OpenClaw agent sent with a MEDIA:
        // line doesn't say until then).
        const f = state.files.find((x) => x.id === op.fid);
        if (!f) break;
        f.size = op.size;
        for (const m of state.messages) if (m.post === f.post) for (const x of m.files || []) if (x.id === f.id) x.size = op.size;
        if (state.sessions[f.post]) state.sessions[f.post].rev = (state.sessions[f.post].rev || 0) + 1;
        break;
      }
      case "message.add": {
        if (!post) break;
        // A mirrored prompt keeps only what the person typed. Channel events and subagent reports are
        // Claude Code's own; agentbook already shows them.
        let text = op.via === "terminal" && op.from === "human" ? typedPart(op.text) : op.text || "";
        if (op.via === "terminal" && !text) break;
        // A resumed session's first prompt is what you wrote on its post, already in the conversation. It answers the
        // newest resume waiting for it; one before that whose prompt never came back (Claude Code restarted the
        // session itself, with a prompt of its own, before agentbook's reached it) waits no more, or each prompt after
        // it would be held to the one before and shown twice.
        const resumed = op.via === "terminal" && op.from === "human" ? Object.values(state.launches).filter((l) => l.resume && l.post === op.post && !l.mirrored && !l.error) : [];
        if (resumed.length) {
          for (const l of resumed) l.mirrored = true;
          if (resumed.some((l) => text.startsWith(l.prompt.trim()))) break;
        }
        // A session started from agentbook: its first prompt is what you posted there, not something typed in a terminal.
        // What agentbook told it with your words (`noted`: a note's comment, a thread it's a guest in) isn't yours.
        let via = op.via || "dash";
        const launched = via === "terminal" && op.from === "human" && state.launches[post.launch];
        if (launched && !launched.resume && !launched.mirrored) {
          launched.mirrored = true;
          if (text.startsWith(launched.prompt.trim())) {
            via = "dash";
            if (launched.noted) text = launched.prompt.trim();
          }
        }
        // Files attached to the message stop being drafts and join the post.
        const files = (op.files || []).map((fid) => state.files.find((f) => f.id === fid)).filter(Boolean);
        for (const f of files) Object.assign(f, { post: op.post, pending: false });
        // A message copied from the agent's own record of the session (OpenClaw's history) keeps its id there
        // (`ext`), so it's copied once, and when it was said (`when`).
        // `routine`: a routine's run, sent to its thread ({ id, name }, routines.mjs).
        const mid = op.mid || id("m");
        // `queue`: one of yours that waits for its post's turn to end, under the live line, until message.release.
        const queue = !!op.queue && op.from === "human";
        // `command`: a slash command you ran (its name), or, on the agent's message, the one whose output it is.
        // `shape`: how its turn went, as its agent said with ab_verdict, ab_checks and ab_suggest, on the reply that
        // ends the turn: its first message after them (its closing words, or what it said with ab_reply).
        const shape = op.from === "agent" && post.shape && !op.command && !op.file_id ? post.shape : null;
        if (shape) delete post.shape;
        // `via: "side"`: what you sent on the side, which started a side thread (`launch`, its launch) and never reached
        // this thread's session.
        // `user`: who sent it, when it isn't the machine's owner: someone its owner lets operate its agent,
        // or the one who started it from the page (a launch's `user`).
        const user = op.from === "human" ? op.user || (launched && !launched.resume ? launched.user : null) || null : null;
        // `intro`: who it's from, as its machine tells its agent before their words (an operator's): kept here, so a
        // message sent again says it again; never sent to the server.
        const intro = user && op.from === "human" && typeof op.intro === "string" && !op.command ? op.intro : null;
        state.messages.push({ id: mid, post: op.post, from: op.from, via, text, file_id: op.file_id || null, files: files.map((f) => ({ id: f.id, name: f.name, size: f.size })), at: op.when || now, ...(user ? { user } : {}), ...(intro ? { intro } : {}), ...(op.ext ? { ext: op.ext } : {}), ...(op.routine ? { routine: op.routine } : {}), ...(queue ? { queued: true } : {}), ...(op.command ? { command: op.command } : {}), ...(shape ? { shape } : {}), ...(op.via === "side" && op.launch ? { launch: op.launch } : {}) });
        // A slash command isn't what the thread is about, so it never becomes its prompt ("You asked: /status").
        if (op.from === "human" && !post.prompt && text && !op.routine && !op.command) post.prompt = text;
        // A cron job's run with something to report moves its thread on the feed, as a change moves a page (feed.mjs).
        const cron = op.routine?.why === "cron";
        if (cron) post.moved = op.when || now;
        if (op.from === "human" && !cron && (text || files.length || op.file_id)) unarchive(post, op.when || now);
        // Only what you write on agentbook goes to the session. What reached it another way (typed in its
        // terminal, sent from Discord or Telegram) it already has, and a message that resumes a session is its
        // first prompt. Pages and widgets it names come with a note on what they showed then (mentions.mjs).
        // A slash command goes as it was typed, with nothing after it: its agent reads it as a command, not a message.
        if (op.from === "human" && (text || files.length) && (op.via || "dash") === "dash" && !op.ext && !op.resume) {
          const note = op.routine || op.command ? "" : (op.note ?? mentionNote(text, state.pages, Date.parse(now)));
          // `user`: someone its owner lets operate it, so a driver sends it as theirs, not the owner's (OpenClaw's admin).
          deliver({ type: "message", text: [intro, text, note].filter(Boolean).join("\n\n"), files: files.map((f) => ({ name: f.name, size: f.size, path: path.join(filesDir, f.stored) })), ...(op.command ? { command: op.command } : {}), ...(user ? { user } : {}) }, mid, queue);
        }
        touch(post, op.when || now);
        break;
      }
      case "message.release": {
        // A queued message going in: out of the queue, and moved to now, after the reply it waited for, saying it
        // waited (`waited`). Its outbox entry goes out like any message's.
        const i = state.messages.findIndex((m) => m.post === op.post && m.id === op.mid && m.queued);
        if (i < 0) break;
        const { queued: _, ...m } = state.messages[i];
        state.messages.splice(i, 1);
        state.messages.push({ ...m, at: now, waited: true });
        for (const o of state.outbox) if (o.post === op.post && o.mid === op.mid && o.held) Object.assign(o, { held: false, at: now });
        unpause();
        if (post) touch(post, now);
        break;
      }
      case "message.files": {
        // Files for a message copied before agentbook kept them: an OpenClaw message's media, by its id there.
        const m = post && state.messages.find((x) => x.post === op.post && x.ext === op.ext);
        if (!m) break;
        const files = (op.files || []).map((fid) => state.files.find((f) => f.id === fid)).filter(Boolean);
        for (const f of files) Object.assign(f, { post: op.post, pending: false });
        m.files = [...(m.files || []), ...files.map((f) => ({ id: f.id, name: f.name, size: f.size }))];
        post.rev = (post.rev || 0) + 1;
        break;
      }
      case "message.text": {
        // A message copied from OpenClaw's history, as it reads now: without what OpenClaw added to it.
        const m = post && state.messages.find((x) => x.post === op.post && x.ext === op.ext);
        if (!m) break;
        m.text = op.text;
        post.rev = (post.rev || 0) + 1;
        break;
      }
      case "message.drop": {
        // Messages that shouldn't be on the post: OpenClaw's, copied again on each restart before their ids were
        // kept, what OpenClaw wrote to its agent, or one of yours that couldn't be delivered, which you deleted.
        const drop = new Set(op.mids || []);
        state.messages = state.messages.filter((m) => m.post !== op.post || !drop.has(m.id));
        state.outbox = state.outbox.filter((o) => o.post !== op.post || !drop.has(o.mid));
        unpause();
        if (post) post.rev = (post.rev || 0) + 1;
        break;
      }
      case "message.fail": {
        // Messages of yours its agent couldn't be reached with (`error`: why, in words): they stay on the post, saying
        // so, and wait aside in the outbox, as they were to be sent, until you send them again or delete them.
        const mids = new Set(op.mids || []);
        for (const m of state.messages) if (m.post === op.post && mids.has(m.id)) m.failed = { error: op.error || "", at: now };
        for (const o of state.outbox) if (o.post === op.post && mids.has(o.mid) && !o.delivered) o.failed = true;
        if (post) post.rev = (post.rev || 0) + 1;
        break;
      }
      case "message.retry": {
        // One that couldn't be delivered, sent again: it goes now, so it moves to now, after whatever came since.
        const i = state.messages.findIndex((m) => m.post === op.post && m.id === op.mid && m.failed);
        if (i < 0) break;
        const { failed: _, ...m } = state.messages[i];
        state.messages.splice(i, 1);
        state.messages.push({ ...m, at: now });
        const waiting = state.outbox.find((o) => o.post === op.post && o.mid === op.mid && !o.delivered);
        if (waiting) Object.assign(waiting, { failed: false, at: now });
        else if (m.from === "human") {
          // Its outbox no longer has it: sent again as it reads.
          const files = (m.files || []).map((x) => state.files.find((f) => f.id === x.id)).filter(Boolean);
          deliver({ type: "message", text: [m.intro, m.text].filter(Boolean).join("\n\n"), files: files.map((f) => ({ name: f.name, size: f.size, path: path.join(filesDir, f.stored) })), ...(m.user ? { user: m.user } : {}) }, m.id);
        }
        if (post) touch(post, now);
        break;
      }
      case "workspace.add": {
        // A repo (`repo`: its repoKey, `url`: what clones it) or a folder on a machine, or a repo with the
        // folders it's checked out in that a machine wouldn't find by itself. (An older one's `wip`, what its WIP
        // showed, its branches or its pull requests, is gone: it shows both.)
        state.workspaces[op.wid] = { id: op.wid, name: op.name, repo: op.repo || null, url: op.url || null, folders: op.folders || [], owner: op.owner || null, created: now, ...(isLevel(op.visibility) && op.visibility !== "private" ? { visibility: op.visibility } : {}) };
        break;
      }
      case "workspace.visibility": {
        // Who sees a workspace besides its owner (visibility.mjs; private, the default, isn't kept), or with `branch`,
        // one of its worktrees (a branch, with its pull request): its own level, or null to go back to the workspace's.
        const w = state.workspaces[op.wid];
        if (!w) break;
        if (op.branch) {
          const kept = { ...(w.worktrees || {}) };
          if (isLevel(op.visibility)) kept[op.branch] = op.visibility;
          else delete kept[op.branch];
          if (Object.keys(kept).length) w.worktrees = kept;
          else delete w.worktrees;
        } else if (isLevel(op.visibility)) {
          if (op.visibility === "private") delete w.visibility;
          else w.visibility = op.visibility;
        }
        break;
      }
      case "workspace.update": {
        const w = state.workspaces[op.wid];
        if (!w) break;
        if (op.name) w.name = op.name;
        if (op.folders) w.folders = op.folders;
        // Kept out of agent search.
        if (op.search_off === true) w.search_off = true;
        else if (op.search_off === false) delete w.search_off;
        break;
      }
      case "workspace.remove": {
        delete state.workspaces[op.wid];
        break;
      }
      case "task.add": {
        // One of your own tasks. `rank` orders your list, lowest first. Undoing a delete adds it back as it was.
        // `workspace` and `agent` are where and who it's for: sending it picks them in the composer. `source`: the
        // issue a connector brought it in from (connectors.mjs). `posts`: the posts linked to it (linkPost). `from`:
        // the post of the agent that left it for you (ab_todo). One moved from before to-dos were tasks keeps
        // when it was `added` and done. `pages`: the pages it's on, as your page names them, any number, each
        // { page, at, by } (a page's checklist is its tasks; `page`, one, from before); `group`: the group it's in.
        // `text` is its title, one short line, and `note` its body, on why or how (titled() in text.mjs). `answers`: the
        // buttons an agent's to-do offers (ab_todo), each a label and what pressing it sends as your message. `scope: "thread"`: a to-do its thread keeps for you, on that
        // thread and not on your Tasks, until task.scope moves it there; `later`: an agent's
        // to-do put on your Tasks on purpose (ab_todo's later, or moved there from its thread), which stays there.
        state.tasks[op.tid] = { id: op.tid, owner: op.owner, text: op.text, workspace: op.workspace || null, agent: op.agent || null, rank: op.rank ?? 0, at: op.added || now, done: !!op.done, done_at: op.done ? op.done_at || now : null, sent: op.sent || [], posts: [...(op.posts || [])], ...(op.from ? { from: op.from } : {}), ...(op.source ? { source: op.source } : {}), ...(Array.isArray(op.answers) && op.answers.length ? { answers: op.answers } : {}), pages: [], ...(op.group ? { group: op.group } : {}), ...(op.note ? { note: op.note } : {}), ...(op.scope === "thread" ? { scope: "thread" } : op.later ? { later: true } : {}) };
        for (const e of state.tasks[op.tid].sent) linkPost(state.tasks[op.tid], e.post, e.at, "sent");
        for (const e of [...(op.pages || []), ...(op.page ? [op.page] : [])]) linkPage(state.tasks[op.tid], typeof e === "string" ? e : e?.page, e?.at || now, e?.by || (op.from ? "agent" : "you"));
        // In a group, its posts hear of it (not when Undo puts one back, nor a thread's own to-do).
        if (!op.done && !op.sent?.length && !op.scope) taskNews(state, state.tasks[op.tid], "added", op, now);
        break;
      }
      // A to-do onto its thread (scope "thread"), or onto your Tasks (scope null) from its thread.
      case "task.scope": {
        const t = state.tasks[op.tid];
        if (!t) break;
        // On its thread, it's in no group (the group's threads don't hear of it); on your Tasks, it stays there.
        if (op.scope === "thread") {
          t.scope = "thread";
          delete t.group;
          delete t.later;
        } else {
          delete t.scope;
          t.later = true;
        }
        break;
      }
      case "task.edit": {
        const t = state.tasks[op.tid];
        if (!t) break;
        if (op.text) t.text = op.text;
        if (op.workspace !== undefined) t.workspace = op.workspace;
        if (op.agent !== undefined) t.agent = op.agent;
        // From before a task had pages: the one it's on now.
        if (op.page !== undefined) {
          t.pages = op.page ? [{ page: op.page, at: now, by: "you" }] : [];
          delete t.page;
        }
        if (op.group !== undefined && (op.group || null) !== (t.group || null)) {
          t.group = op.group || null;
          if (!t.done) taskNews(state, t, "added", op, now);
        }
        if (op.note !== undefined) t.note = op.note || null;
        break;
      }
      case "task.done": {
        const t = state.tasks[op.tid];
        if (!t) break;
        const was = t.done;
        Object.assign(t, tick(op, now));
        if (was !== t.done) taskNews(state, t, t.done ? "done" : "undone", op, now);
        break;
      }
      case "task.sync": {
        // What a connector learned about a task's issue: its title (the task's text, unless you edited that
        // here, and what a long one puts in its note), its state, and whether it's done there. `done_by` tells a
        // task it ticked from one you ticked.
        const t = state.tasks[op.tid];
        if (!t) break;
        if (op.text) t.text = op.text;
        if (op.note !== undefined) t.note = op.note || null;
        if (op.source) t.source = { ...t.source, ...op.source };
        if (typeof op.done === "boolean" && op.done !== t.done) Object.assign(t, { done: op.done, done_at: op.done ? now : null, done_by: op.done ? "sync" : null, done_post: null });
        break;
      }
      case "task.move": {
        // Its owner's place for it on their list (`rank`), or, `user`, someone it's shared with's on theirs.
        const t = state.tasks[op.tid];
        if (!t) break;
        if (op.user && op.user !== t.owner) (t.ranks ||= {})[op.user] = op.rank;
        else t.rank = op.rank;
        break;
      }
      // Someone on a task besides its owner: `people`, their account ids, each on it since
      // `at`, added `by` (its owner's username), with their own place for it on their list (`ranks`); or taken off
      // (`remove`), as when they leave it.
      case "task.person": {
        const t = state.tasks[op.tid];
        if (!t || !op.user || op.user === t.owner) break;
        const people = t.people || [];
        if (op.remove) {
          t.people = people.filter((x) => x.user !== op.user);
          if (t.ranks) delete t.ranks[op.user];
        } else if (!people.some((x) => x.user === op.user)) {
          t.people = [...people, { user: op.user, at: now, by: op.by || null }];
          if (Number.isFinite(op.rank)) (t.ranks ||= {})[op.user] = op.rank;
        }
        if (!t.people.length) delete t.people;
        if (t.ranks && !Object.keys(t.ranks).length) delete t.ranks;
        break;
      }
      // Who sees a task besides its people: nobody (private, the default) or anyone signed in (public); and whether its
      // people see its threads' steps and changes (`show_work`, on unless turned off).
      case "task.visibility": {
        const t = state.tasks[op.tid];
        if (!t) break;
        if (op.visibility) {
          if (op.visibility === "public" || op.visibility === "followers") t.visibility = op.visibility;
          else delete t.visibility;
        }
        if (typeof op.show_work === "boolean") {
          if (op.show_work) delete t.show_work;
          else t.show_work = false;
        }
        break;
      }
      case "task.remove": {
        // A task from a connector stays, out of sight, so the next sync doesn't bring its issue back.
        const t = state.tasks[op.tid];
        if (t?.source && !op.forget) t.removed = now;
        else delete state.tasks[op.tid];
        break;
      }
      case "task.restore": {
        if (state.tasks[op.tid]) state.tasks[op.tid].removed = null;
        break;
      }
      case "task.send": {
        // Sent to an agent: the session its launch starts is the task's. It may have started already.
        const t = state.tasks[op.tid];
        if (!t) break;
        t.sent.push({ launch: op.launch, agent: op.agent || null, post: state.launches[op.launch]?.post || null, at: now, ...(op.user ? { user: op.user } : {}) });
        linkPost(t, t.sent.at(-1).post, now, "sent");
        break;
      }
      case "task.linked": {
        // A session on another machine, which this one hears of from the hub.
        const e = state.tasks[op.tid]?.sent.find((x) => x.launch === op.launch);
        if (!e) break;
        e.post = op.post;
        linkPost(state.tasks[op.tid], op.post, now, "sent");
        break;
      }
      case "task.page": {
        // A page linked to a task, or unlinked (`linked: false`); with no page, one from before gets its `pages`.
        const t = state.tasks[op.tid];
        if (!t) break;
        taskPages(t);
        if (!op.page) break;
        if (op.linked === false) t.pages = t.pages.filter((e) => e.page !== op.page);
        else linkPage(t, op.page, now, op.by === "agent" ? "agent" : "you");
        break;
      }
      case "task.link": {
        // A post linked to a task, or unlinked (`linked: false`), by the person or by an agent from its post.
        const t = state.tasks[op.tid];
        if (!t) break;
        if (op.linked === false) t.posts = t.posts.filter((e) => e.post !== op.post);
        else linkPost(t, op.post, now, op.by ? "agent" : "you", op.user);
        break;
      }
      case "page.create":
      case "page.write":
      case "page.restore":
      case "page.visibility":
      case "page.color":
      case "page.contributor":
      case "page.archive":
      case "page.post":
      case "page.told":
        applyPage(state, op, now); // pages.mjs
        break;
      case "note.create":
      case "note.write":
      case "note.archive":
      case "note.visibility":
      case "note.person":
      case "note.comment":
      case "note.reply":
      case "note.thread":
      case "note.resolve":
      case "note.suggest":
      case "note.settle":
      case "note.ref":
        applyNote(state, op, now); // notes.mjs
        break;
      case "routine.write":
      case "routine.test":
      case "routine.ok":
      case "routine.signed":
      case "routine.on":
      case "routine.fix":
      case "routine.run":
      case "routine.archive":
      case "routine.restore":
      case "routine.remove":
        applyRoutine(state, op, now); // routines.mjs
        break;
      case "group.create":
      case "group.edit":
      case "group.member":
      case "group.post":
      case "group.note":
      case "group.note.remove":
      case "group.file":
      case "group.wip":
      case "group.archive":
      case "group.visibility":
      case "group.seen":
      case "group.news":
        applyGroup(state, op, now); // groups.mjs
        break;
      case "thread.guest":
      case "thread.seen":
        applyGuest(state, op, now); // guests.mjs
        break;
      case "talk.create":
      case "talk.say":
      case "talk.sent":
      case "talk.title":
      case "talk.flag":
      case "talk.visibility":
        applyTalk(state, op, now); // talks.mjs
        break;
      case "task.item":
      case "task.pr":
      case "task.seen":
      case "task.order":
      case "task.landing":
      case "task.asked":
      case "task.ship":
        applyTaskShip(state, op, now); // task-ship.mjs
        break;
      case "agent.follow": {
        // Who follows an agent, at what level, by `${agent}|${user}` (the page's agent
        // id, the follower's account id). `level`: public, private or operate (with `granted`: its owner gave it), or
        // null to clear it; `ask`: "follow" (to follow it, or for more: its owner picks the level), a level asked for, or
        // null; `remove`: gone. One with neither a level nor an ask goes.
        if (!op.agent || !op.user) break;
        const key = `${op.agent}|${op.user}`;
        const follows = (state.agent_follows ||= {});
        if (op.remove) {
          delete follows[key];
          break;
        }
        const f = (follows[key] ||= { agent: op.agent, user: op.user, at: now });
        if ("level" in op) {
          if (["public", "private", "operate"].includes(op.level)) Object.assign(f, { level: op.level, granted: !!op.granted, by: op.by || null, level_at: now });
          else for (const k of ["level", "granted", "by", "level_at"]) delete f[k];
        }
        if ("ask" in op) {
          if (["follow", "private", "operate"].includes(op.ask)) Object.assign(f, { ask: op.ask, ask_at: now });
          else for (const k of ["ask", "ask_at"]) delete f[k];
        }
        if (!f.level && !f.ask) delete follows[key];
        break;
      }
      case "person.follow": {
        // Who follows a person, at what level, by `${person}|${user}` (account ids: the one
        // followed, the follower). `level`: public or private, which the person gave, as every follow is theirs
        // to approve, or null to clear it;
        // `ask`: "follow" (to follow them, or for more: they pick the level), or null; `remove`: gone. One with neither
        // a level nor an ask goes.
        if (!op.person || !op.user || op.person === op.user) break;
        const key = `${op.person}|${op.user}`;
        const follows = (state.person_follows ||= {});
        if (op.remove) {
          delete follows[key];
          break;
        }
        const f = (follows[key] ||= { person: op.person, user: op.user, at: now });
        if ("level" in op) {
          if (["public", "private"].includes(op.level)) Object.assign(f, { level: op.level, by: op.by || null, level_at: now });
          else for (const k of ["level", "by", "level_at"]) delete f[k];
        }
        if ("ask" in op) {
          if (op.ask === "follow") Object.assign(f, { ask: "follow", ask_at: now });
          else for (const k of ["ask", "ask_at"]) delete f[k];
        }
        if (!f.level && !f.ask) delete follows[key];
        break;
      }
      // Once, when the feed became what you follow: everyone then followed every public agent there
      // was, on their own (Public), so nothing left their feed. `seeded` says it's done; it's no one's follow.
      case "follows.seed": {
        const all = (state.agent_follows ||= {});
        if (all.seeded) break;
        for (const pair of Array.isArray(op.pairs) ? op.pairs : []) {
          const [agent, user] = Array.isArray(pair) ? pair : [];
          if (typeof agent !== "string" || typeof user !== "string" || !agent || !user || all[`${agent}|${user}`]) continue;
          all[`${agent}|${user}`] = { agent, user, at: now, level: "public", granted: false, by: null, level_at: now, seeded: true };
        }
        all.seeded = { at: now };
        break;
      }
      case "bell.seen": {
        // When a person last opened the bell (server only): what someone put them in since then is news for it, once.
        if (!op.user) break;
        (state.bell_seen ||= {})[op.user] = now;
        break;
      }
      case "bell.dismiss": {
        // A line a person took off the bell (server only): `key` says which (a failed routine, a question, a thread
        // that ended asking, news), `failed` when what they dismissed happened, so a later one is on it again. Their
        // newest 200.
        if (!op.user || !op.key) break;
        const mine = ((state.bell_dismissed ||= {})[op.user] ||= {});
        delete mine[op.key];
        mine[op.key] = op.failed || "";
        for (const k of Object.keys(mine).slice(0, -200)) delete mine[k];
        break;
      }
      case "feed.archive": {
        // A page's update a person archived off their feed (server only): `moved` is when the page last moved up the
        // feed, so its next change is news again and shows. `on: false` brings it back. Their newest 200.
        if (!op.user || !op.page) break;
        const mine = ((state.feed_archived ||= {})[op.user] ||= {});
        delete mine[op.page];
        if (op.on !== false) mine[op.page] = op.moved || "";
        for (const k of Object.keys(mine).slice(0, -200)) delete mine[k];
        break;
      }
      case "routine.thread": {
        // A thread started on a routine from its page (server only, routine-threads.mjs): `key` says which routine,
        // `lid` the launch it went out as. Its newest 20.
        if (!op.key || !op.lid) break;
        const list = ((state.routine_threads ||= {})[op.key] ||= []);
        if (list.some((x) => x.lid === op.lid)) break;
        list.push({ lid: op.lid, agent: op.agent || null, at: now, ...(op.user ? { user: op.user } : {}) });
        list.splice(0, Math.max(0, list.length - 20));
        break;
      }
      case "prefs.set": {
        // A person's settings on their profile (server only): Auto-archive (`auto_archive`, and since when it's on) and
        // Private terminals (`private_terminals`). Each is off until they turn it on.
        if (!op.user) break;
        const p = ((state.prefs ||= {})[op.user] ||= {});
        for (const k of ["auto_archive", "private_terminals"]) {
          if (typeof op[k] !== "boolean" || !!p[k] === op[k]) continue;
          p[k] = op[k];
          p[`${k}_at`] = now;
        }
        break;
      }
      case "machine.cloud": {
        // The cloud sandbox a machine runs in (server only): which boat connector of its
        // owner's wakes it, and which sandbox. None: unlinked.
        if (!op.device) break;
        const all = (state.machine_cloud ||= {});
        // `github`: whether git on it signs in to GitHub as its owner, with their GitHub connector (on unless turned off).
        // `made`: agentbook made the sandbox, from an image of its owner's (`image`, at version `v`; `size`), with a
        // boat environment for its secrets (`env`, boat's id for it; `secrets`, their names, never their values).
        const made = op.made ? { made: true, image: op.image || null, v: op.v ?? null, size: op.size || null, env: op.env || null, env_name: op.env_name || null, secrets: Array.isArray(op.secrets) ? op.secrets.map(String) : [], ...(op.setting ? { setting: true } : {}) } : {};
        if (op.sandbox && op.connector) all[op.device] = { connector: String(op.connector), sandbox: String(op.sandbox), at: now, ...(op.github === false ? { github: false } : {}), ...made };
        else if (typeof op.github === "boolean" && all[op.device]) all[op.device] = { ...all[op.device], github: op.github };
        // What changed on one agentbook made: its image's version after an Update, its secrets' names, its setup done.
        else if (op.patch && all[op.device]) {
          const next = { ...all[op.device] };
          for (const k of ["v", "image", "secrets", "setting", "setup_error", "updating", "gone"]) if (k in op.patch) next[k] = op.patch[k];
          for (const k of ["setting", "setup_error", "updating", "gone"]) if (next[k] == null || next[k] === false) delete next[k];
          all[op.device] = next;
        } else delete all[op.device];
        break;
      }
      case "box.member": {
        // Who's on a shared machine (server only). `box`: the machine
        // that's shared, its owner's (`owner`, an account id). `member`: an account id, `user` their username, with
        // `state`: "invited" (the owner added them, and their seat is made there once `seated`), then "joined" (they
        // logged their seat in: `device`, their own machine for it). `remove`: they left, or were taken off.
        if (!op.box || !op.member) break;
        const all = (state.boxes ||= {});
        const b = (all[op.box] ||= { id: op.box, owner: op.owner || null, members: {} });
        if (op.remove) {
          delete b.members[op.member];
          if (!Object.keys(b.members).length) delete all[op.box];
          break;
        }
        const was = b.members[op.member];
        b.members[op.member] = { user: String(op.user || was?.user || ""), state: op.state === "joined" ? "joined" : "invited", seated: op.seated ?? was?.seated ?? false, device: op.device ?? was?.device ?? null, at: was?.at || now, ...(op.state === "joined" ? { joined: was?.joined || now } : {}) };
        break;
      }
      case "box.remove": {
        // The machine is no longer shared (it was deleted or disconnected): nobody's on it.
        if (op.box && state.boxes) delete state.boxes[op.box];
        break;
      }
      case "image.save": {
        // An image (server only): what a cloud machine of its owner's starts with, as a
        // draft they edit. `def`: its picks, repos, steps and settings, with secrets as names only. Building it makes
        // a version (image.build).
        if (!op.image || !op.owner) break;
        const all = (state.images ||= {});
        const was = all[op.image];
        if (was && was.owner !== op.owner) break;
        all[op.image] = { id: op.image, owner: op.owner, connector: op.connector || was?.connector || null, name: String(op.name || was?.name || op.image).slice(0, 60), def: op.def || was?.def || {}, v: was?.v || 0, created: was?.created || now, updated: now };
        break;
      }
      case "image.remove": {
        if (!op.image || !state.images?.[op.image]) break;
        delete state.images[op.image];
        for (const [id, b] of Object.entries(state.image_builds || {})) if (b.image === op.image) delete state.image_builds[id];
        break;
      }
      case "image.build": {
        // A build: one version of an image being made into a disk (a boat saved snapshot), on a builder sandbox.
        // It keeps the definition it was built from, and what the builder said.
        const img = state.images?.[op.image];
        if (!op.build || !img) break;
        (state.image_builds ||= {})[op.build] = { id: op.build, image: op.image, v: op.v, owner: img.owner, connector: op.connector || img.connector, def: op.def || img.def, cli: op.cli || null, snapshot: op.snapshot || null, sandbox: op.sandbox || null, state: "building", started: now, ended: null, error: null, log: "" };
        img.v = Math.max(img.v || 0, op.v || 0);
        break;
      }
      case "image.built": {
        // How a build is going, or ended: `patch` over its record (state: building, saving, ready, failed, gone).
        const b = state.image_builds?.[op.build];
        if (!b || !op.patch) break;
        for (const k of ["state", "sandbox", "error", "log", "ended", "step"]) if (k in op.patch) b[k] = op.patch[k];
        if (["ready", "failed"].includes(op.patch.state) && !b.ended) b.ended = now;
        break;
      }
      case "auto.archived": {
        // Threads Auto-archive archived once their work merged or landed (server only), each once: one brought back
        // stays. `skipped`: the ones done already when it was turned on, which it leaves as they are.
        if (!op.user || !Array.isArray(op.posts)) break;
        const all = (state.auto_archived ||= {});
        for (const x of op.posts) if (x?.post && !all[x.post]) all[x.post] = { user: op.user, at: now, why: x.why || null, title: x.title || null, ...(op.skipped ? { skipped: true } : {}) };
        break;
      }
      case "news.add": {
        // News for a person's bell (server only, server/news.mjs): what a thread of theirs did that's worth hearing
        // about, { kind: "turn" | "pr" | "flag", post, text, … }. `key` says what it's about: said once, however many
        // threads say it (a pull request's line again an hour later is news again: its checks failed a second time).
        // Their newest 50.
        if (!op.user || !Array.isArray(op.items)) break;
        const list = ((state.news ||= {})[op.user] ||= []);
        const same = (x, y) => y.key === x.key && (x.kind !== "pr" || Date.parse(now) - Date.parse(y.at) < 3600e3);
        for (const x of op.items) {
          if (!x?.post || !["turn", "pr", "flag"].includes(x.kind) || (x.key && list.some((y) => same(x, y)))) continue;
          list.push({ ...x, text: String(x.text || ""), at: now });
        }
        list.splice(0, Math.max(0, list.length - 50));
        break;
      }
      case "private.off": {
        // Private terminals (server only): the threads of a person's that were on agentbook when they turned it on,
        // and weren't started in agentbook, are off every list while it's on (`posts`, the page's ids); `clear`:
        // turned off, they're back.
        if (!op.user) break;
        const all = (state.private_off ||= {});
        if (op.clear) for (const k of Object.keys(all)) if (all[k] === op.user) delete all[k];
        for (const id of Array.isArray(op.posts) ? op.posts : []) if (typeof id === "string") all[id] = op.user;
        break;
      }
      case "wip.moved": {
        // A WIP of many from before tasks held pull requests: its task has what it had
        // (`task`), or, one agentbook made for a thread, it's put away. Nothing else reads them.
        const w = state.wip_sets?.[op.sid];
        if (!w) break;
        w.archived ||= now;
        w.moved = op.task || null;
        break;
      }
      case "event.deliver": {
        // Something for a post that isn't a message or an answer to its own question (the answer to one the server
        // asked on it), delivered like one.
        if (post && op.event && typeof op.event === "object") deliver(op.event);
        break;
      }
      case "outbox.ack": {
        const set = new Set(op.oids);
        for (const o of state.outbox) if (set.has(o.oid)) o.delivered = true;
        state.outbox = state.outbox.filter((o) => !o.delivered || Date.parse(now) - Date.parse(o.at) < 3600e3);
        break;
      }
    }
  }

  // A session takes over the launch it answers: the placeholder goes, and its files join the post. (One started in a
  // group joins it on the server, which keeps groups.)
  function adopt(l, key, op) {
    Object.assign(l, { post: key, arrived: true });
    if (state.sessions[key]) state.sessions[key].launch = l.id;
    // A side thread: started from the thread it forked, and its own from when it was made (its transcript has that
    // thread's conversation before it: transcript.mjs).
    if (l.side_of && state.sessions[key] && l.side_of !== key) Object.assign(state.sessions[key], { started_from: l.side_of, side_at: l.at });
    // Posted as private or public, unlike its agent: the post keeps that.
    if (l.visibility && state.sessions[key] && state.sessions[key].visibility == null) state.sessions[key].visibility = l.visibility;
    for (const f of state.files) if (l.files?.includes(f.id)) Object.assign(f, { post: key, pending: false });
    for (const t of Object.values(state.tasks))
      for (const e of t.sent)
        if (e.launch === l.id && !e.post) {
          e.post = key;
          linkPost(t, key, e.at, "sent");
        }
    // Teleported here: the post links back to the cloud session it came from.
    const s = state.sessions[key];
    if (l.teleport && s && !s.attachments.cloud) {
      const url = `https://claude.ai/code/${l.teleport}`;
      s.attachments.cloud = { key: "cloud", type: "link", title: "Teleported from claude.ai", data: { url, title: "Teleported from claude.ai", text: "Its conversation came from this cloud session. What it does from here stays on this machine." }, created: s.updated || l.at, updated: s.updated || l.at };
    }
  }

  const replay = (op) => {
    try {
      apply(op);
    } catch (e) {
      console.error(`agentbook: skipped op ${op.seq} (${op.t}):`, e.message);
    }
  };

  fs.mkdirSync(home, { recursive: true });
  // What's saved, read whole before `state` is touched, so a database that turns out corrupt leaves nothing to undo.
  // `moveCorrupt` is agentbook-cli's alone, as what's saved there also went to its server: the store of everything
  // else gets the error, and stays where it is.
  const read = (moved = false) => {
    const db = new DatabaseSync(file);
    try {
      migrate(db);
      const tables = createTables(db);
      if (legacy && tables.empty() && fs.existsSync(LOG)) return { db, tables };
      const saved = tables.load();
      return { db, tables, saved, ops: tables.since(saved.checkpoint) };
    } catch (e) {
      if (!moveCorrupt || moved || !isCorrupt(e)) {
        leaveOpen(file, db);
        throw e;
      }
      console.error(`agentbook: can't read ${file} (${e.message}): moved to ${moveAside(file, db)}, with its -wal and -shm if it had them, and starting a new one`);
      return read(true);
    }
  };
  const { db, tables, saved, ops: logged } = read();
  if (!saved) {
    // Before the database, ops went to events.jsonl. Replay it once, keep its ops, and keep the file.
    const ops = [];
    for (const line of fs.readFileSync(LOG, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        ops.push(JSON.parse(line));
      } catch (e) {
        console.error("agentbook: skipped a bad log line:", e.message);
      }
    }
    for (const op of ops) replay(op);
    transaction(db, () => ops.forEach((op) => tables.log(op)));
    tables.checkpoint(state);
    fs.renameSync(LOG, `${LOG}.imported`);
    console.log(`agentbook: moved ${ops.length} events from events.jsonl into ${file}`);
  } else {
    Object.assign(state, saved.state, { seq: saved.seq });
    // Tasks saved before they had posts: theirs are the posts they were sent to.
    for (const t of Object.values(state.tasks)) {
      if (t.posts) continue;
      t.posts = [];
      for (const e of t.sent) linkPost(t, e.post, e.at, "sent");
    }
    for (const op of logged) replay(op);
  }
  // Posts saved when sessions could be paused drop what that left on them.
  for (const s of Object.values(state.sessions)) delete s.paused, delete s.stopped;

  // Write the state now and then, and at exit; between checkpoints, the logged ops cover it. What's written can
  // go back to the database (settle).
  // The last op its server has (`acks`): what the log may prune goes no further. 0 until a server first says.
  let acked = Number(tables.meta("acked") || 0);
  let checkpointed = state.seq;
  const checkpoint = (force = false) => {
    if (state.seq === checkpointed && !force) return;
    tables.checkpoint(state);
    if (acks) tables.prune(Math.min(state.seq, acked), ACKED_DAYS);
    else tables.prune(state.seq);
    checkpointed = state.seq;
    settle();
  };
  // Starting up loads every thread's history; past the limit, what was used least lately goes back now.
  if (state.messages.length > LIMITS.messages) checkpoint(true);
  let failing = null; // what the last checkpoint failed with
  const checkpointTimer = setInterval(() => {
    try {
      checkpoint();
      if (failing) console.log("agentbook: checkpoints work again");
      failing = null;
    } catch (e) {
      // Said once: a full disk stays full, and this runs every few seconds.
      if (e.message !== failing) console.error("agentbook: checkpoint failed:", e.message);
      failing = e.message;
    }
  }, CHECKPOINT_MS).unref();
  process.on("exit", () => {
    try {
      checkpoint();
      db.close();
    } catch {}
  });
  // `agentbook stop` and Ctrl+C end the process through "exit", so the last checkpoint gets written.
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => process.exit(0));

  // An op takes the next number, and the ids of what it makes are written on it (`m<seq>` for a message, `q<seq>`
  // for a question, `f<seq>` for a file), so another store applying the same op makes the same things.
  const stamp = (op, seq) => {
    if (op.t === "message.add" && !op.mid) return { ...op, mid: `m${seq}` };
    if (op.t === "question.ask" && !op.qid) return { ...op, qid: `q${seq}` };
    if (op.t === "file.add" && !op.fid) return { ...op, fid: `f${seq}` };
    // A thread's name too: picked here (freeName), so agentbook-server's copy of this machine's threads, where
    // which ones are open can differ for a moment, names it the same.
    if (op.t === "session.hello" && op.label && !op.named) return { ...op, label: freeName(state, op, op.session_id || op.proc), named: true };
    return op;
  };
  // Logged before it's applied: one the log couldn't take (a full disk, a locked database) changes nothing, and its
  // error says so (`unsaved`), so what sent it can send it again. Past the log it's kept, whatever applying it does.
  function record(op, at) {
    const seq = state.seq + 1;
    const full = { ...stamp(op, seq), seq, at };
    try {
      tables.log(full);
    } catch (e) {
      throw Object.assign(e, { unsaved: true });
    }
    apply(full);
    for (const fn of listeners) fn(full);
    return full;
  }

  return {
    state,
    db,
    file,
    filesDir,
    checkpoint,
    saveFailing: () => failing,
    // Drop the logged ops the last checkpoint covers, older than `days` (0: all of them), ahead of the pruning each
    // checkpoint does: after a deletion, so nothing of what went stays in the log.
    pruneLog: (days = 0) => tables.prune(checkpointed, days),
    commit: (op) => record(op, new Date().toISOString()),
    // An op from elsewhere (a machine's, on the server), as it happened there: when, and the ids it made.
    ingest: (op) => record(op, op.at || new Date().toISOString()),
    onChange: (fn) => listeners.add(fn),
    pending: (post) => state.outbox.filter((o) => o.post === post && queued(o)),
    // The ops after `seq`, oldest first (the CLI sends them to its server).
    since: (seq) => tables.since(seq),
    // What its server has of it (`acks`): the last op it acknowledged, which may go back (a server restored from a
    // backup has less than it said before). And the last op the log pruned: a server with less than that can't get
    // everything again from the log.
    acked: () => acked,
    setAcked(seq) {
      if (!Number.isFinite(seq) || seq === acked) return;
      tables.setMeta("acked", seq);
      acked = seq;
    },
    pruned: () => Number(tables.meta("pruned") || 0),
    // A part of every thread's history (HISTORY), with what's out of memory, in its order: for a server that has
    // nothing of this machine yet.
    whole: (part) => (cold.size ? tables.inOrder(part, [...state[part], ...tables.rows(part, (p) => cold.has(p))]) : state[part]),
    close() {
      clearInterval(checkpointTimer);
      checkpoint();
      db.close();
    },
  };
}

// What waits in the outbox to be delivered: not yet, not set aside because it couldn't be (message.fail), and not
// held in its post's queue for its turn to end (message.release).
export const queued = (o) => !o.delivered && !o.failed && !o.held;

// A thread's history (its questions, files and messages) in memory, back from the database if it was out. Before
// reading any of it for one thread: memory may hold none of it (createStore's warm).
export const warm = (state, post) => state.cold?.warm(post);
// A thread's conversation, whole.
export const conversationOf = (state, post) => (warm(state, post), state.messages.filter((m) => m.post === post));
// A file by its id, with its thread's history back in memory; null when there's none.
export const fileOf = (state, fid) => state.files.find((f) => f.id === fid) || (state.cold?.file(fid), state.files.find((f) => f.id === fid)) || null;
// What memory doesn't hold of a part of threads' histories ("questions", "files", "messages"), from the database:
// copies, which nothing changes. `posts`: only those threads'.
export const outOfMemory = (state, part, posts = null) => state.cold?.rows(part, posts) || [];
// What the feed shows of a thread's history: how many messages (not those queued) and files (not those in a page
// or not sent yet), the latest few of each, its latest pictures (its card's cover) and its life (its strip). Kept for
// a thread whose history is out of memory.
const COVER = 7;
function feedOf(messages = [], files = [], questions = [], s = null) {
  const said = messages.filter((m) => !m.queued);
  const shown = files.filter((f) => !f.embedded && !f.pending);
  const pics = shown.filter(isPicture);
  return { messages: said.length, last_messages: said.slice(-3), files: shown.length, last_files: shown.slice(0, 3), pictures: pics.length, last_pictures: pics.slice(0, COVER), life: s ? lifeOf(s, { messages, questions, files: shown }) : null };
}

// Its pictures, newest first: as kept when its history went out of memory, or from its files.
function picturesOf(out, files) {
  if (out?.last_pictures) return { pictures: out.pictures, last_pictures: out.last_pictures };
  const pics = out ? (out.last_files || []).filter(isPicture) : files.filter(isPicture);
  return { pictures: pics.length, last_pictures: pics.slice(0, COVER) };
}

// API errors that pass with time (Claude Code's kinds of them): the network dropped, the computer slept mid-reply, the
// API was overloaded. agentbook-cli picks a background session up again after one of these. Any other (its login
// expired, its account, a usage limit, a refused request) stops it until someone does something, so it needs you.
export const PASSING_ERRORS = new Set(["server_error", "overloaded"]);
const stopped = (s) => !s.busy && !s.archived && !!s.failed && !PASSING_ERRORS.has(s.failed.error);
// What stopped it, in a line: the first thing Claude Code said, without the link it gives.
const stopLine = (f) => (f.text || "An API error ended its turn").split(/(?<=\.)\s/)[0].replace(/\s*\(https?:[^)]*\)/, "");

// The verdicts (ab_verdict) a turn ends on when it can't go on without you: it needs your decision or OK, or it's
// blocked on something only you can fix.
const ASKING = new Set(["needs_you", "blocked"]);
// What a thread's last turn ended asking of you, from its latest messages (`said`, none of them queued): its verdict
// ({ kind, line }) when the last thing said is the agent's reply that ended a turn on one of those, else null. You
// writing to it (a routine's run too) comes after it; answering what it asked wakes it, and then it's working. What you
// sent on the side (via "side") went to a side thread, not to it: it's still asking.
export function endedAsking(said) {
  const m = said?.filter((x) => x.via !== "side").at(-1);
  const v = m?.from === "agent" ? m.shape?.verdict : null;
  return v && ASKING.has(v.kind) ? { kind: v.kind, line: String(v.line || ""), at: m.at } : null;
}

// A session's state in a word: done, needs (you), working, or idle between turns. One that's asleep is done
// too, unless it asked you something: either way it isn't running, and writing to it picks it back up. One with
// work going on its own between turns (`going`: a shell watching a CI run, a monitor) is working on that. One an API
// error stopped needs you (`stopped`), and so does one whose turn ended saying it needs you or is blocked (`asking`,
// endedAsking), until you write to it or archive it.
export function effective(s, open, going = 0, asking = null) {
  if (s.state === "done") return "done";
  if (open || s.state === "waiting") return "needs";
  // It can't go on until you do.
  if (stopped(s)) return "needs";
  if (s.busy || s.state === "working" || (going && !s.asleep)) return "working";
  if (asking && !s.archived) return "needs";
  return s.asleep ? "done" : "idle";
}
// Its state (`effective`), and, when it isn't a question or a prompt that makes it need you, what does (`asking`), for
// the bell to list with the questions: the error that stopped it, or its last turn's verdict.
function stateOf(s, open, going, said) {
  const asking = endedAsking(said);
  const e = effective(s, open, going, asking);
  if (e !== "needs" || open || s.state === "waiting") return { effective: e };
  return { effective: e, asking: stopped(s) ? { kind: "stopped", line: stopLine(s.failed), at: s.failed.at } : asking };
}

// Without a title of its own, its prompt's first line, with the pages and widgets it names in words.
const titleOf = (s, pages = {}) => s.title || s.ai_title || (s.prompt ? plainMentions(s.prompt.split("\n")[0], pages).slice(0, 120) : null) || "New thread";

// The feed: every post in summary, plus what needs you. Full conversations load per session. `going(s)`: what a
// session has going between its turns, as its runtime knows it ([{ id, kind, title, started }]).
export function publicState(state, { going = () => null } = {}) {
  const open = {};
  const asked = {};
  for (const q of state.questions) {
    if (!q.answered) open[q.post] = (open[q.post] || 0) + 1;
    (asked[q.post] ||= []).push(q);
  }
  // Its conversation, and apart from it, what you queued for when its turn ends.
  const byPost = {};
  const queueOf = {};
  for (const m of state.messages) ((m.queued ? queueOf : byPost)[m.post] ||= []).push(m);
  const filesBy = {};
  for (const f of state.files) if (!f.embedded && !f.pending && f.post) (filesBy[f.post] ||= []).push(f);
  const pageOf = postPages(state);
  const sessions = Object.values(state.sessions).map((s) => {
    // One whose history is out of memory: as kept when it went (feedOf).
    const out = state.cold?.summary(s.id);
    const msgs = byPost[s.id] || [];
    // Its code blocks' runs are for its own page (sessionDetail), not every list it's in (a feed card gets those of
    // the messages it shows from the server, cardRuns).
    const { skills, skill_uses, runs, ...rest } = s;
    const work = s.state !== "done" && !s.asleep ? going(s) : null;
    const said = out ? out.last_messages : msgs.slice(-3);
    const how = stateOf(s, open[s.id], work?.length, said);
    return {
      ...rest,
      title: titleOf(s, state.pages),
      own_title: s.title,
      open_questions: open[s.id] || 0,
      ...how,
      ...(work?.length ? { going: work } : {}),
      messages: out ? out.messages : msgs.length,
      last_messages: said,
      ...(queueOf[s.id] ? { queue: queueOf[s.id] } : {}),
      files: out ? out.files : (filesBy[s.id] || []).length,
      last_files: out ? out.last_files : (filesBy[s.id] || []).slice(0, 3),
      ...picturesOf(out, filesBy[s.id] || []),
      life: out ? (out.life ?? null) : lifeKept(s, { messages: msgs, questions: asked[s.id] || [], files: filesBy[s.id] || [] }),
      updates: s.updates.slice(-5),
      page: pageOf[s.id] || null,
    };
  });
  sessions.sort((a, b) => b.updated.localeCompare(a.updated));
  const agents = Object.values(state.agents).map((a) => {
    const mine = sessions.filter((s) => s.agent === a.id);
    // What's live on it counts what's in the feed: an archived or hidden post isn't (unless it needs you).
    const count = (e) => mine.filter((s) => s.effective === e && ((!s.archived && !s.hidden) || e === "needs")).length;
    return { ...a, sessions: mine.length, working: count("working"), needs: count("needs"), idle: count("idle"), done: count("done") };
  });
  // The folders sessions ran in (a checkout's, for one in a worktree), each with how many and how lately.
  const folders = {};
  for (const s of sessions) {
    if (!s.root) continue;
    const f = (folders[s.root] ||= { root: s.root, name: s.repo || path.basename(s.root), sessions: 0, live: 0, last: s.updated });
    f.sessions++;
    if (s.effective !== "done" && !s.archived && !s.hidden) f.live++;
  }
  const recent = Date.now() - 3600e3;
  return {
    seq: state.seq,
    agents,
    sessions,
    folders: Object.values(folders).sort((a, b) => b.last.localeCompare(a.last)),
    questions: state.questions.filter((q) => !q.answered || Date.parse(q.answered) > recent),
    launches: Object.values(state.launches).filter((l) => Date.now() - Date.parse(l.at) < 600e3),
    pages: Object.values(state.pages).map((p) => pageSummary(p, state)).sort((a, b) => b.updated.localeCompare(a.updated)),
    groups: Object.values(state.groups).map((g) => groupSummary(state, g)).sort((a, b) => b.updated.localeCompare(a.updated)),
  };
}

// One post, in full.
// `going`: what it has going between its turns, as publicState's.
export function sessionDetail(state, key, { going = () => null } = {}) {
  const s = state.sessions[key];
  if (!s) return null;
  warm(state, key);
  const open = state.questions.filter((q) => q.post === key && !q.answered).length;
  const work = s.state !== "done" && !s.asleep ? going(s) : null;
  const messages = state.messages.filter((m) => m.post === key);
  return {
    ...s,
    title: titleOf(s, state.pages),
    own_title: s.title,
    open_questions: open,
    ...stateOf(s, open, work?.length, messages.filter((m) => !m.queued).slice(-1)),
    ...(work?.length ? { going: work } : {}),
    messages,
    files: state.files.filter((f) => f.post === key && !f.embedded && !f.pending),
    questions: state.questions.filter((q) => q.post === key),
    page: postPages(state)[key] || null,
    life: lifeOf(s, { messages: state.messages.filter((m) => m.post === key), questions: state.questions.filter((q) => q.post === key), files: state.files.filter((f) => f.post === key && !f.embedded && !f.pending) }),
  };
}
