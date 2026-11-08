// Live progress and session facts, from Claude Code's transcripts.
//
// Claude Code appends every step of a session to a JSONL transcript as it happens: what Claude says between
// tool calls, each tool call, each result, plus facts like the session's title ("ai-title"), its model, the
// pull requests it opened ("pr-link") and how long each turn took ("turn_duration"). agentbook follows
// those files and turns them into a digest per post: its steps, its plan (from TodoWrite), and a summary.
// Pictures the agent saw (a screenshot it took, an image it read) stay in the transcript, inside the tool's
// result: the digest counts them on their step, and reads them back when someone looks.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { COMMITS, diffTexts, filesChanged, noteEdit, shaIn, sizeOf } from "./changes.mjs";
import { notePrs } from "../shared/prs.mjs";
import { going, settle, stateOf } from "./workers.mjs";

const KEEP = 3000; // steps kept per session
const MAX_READ = 8 << 20; // never read more than this per poll
const FIRST_READ = 24 << 20; // how much of a transcript to read when first following it
const PROJECTS = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "projects");

const short = (s, n = 90) => {
  s = String(s ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};
// What an agent said, as it wrote it (its lines kept: a thread's page shows it in its conversation), up to a few pages.
export const said = (s, n = 4000) => {
  s = String(s ?? "").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};
// The step a session is on, for the live line: of what it said, just its first line.
export const liveStep = (st) => (st?.kind === "say" ? { ...st, text: short(st.text.split("\n")[0], 300) } : st);

// One line for a tool call, in the same voice as Claude Code's Bash descriptions ("Run the tests").
// ab_search and ab_thread_read, under whatever name an agent has them (mcp__plugin_agentbook_agentbook__ab_search,
// mcp__agentbook__ab_search, ab_search): the agentbook tools that are steps, on every agent.
export const SEEN_TOOL = /(?:^|_)ab_(?:search|thread_read)$/;
export function seenTitle(name, input) {
  let a = input;
  if (typeof a === "string") {
    try {
      a = JSON.parse(a);
    } catch {
      a = {};
    }
  }
  a ||= {};
  if (/ab_search$/.test(name)) return `Search threads for "${short(a.q, 80)}"`;
  return a.thread ? `Read thread ${short(a.thread, 60)}` : "Read this conversation";
}

export function describeTool(name, input = {}, cwd = "") {
  const rel = (p) => (p && cwd && String(p).startsWith(cwd + "/") ? String(p).slice(cwd.length + 1) : String(p || ""));
  const host = (u) => {
    try {
      return new URL(u).host;
    } catch {
      return short(u, 40);
    }
  };
  switch (name) {
    case "Bash":
      return input.description ? short(input.description) : `Run ${short(input.command, 70)}`;
    case "Read":
      return `Read ${short(rel(input.file_path), 70)}`;
    case "Edit":
    case "MultiEdit":
      return `Edit ${short(rel(input.file_path), 70)}`;
    case "Write":
      return `Write ${short(rel(input.file_path), 70)}`;
    case "NotebookEdit":
      return `Edit ${short(rel(input.notebook_path), 70)}`;
    case "Grep":
      return `Search for “${short(input.pattern, 50)}”`;
    case "Glob":
      return `Find files matching ${short(input.pattern, 50)}`;
    case "WebFetch":
      return `Read ${host(input.url)}`;
    case "WebSearch":
      return `Search the web for “${short(input.query, 60)}”`;
    case "Task":
    case "Agent":
      return `Subagent: ${short(input.description || input.prompt, 70)}`;
    case "Skill":
      return `Use the ${short(input.skill || input.command, 40)} skill`;
    case "TodoWrite": {
      const todos = input.todos || [];
      const now = todos.find((t) => t.status === "in_progress");
      return now ? `Plan: ${short(now.activeForm || now.content, 70)}` : "Update the plan";
    }
    case "CronCreate":
      return `${input.recurring === false ? "Schedule once" : "Loop"}: “${short(loopName(input.prompt), 50)}” (${short(input.cron, 30)})`;
    case "CronDelete":
      return `Stop the loop ${short(input.id, 20)}`;
    case "CronList":
      return "List its loops";
    case "ScheduleWakeup":
      return input.stop ? "Stop the loop" : `Check back in ${Math.round((Number(input.delaySeconds) || 60) / 60)}m${input.reason ? `: ${short(input.reason, 60)}` : ""}`;
    default: {
      if (SEEN_TOOL.test(name)) return seenTitle(name, input);
      if (name.startsWith("mcp__")) {
        const [, server = "", tool = ""] = name.split("__");
        // Chrome's and computer use's screenshots, whichever tool takes them.
        if (input.action === "screenshot" || /(^|_)screenshot$/.test(tool)) return "Take a screenshot";
        return `Use ${server.replace(/^plugin_[^_]+_/, "").replace(/^claude_ai_/, "")} ${tool.replace(/_mcp$/, "").replace(/[-_]/g, " ")}`;
      }
      return `Use ${name}`;
    }
  }
}

// Tools that show up on agentbook anyway, or say nothing about the work. Not ab_search and a read of what it found:
// you should see when an agent went through other threads, and for what.
const QUIET = (name) => (name.startsWith("mcp__plugin_agentbook_") && !SEEN_TOOL.test(name)) || name === "ToolSearch" || name === "TodoWrite";

// A prompt, typed or sent from agentbook, starts a turn, and so does one a loop fired. Tool results come back as
// user entries too.
const isPrompt = (e) => e.type === "user" && (!e.isMeta || e.turnOrigin === "scheduled") && !e.isSidechain && (typeof e.message?.content === "string" || (Array.isArray(e.message?.content) && e.message.content.some((b) => b.type === "text")));

// What Claude Code writes when Esc cuts a turn off, in a reply or in a tool it was running. It looks like a prompt and
// isn't one, and nothing else says so: no hook runs for it.
const isInterrupt = (e) => {
  const c = e.message?.content;
  const text = typeof c === "string" ? c : Array.isArray(c) && c.length === 1 ? c[0].text : "";
  return /^\[Request interrupted by user( for tool use)?\]$/.test(String(text || "").trim());
};

// `edits`: what the session changed in files (changes.mjs), each with where its tool result is in a transcript.
// `commits`: the commands that committed, and when. `shots`: where the results that hold images are, by step.
// `pictures`: those images' paths on this machine, where a result says. `subs`: the subagents followed for their
// edits and images. `workers`: those subagents as workers (noteWorker). `ran`: the slash commands it ran, and what
// each printed (noteRan).
function blank(file) {
  return { file, offset: 0, partial: Buffer.alloc(0), cut: false, n: 0, turn: 0, turns: [], steps: [], plan: null, model: null, ai_title: null, prs: {}, worked: 0, tools: 0, errors: 0, context: 0, skills: null, skill_uses: {}, edits: [], commits: [], shots: new Map(), pictures: new Set(), subs: null, workers: null, ran: [], changed: true };
}

// A slash command it ran, and what it printed. Claude Code keeps one that runs here
// (/context, /rename) as system entries, `<command-name>` then `<local-command-stdout>`, and one that goes on to a turn
// (/goal, a skill) as that turn's first user entries. Some also leave a Markdown copy for Claude, right after what they
// printed (/context's table), which reads better than the terminal's drawing. [{ id, at, name, args, out, md, outAt }]
const RAN_KEEP = 50;
const plainOut = (t) => String(t).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "").replace(/^\s*\n|\s+$/g, "");
function noteRan(d, e, text) {
  const t = String(text).trim();
  const name = t.startsWith("<command-") && /<command-name>\/?([^<\s]+)<\/command-name>/.exec(t)?.[1];
  if (name) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1] || "";
    d.ran.push({ id: e.uuid || `${d.n}`, at: e.timestamp || new Date().toISOString(), name, args: args.trim(), out: null, md: null, outAt: null, outId: null });
    if (d.ran.length > RAN_KEEP) d.ran.shift();
    d.changed = true;
    return;
  }
  const last = d.ran.at(-1);
  const out = /^<local-command-(stdout|stderr)>([\s\S]*)<\/local-command-\1>$/.exec(t);
  if (out && last && last.out == null) {
    Object.assign(last, { out: plainOut(out[2]), outAt: e.timestamp || new Date().toISOString(), outId: e.uuid || null });
    d.changed = true;
  } else if (e.isMeta && last?.outId && !last.md && e.parentUuid === last.outId && /^#{1,3} /.test(t)) {
    last.md = t;
    d.changed = true;
  }
}

// The images in a tool's result: a screenshot (Chrome, computer use), a picture it Read, one an MCP tool made.
const imagesIn = (b) => (Array.isArray(b?.content) ? b.content.filter((x) => x?.type === "image" && x.source?.type === "base64" && typeof x.source.data === "string") : []);

// Count a result's images on its step (a subagent's on the step that started it), and remember where they are.
function noteImages(d, step, n, span) {
  const spans = d.shots.get(step.id) || [];
  if (spans.some((x) => x.file === span.file && x.at === span.at)) return;
  spans.push({ ...span, n });
  d.shots.set(step.id, spans);
  step.images = (step.images || 0) + n;
}

// Where a result's images are on this machine: the picture it Read, or the screenshot it saved (Chrome's result
// says "Screenshot saved to: /var/folders/…/screenshot-1.png"). Its thread may open them, though they're outside
// the folders the machine shares (gate.mjs): its agent saw them, and the server keeps them already.
const PICTURE_FILE = /\.(png|jpe?g|gif|webp)$/i;
const SAVED_TO = /\bsaved (?:to|at|as):?\s+(\/\S+?\.(?:png|jpe?g|gif|webp))(?=$|[\s"'`<>,;.)\]])/gi;
function notePictures(d, b, n) {
  const read = d.reading?.get(b.tool_use_id);
  d.reading?.delete(b.tool_use_id);
  const saved = (Array.isArray(b.content) ? b.content : []).flatMap((x) => (x?.type === "text" ? [...String(x.text || "").matchAll(SAVED_TO)].map((m) => m[1]) : []));
  for (const p of [read, ...saved].filter(Boolean).slice(0, n)) {
    d.pictures.delete(p); // the newest last, so the oldest go first
    d.pictures.add(p);
  }
  while (d.pictures.size > 500) d.pictures.delete(d.pictures.values().next().value);
}
// A Read of a picture, from its tool_use until its result: the file it names.
function noteRead(d, b) {
  const p = b.name === "Read" ? String(b.input?.file_path || "") : "";
  if (!path.isAbsolute(p) || !PICTURE_FILE.test(p)) return;
  (d.reading ||= new Map()).set(b.id, p);
  if (d.reading.size > 200) d.reading.delete(d.reading.keys().next().value); // results that never came
}

/* ---------- what the session changed ---------- */

const EDITORS = new Set(["Edit", "MultiEdit", "Write"]);
const lineCount = (text) => String(text ?? "").split("\n").length - (String(text ?? "").endsWith("\n") ? 1 : 0);

// The files a tool result says changed: an Edit or Write's file, or what a command changed (Claude Code
// records that as bashEditDiff: each file with its hunks, and the names of the ones past its limit).
function editsIn(name, r) {
  if (!r || typeof r !== "object") return [];
  if (EDITORS.has(name) && r.filePath) {
    if (r.type === "create") return [{ abs: r.filePath, kind: "create", add: lineCount(r.content), del: 0 }];
    if (Array.isArray(r.structuredPatch)) return [{ abs: r.filePath, kind: "edit", ...sizeOf(r.structuredPatch) }];
    // Older versions say only what text it replaced.
    return typeof r.oldString === "string" && typeof r.newString === "string" ? [{ abs: r.filePath, kind: "edit", ...sizeOf(diffTexts(r.oldString, r.newString)) }] : [];
  }
  const bd = r.bashEditDiff;
  if (name !== "Bash" || !bd || bd.unavailable) return [];
  const out = (bd.files || []).map((f, fi) => ({ abs: f.filePath, kind: "command", ...sizeOf(f.hunks), fi, ...(f.created ? { created: true } : {}) }));
  for (const p of bd.changedFiles || []) if (!out.some((x) => x.abs === p)) out.push({ abs: p, kind: "command", add: 0, del: 0, unknown: true });
  return out.filter((x) => x.abs);
}

// What one edit did, read back from its tool result, as an op (changes.mjs).
function opOf(name, r, edit) {
  if (EDITORS.has(name)) {
    const before = typeof r.originalFile === "string" ? r.originalFile : undefined;
    if (r.type === "create") return { created: true, before: null, after: String(r.content ?? "") };
    const change = Array.isArray(r.structuredPatch) ? { hunks: r.structuredPatch } : { replace: { old: String(r.oldString ?? ""), new: String(r.newString ?? ""), all: !!r.replaceAll } };
    return { ...change, ...(before !== undefined ? { before } : {}), ...(r.type === "update" && typeof r.content === "string" ? { after: r.content } : {}) };
  }
  const f = edit.fi != null ? r.bashEditDiff?.files?.[edit.fi] : null;
  if (!f) return { unknown: true };
  const hunks = f.hunks || [];
  if (f.created) return hunks.length ? { created: true, hunks } : { created: true, unknown: true };
  if (f.deleted) return { deleted: true };
  return { hunks };
}

// A command that only moves the folder to other commits (switching branches, pulling, stashing) changes files,
// but none of them are the session's work.
const MOVES = /\bgit\b(?:\s+-[cC]\s+\S+)*\s+(?:switch|pull|merge|rebase|reset|stash|cherry-pick|revert|am|fetch|clone|worktree)\b|\bgit\b(?:\s+-[cC]\s+\S+)*\s+checkout\b(?![^\n|;&]*\s--(?:\s|$))/;
// Commands that write files they don't name: installers, formatters, fixers, in-place edits, patches.
const WRITERS = /\b(?:npm|pnpm|yarn|bun)\s+(?:i|install|add|remove|rm|uninstall|update|up|upgrade|ci|dedupe)\b|\b(?:uv\s+(?:lock|add|remove|sync)|pip3?\s+install|poetry\s+(?:add|remove|lock|install|update)|bundle\s+(?:install|update)|cargo\s+(?:add|remove|update|fmt|fix)|go\s+(?:mod|get|generate|fmt)|gofmt\s+-\w*w|rustfmt|black|isort|swiftformat)\b|\b(?:prettier|biome|dprint)\b[^\n|;&]*(?:--write|-w\b|\bformat\b|--apply)|\b(?:eslint|ruff|stylelint|rubocop)\b[^\n|;&]*(?:--fix|-a\b|\bformat\b)|\bsed\s+(?:-\w+\s+)*-i|\bperl\s+-\w*i|\bgit\s+(?:apply|restore|mv|rm)\b|\bgit\s+checkout\b[^\n|;&]*\s--\s|\bpatch\s+-|\b(?:codegen|generate|gen)\b/;

// Claude Code lists the skills a session can use as "- name: description" lines. Plugin skills are
// "plugin:skill". A description can run onto more lines.
function parseSkills(text) {
  const skills = [];
  for (const line of String(text || "").split("\n")) {
    const m = line.match(/^- (\S+?): (.*)$/);
    if (m) skills.push({ name: m[1], description: short(m[2], 200) });
    else if (skills.length && line.trim()) skills.at(-1).description = short(`${skills.at(-1).description} ${line}`, 200);
  }
  return skills;
}

/* ---------- loops (/loop) ---------- */

// What a session set itself to do again. `/loop 5m <prompt>` (or asking for a reminder) schedules a prompt on a
// cron (CronCreate, until CronDelete; a recurring one expires after 7 days, a one-shot fires once). `/loop
// <prompt>` without an interval has Claude pick when to look again after each run (ScheduleWakeup), until it
// stops. Both live in the session only. Each fire is noted ("scheduled_task_fire", with its task's id, cron and
// prompt), then starts a turn of its own ("turnOrigin": "scheduled").
// A loop: { id, kind: "cron" | "paced", cron, prompt, recurring, reason, at, next, ended, runs: [{ at, turn }] }.
const SCHEDULERS = new Set(["CronCreate", "CronDelete", "ScheduleWakeup"]);
const PACED = "paced"; // the self-paced loop: a session has one at a time
const RUNS = 100; // runs kept per loop

// What a loop is called: the first sentence of its prompt (or its first line), without the `/loop` it may repeat,
// cut at a word past 80 characters. A bare `/loop` runs Claude Code's built-in upkeep (or the project's loop.md).
export function loopName(prompt) {
  const p = String(prompt ?? "").trim();
  if (/^<<autonomous-loop(?:-dynamic)?>>$/.test(p) || p === "/loop") return "Upkeep: unfinished work, its pull request, cleanup";
  const line = p.replace(/^\/loop\s+/, "").split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean) || "";
  const name = (line.match(/^.{12,}?[^\d\s][.!?](?=\s|$)/)?.[0] || line).replace(/[.:]$/, "");
  if (name.length <= 80) return name || "Loop";
  const cut = name.lastIndexOf(" ", 79);
  return `${name.slice(0, cut > 40 ? cut : 79).replace(/[\s,;:(–-]+$/, "")}…`;
}

// A CronCreate, CronDelete or ScheduleWakeup came back. A wakeup is a loop (`slash`) when someone started one
// (/loop) just before, or its prompt is one; otherwise Claude set itself a check, to look again once.
function noteScheduler(d, call, r, at) {
  const loops = (d.loops ||= {});
  const input = call.input || {};
  const slash = d.slashLoop || /^(\/loop\b|<<autonomous-loop)/.test(String(input.prompt || "").trim());
  if (call.name === "CronCreate" && r?.id) loops[r.id] = { id: r.id, kind: "cron", cron: String(input.cron || r.humanSchedule || ""), prompt: short(input.prompt, 2000), recurring: r.recurring !== false, at, next: null, ended: null, runs: [] };
  else if (call.name === "CronDelete" && loops[input.id || r?.id]) loops[input.id || r.id].ended ||= at;
  else if (call.name === "ScheduleWakeup") {
    const was = loops[PACED]?.ended ? null : loops[PACED];
    if (input.stop || r?.stopped) {
      if (was) was.ended = at;
    } else if (r?.scheduledFor) loops[PACED] = { ...(was || { id: PACED, kind: "paced", at, runs: [] }), prompt: short(input.prompt, 2000), reason: short(input.reason, 200), next: new Date(r.scheduledFor).toISOString(), ended: null, slash: !!was?.slash || slash };
  }
  if (call.name !== "CronDelete" && !input.stop) d.slashLoop = false;
  d.changed = true;
}
// A loop fired: its turn is one of its runs. `sys` is the note Claude Code made just before, which says what the
// task was, for one scheduled before the part of the transcript agentbook read.
function noteFire(d, e, at) {
  const loops = (d.loops ||= {});
  const id = e.scheduledTaskId;
  const sys = d.fire?.taskId === id ? d.fire : null;
  d.fire = null;
  let loop = loops[id];
  // A self-paced loop's wakeup has a task id of its own each time: Claude Code says it's a wakeup, and it comes
  // when the loop said it would.
  const paced = loops[PACED] && !loops[PACED].ended ? loops[PACED] : null;
  if (!loop && paced && (sys ? /wakeup/i.test(sys.content || "") : paced.next && Date.parse(at) >= Date.parse(paced.next) - 90e3)) loop = paced;
  if (!loop && id) loop = loops[id] = { id, kind: "cron", cron: String(sys?.cron || ""), prompt: short(sys?.prompt ?? (typeof e.message?.content === "string" ? e.message.content : ""), 2000), recurring: true, at, next: null, ended: null, runs: [] };
  if (!loop) return;
  loop.runs.push({ at, turn: d.turn });
  if (loop.runs.length > RUNS) loop.runs.splice(0, loop.runs.length - RUNS);
  if (loop.kind === "paced") loop.next = null; // it says when the next one is before its turn ends
  else if (!loop.recurring) loop.ended ||= at;
}

// A tool result's edits, commits and pull requests. `src`: where its line is, to read what it did back later.
// `step`: the step they count on (a subagent's count on the step that started it).
function noteResult(d, { tool, id, at, r, src, step, turn, cwd }) {
  const cmd = d.bash?.get(id);
  d.bash?.delete(id);
  if (cmd && COMMITS.test(cmd.text)) d.commits.push({ step: step?.id ?? null, turn, from: cmd.at, to: at, sha: shaIn(r?.stdout) });
  if (cmd && /\bgh\s+pr\b/.test(cmd.text)) notePrs(d.prs, cmd.text, r?.stdout, at);
  if (cmd && MOVES.test(cmd.text)) return;
  for (const x of editsIn(tool, r)) {
    // A command's change is the session's for sure when it names the file or writes files for a living. Others
    // may have been someone else's, made while it ran (changes.mjs decides with who else was in the folder).
    const claim = x.kind === "command" ? { from: cmd?.at || at, claimed: !!cmd && (WRITERS.test(cmd.text) || cmd.text.includes(path.basename(x.abs))) } : {};
    noteEdit(d, step, { ...x, ...claim, at, turn, src: { ...src, tool } }, cwd);
  }
}
// Shell commands, from their tool_use until their result: what they ran, and when.
function noteCommand(d, b, at) {
  if (b.name !== "Bash") return;
  (d.bash ||= new Map()).set(b.id, { text: String(b.input?.command || ""), at });
  if (d.bash.size > 500) d.bash.delete(d.bash.keys().next().value); // results that never came
}
// The subagents it started (Agent, Task) as workers (workers.mjs), by the tool call that started each: running from
// then until its result, for one that ran in the foreground, or until Claude Code's notice that one in the background
// stopped (a <task-notification>, saying how it went). `agent`: Claude Code's id for it. Its own transcript says the
// tool it last started (takeSub).
const WORKERS_KEPT = 200;
function noteWorker(d, b, at) {
  (d.workers ||= new Map()).set(b.id, { id: b.id, title: short(b.input?.description || b.input?.prompt || "A subagent", 120), state: "running", started: at, ended: null, error: null, step: null, n: 0, agent: null });
  if (d.workers.size > WORKERS_KEPT) d.workers.delete(d.workers.keys().next().value);
}
function workerResult(d, b, r, at) {
  const w = d.workers?.get(b.tool_use_id);
  if (!w) return;
  if (r?.agentId) w.agent = String(r.agentId);
  const text = typeof b.content === "string" ? b.content : (b.content || []).map((x) => x.text || "").join(" ");
  if (b.is_error) settle(w, /interrupt|cancel/i.test(text) ? "stopped" : "failed", at, short(text, 300) || null);
  else if (!(r?.isAsync || r?.status === "async_launched" || /^Async agent launched/.test(text))) settle(w, "done", at);
}
// Claude Code's notices that something it left running stopped (<task-notification>), one or more in a text, after a
// preamble of its own. It queues each when it happens, and hands it over as a message, or mid-turn; the first says when.
function noticesIn(d, text, at) {
  if (typeof text !== "string" || !d.workers) return;
  for (const notice of text.match(/<task-notification>[\s\S]*?<\/task-notification>/g) || []) workerNotice(d, notice, at || new Date().toISOString());
}
function workerNotice(d, text, at) {
  // By the call that started it, or (from older Claude Code, whose notices don't say that) by its id for it.
  const id = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(text)?.[1];
  const task = /<task-id>([^<]+)<\/task-id>/.exec(text)?.[1];
  const w = (id && d.workers.get(id)) || (task && [...d.workers.values()].find((x) => x.agent === task));
  if (!w) return; // a command it left running in the background, not a subagent
  const state = stateOf(/<status>([^<]+)<\/status>/.exec(text)?.[1]);
  const why = /<summary>[^<]*? failed: ([^<]+)<\/summary>/.exec(text)?.[1];
  settle(w, state, at, state === "failed" && why ? short(why, 300) : null);
  // A notice comes each time it stops, so it ended at the latest: one that failed, was sent a message (SendMessage)
  // and then finished ended when it finished. That message, read from its own transcript after this notice, isn't
  // it going again (takeSub).
  if (!going(w) && at > w.ended) w.ended = at;
}

// The turn something happened in, by its time: a subagent in the background works on into later turns.
function turnAt(d, at) {
  for (let i = d.turns.length - 1; i >= 0; i--) if (d.turns[i].at <= at) return d.turns[i].turn;
  return d.turns.length ? d.turns[0].turn : d.turn;
}

// Fold one transcript entry into a digest. `span`: where its line is in the transcript.
function take(d, e, cwd, span) {
  if (e.type === "ai-title" && e.aiTitle) return void (d.ai_title = short(e.aiTitle, 120));
  if (e.type === "pr-link" && e.prUrl) return void (d.prs[e.prUrl] = { url: e.prUrl, number: e.prNumber, repo: e.prRepository, at: d.prs[e.prUrl]?.at || e.timestamp, how: "opened" });
  if (e.type === "system" && e.subtype === "turn_duration") return void (d.worked += Number(e.durationMs) || 0);
  if (e.type === "attachment" && e.attachment?.type === "skill_listing") return void (d.skills = parseSkills(e.attachment.content));
  if (e.type === "system" && e.subtype === "scheduled_task_fire") return void (d.fire = e);
  // A notice queued for it (when what it left running stopped), and one handed to it mid-turn.
  if (e.type === "queue-operation") return void (e.operation === "enqueue" && noticesIn(d, e.content, e.timestamp));
  if (e.type === "attachment" && e.attachment?.type === "queued_command") return void noticesIn(d, e.attachment.prompt, e.timestamp);
  if (e.isSidechain) return; // a subagent's own steps; its start shows as one step
  if (e.cwd) d.cwd = e.cwd; // where the session is now: it may have moved (EnterWorktree, cd)
  const at = e.timestamp || new Date().toISOString();
  const content = e.message?.content;
  if (e.type === "system" && e.subtype === "local_command" && typeof e.content === "string") return void noteRan(d, e, e.content);
  if (e.type === "user" && typeof content === "string" && (e.isMeta || /<(local-)?command-/.test(content))) noteRan(d, e, content);
  if (e.type === "user") {
    noticesIn(d, typeof content === "string" ? content : Array.isArray(content) ? content.filter((b) => b.type === "text").map((b) => b.text).join("\n") : "", at);
    if (isInterrupt(e)) return void (d.interrupted = at);
    if (isPrompt(e)) {
      d.interrupted = null;
      d.turn++;
      d.turns.push({ turn: d.turn, at });
      if (e.turnOrigin === "scheduled") noteFire(d, e, at);
      else if (/<command-name>\/loop<\/command-name>/.test(typeof content === "string" ? content : content.map((b) => b.text || "").join("\n"))) d.slashLoop = true;
      return;
    }
    for (const b of Array.isArray(content) ? content : []) {
      if (b.type !== "tool_result") continue;
      const call = d.scheduling?.get(b.tool_use_id);
      if (call) {
        d.scheduling.delete(b.tool_use_id);
        if (!b.is_error) noteScheduler(d, call, e.toolUseResult, at);
      }
      workerResult(d, b, e.toolUseResult, at);
      const step = d.byId?.get(b.tool_use_id);
      if (!step) continue;
      step.done = at;
      // A command it left running in the background: Claude Code lists it by this id, and the step names it.
      const task = e.toolUseResult?.backgroundTaskId;
      if (task) {
        (d.tasks ||= new Map()).set(String(task), step.title);
        if (d.tasks.size > 200) d.tasks.delete(d.tasks.keys().next().value);
      }
      if (b.is_error) {
        const text = typeof b.content === "string" ? b.content : (b.content || []).map((x) => x.text || "").join(" ");
        step.error = short(text, 160) || "Failed";
        d.errors++;
      } else if (span) {
        noteResult(d, { tool: step.tool, id: b.tool_use_id, at, r: e.toolUseResult, src: { file: d.file, ...span }, step, turn: step.turn, cwd });
        const shots = imagesIn(b).length;
        if (shots) noteImages(d, step, shots, { file: d.file, ...span, id: b.tool_use_id });
        if (shots) notePictures(d, b, shots);
      }
    }
    return;
  }
  if (e.type !== "assistant" || !Array.isArray(content)) return;
  if (e.message.model && !e.message.model.startsWith("<")) d.model = e.message.model;
  const u = e.message.usage;
  if (u) d.context = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
  // What Claude Code writes for Claude when a session wakes after a command that printed (`<synthetic>`), not Claude's.
  const filler = e.message.model === "<synthetic>" && !e.isApiErrorMessage;
  for (const b of content) {
    if (b.type === "text" && b.text?.trim() && !filler) d.steps.push({ id: `t${d.n++}`, turn: d.turn, at, kind: "say", text: said(b.text) });
    if (b.type !== "tool_use") continue;
    if (b.name === "Skill" && b.input?.skill) d.skill_uses[b.input.skill] = (d.skill_uses[b.input.skill] || 0) + 1;
    if (b.name === "Skill" && b.input?.skill === "loop") d.slashLoop = true;
    if (b.name === "TodoWrite" && Array.isArray(b.input?.todos)) d.plan = b.input.todos.map((t) => ({ text: short(t.content, 120), now: short(t.activeForm || t.content, 120), status: t.status }));
    if (b.name === "Agent" || b.name === "Task") {
      d.subs ||= {};
      noteWorker(d, b, at);
    }
    if (SCHEDULERS.has(b.name)) (d.scheduling ||= new Map()).set(b.id, { name: b.name, input: b.input });
    noteCommand(d, b, at);
    noteRead(d, b);
    if (QUIET(b.name)) continue;
    const step = { id: b.id, turn: d.turn, at, kind: "tool", tool: b.name, title: describeTool(b.name, b.input, cwd) };
    d.steps.push(step);
    (d.byId ||= new Map()).set(b.id, step);
    d.tools++;
  }
  if (d.steps.length > KEEP) {
    for (const s of d.steps.splice(0, d.steps.length - KEEP)) {
      d.byId?.delete(s.id);
      d.shots.delete(s.id);
    }
  }
}

// A worker's own steps, as a thread's are: its latest WORKER_STEPS, and `n`, how many tools it started. Its thread's
// page reads them when you open it (read.worker).
const WORKER_STEPS = 40;
function workerStep(w, st) {
  (w.steps ||= []).push(st);
  if (w.steps.length > WORKER_STEPS) w.steps.shift();
  if (st.kind === "tool") w.n = (w.n || 0) + 1;
}

// A subagent's entry: what it changed and the images it saw, counted on the step that started it, and its own steps
// on its worker.
function takeSub(d, sub, e, cwd, span) {
  const at = e.timestamp || new Date().toISOString();
  const content = Array.isArray(e.message?.content) ? e.message.content : [];
  const w = d.workers?.get(sub.step);
  if (e.type === "assistant") {
    for (const b of content) {
      if (w && b.type === "text" && b.text?.trim()) workerStep(w, { id: `${w.id}:say:${at}`, at, kind: "say", text: said(b.text, 1000) });
      if (b.type !== "tool_use") continue;
      if (w) w.step = { title: describeTool(b.name, b.input, cwd), at };
      if (w && !QUIET(b.name)) workerStep(w, { id: b.id, at, kind: "tool", tool: b.name, title: w.step.title });
      sub.names.set(b.id, b.name);
      noteCommand(d, b, at);
      noteRead(d, b);
    }
    return;
  }
  if (e.type !== "user") return;
  // A message sent to one that had ended (SendMessage): it's going again.
  if (w?.ended && at > w.ended && (typeof e.message?.content === "string" || content.some((b) => b.type === "text"))) settle(w, "running", at);
  for (const b of content) {
    const st = b.type === "tool_result" && w?.steps?.find((x) => x.id === b.tool_use_id);
    if (st) {
      st.done = at;
      if (b.is_error) st.error = short(typeof b.content === "string" ? b.content : (b.content || []).map((x) => x.text || "").join(" "), 160) || "Failed";
    }
    if (b.type !== "tool_result" || b.is_error || !sub.names.has(b.tool_use_id)) continue;
    const step = d.byId?.get(sub.step) || null;
    noteResult(d, { tool: sub.names.get(b.tool_use_id), id: b.tool_use_id, at, r: e.toolUseResult, src: { file: sub.file, ...span }, step, turn: turnAt(d, at), cwd });
    const shots = imagesIn(b).length;
    if (shots && step) noteImages(d, step, shots, { file: sub.file, ...span, id: b.tool_use_id });
    if (shots) notePictures(d, b, shots);
  }
}

// Read a span of a transcript (`t`: the digest, or a subagent's), handing each complete line to `fn` with where
// it is: { at, len } in bytes. Lines are cut on bytes, so the places are exact.
function read(t, from, to, fn) {
  const len = to - from;
  if (len <= 0) return false;
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(t.file, "r");
  try {
    fs.readSync(fd, buf, 0, len, from);
  } finally {
    fs.closeSync(fd);
  }
  const data = t.partial.length ? Buffer.concat([t.partial, buf]) : buf;
  const base = from - t.partial.length;
  let start = 0;
  for (let i = data.indexOf(10); i !== -1; i = data.indexOf(10, start)) {
    if (t.cut) t.cut = false; // the first line, cut in half when reading began mid-file
    else if (i - start > 1) {
      try {
        fn(JSON.parse(data.toString("utf8", start, i)), { at: base + start, len: i - start });
      } catch {}
    }
    start = i + 1;
  }
  t.partial = Buffer.from(data.subarray(start));
  t.offset = to;
  t.changed = true;
}

// Follow a transcript from where it was read to; the first time, read its newest FIRST_READ.
function follow(t, fn) {
  let size;
  try {
    size = fs.statSync(t.file).size;
  } catch {
    return false;
  }
  const first = !t.began;
  t.began = true;
  if (first && size > FIRST_READ) {
    t.offset = size - FIRST_READ;
    t.cut = true;
  }
  if (size <= t.offset) return false;
  read(t, t.offset, first ? size : Math.min(size, t.offset + MAX_READ), fn);
  return true;
}

// Subagents write transcripts of their own, in <session>/subagents/, each with a .meta.json naming the tool
// call that started it. Follow them for what they changed.
function followSubs(d, cwd) {
  if (!d.subs) return;
  const dir = path.join(d.file.replace(/\.jsonl$/, ""), "subagents");
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return;
  }
  for (const n of names) {
    let sub = d.subs[n];
    if (!sub) {
      let meta = null;
      try {
        meta = JSON.parse(fs.readFileSync(path.join(dir, n.replace(/\.jsonl$/, ".meta.json")), "utf8"));
      } catch {}
      sub = d.subs[n] = { file: path.join(dir, n), offset: 0, partial: Buffer.alloc(0), cut: false, step: meta?.toolUseId || null, names: new Map() };
      // One started before the part of a long transcript that was read: a worker from what it says of itself.
      if (meta?.toolUseId && !meta.finished && !(meta.spawnDepth > 1) && !d.workers?.has(meta.toolUseId)) {
        let at = null;
        try {
          at = fs.statSync(sub.file).birthtime.toISOString();
        } catch {}
        noteWorker(d, { id: meta.toolUseId, input: { description: meta.description } }, at);
      }
    }
    if (follow(sub, (e, span) => takeSub(d, sub, e, cwd, span))) d.changed = true;
  }
}

// What an edit did, read back from its tool result in its transcript.
export function loadEdit(edit) {
  const { file, at, len, tool } = edit.src || {};
  if (!file) return { unknown: true };
  try {
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, "r");
    try {
      fs.readSync(fd, buf, 0, len, at);
    } finally {
      fs.closeSync(fd);
    }
    const e = JSON.parse(buf.toString("utf8"));
    return opOf(tool, e.toolUseResult || {}, edit);
  } catch {
    return { unknown: true };
  }
}

// A tool's result, read back from where the digest saw it. If the transcript moved under it (rewritten, or a
// line cut at a multibyte character), find the result by its tool call's id.
const answers = (e, id) => Array.isArray(e?.message?.content) && e.message.content.some((b) => b.type === "tool_result" && b.tool_use_id === id);
function resultAt(span) {
  let e = null;
  try {
    const buf = Buffer.alloc(span.len);
    const fd = fs.openSync(span.file, "r");
    try {
      fs.readSync(fd, buf, 0, span.len, span.at);
    } finally {
      fs.closeSync(fd);
    }
    e = JSON.parse(buf.toString("utf8"));
  } catch {}
  return answers(e, span.id) ? e : findResult(span.file, span.id);
}

function findResult(file, id) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const needle = `"tool_use_id":"${id}"`;
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) {
    const line = text.slice(text.lastIndexOf("\n", i) + 1, (text.indexOf("\n", i) + 1 || text.length + 1) - 1);
    try {
      const e = JSON.parse(line);
      if (e.toolUseResult && answers(e, id)) return e;
    } catch {}
  }
  return null;
}

export function createTranscripts() {
  const digests = {}; // post id -> digest
  const looked = {}; // post id -> when we last searched for its transcript

  // Hooks pass the transcript's path. For a session that registered without it, find it by session id; so too
  // for one whose transcript moved: Claude Code moves it along when the session moves to a worktree.
  function locate(s) {
    if (s.transcript && fs.existsSync(s.transcript)) return s.transcript;
    if (!s.session_id || Date.now() - (looked[s.id] || 0) < (s.transcript ? 5e3 : 30e3)) return null;
    looked[s.id] = Date.now();
    try {
      for (const dir of fs.readdirSync(PROJECTS)) {
        const file = path.join(PROJECTS, dir, `${s.session_id}.jsonl`);
        if (fs.existsSync(file)) return (s.transcript = file);
      }
    } catch {}
    return null;
  }

  // The digest for a post, reading its transcript (or the newest part of a huge one) the first time.
  function digest(s) {
    const file = locate(s);
    if (!file) return null;
    let d = digests[s.id];
    if (d && d.file === file) return d;
    let size;
    try {
      size = fs.statSync(file).size;
    } catch {
      return null;
    }
    d = digests[s.id] = blank(file);
    follow(d, (e, span) => take(d, e, s.cwd, span));
    followSubs(d, s.cwd);
    return d;
  }

  // Follow running sessions: read whatever their transcripts gained. Returns the posts that changed.
  function poll(sessions) {
    const changed = [];
    for (const s of sessions) {
      const known = digests[s.id];
      const d = digest(s);
      if (!d) continue;
      if (known === d) {
        let size;
        try {
          size = fs.statSync(d.file).size;
        } catch {
          continue;
        }
        if (size < d.offset) Object.assign(d, blank(d.file));
        follow(d, (e, span) => take(d, e, s.cwd, span));
        followSubs(d, s.cwd);
      }
      if (d.changed) {
        d.changed = false;
        changed.push(s.id);
      }
    }
    return changed;
  }

  // What the dash shows about a running session: the step it's on, and its plan.
  function live(s) {
    const d = digests[s.id];
    if (!d) return null;
    const turn = d.steps.filter((x) => x.turn === d.turn);
    const step = [...turn].reverse().find((x) => x.kind === "tool" && !x.done) || turn.at(-1) || null;
    return { step: liveStep(step), plan: d.plan, steps: d.tools, turn_steps: turn.filter((x) => x.kind === "tool").length, turn_start: turn[0]?.at || null };
  }

  // When Esc cut off its latest turn, as its transcript says right now; null if it didn't, or a new turn has started.
  function interrupted(s) {
    const d = digest(s);
    if (!d) return null;
    follow(d, (e, span) => take(d, e, s.cwd, span));
    return d.interrupted || null;
  }

  // The summary worth keeping in the event log.
  function snapshot(s) {
    const d = digests[s.id];
    if (!d) return null;
    const files = filesChanged(d.edits, s);
    return { ai_title: d.ai_title, model: d.model, plan: d.plan, prs: d.prs, context: d.context, skill_uses: d.skill_uses, ...(d.loops ? { loops: Object.values(d.loops) } : {}), stats: { steps: d.tools, errors: d.errors, worked_ms: d.worked, ...(files ? { files } : {}) } };
  }

  // The images a step's results held, read back from the transcripts: [{ type, data }], data in base64.
  function images(s, id) {
    const d = digest(s);
    return (d?.shots.get(id) || []).flatMap((span) => {
      const b = resultAt(span)?.message.content.find((x) => x.type === "tool_result" && x.tool_use_id === span.id);
      return imagesIn(b).map((x) => ({ type: x.source.media_type, data: x.source.data }));
    });
  }
  // Where those images are on this machine, when their results said: the screenshots it saved, the pictures it Read.
  const pictures = (s) => [...(digest(s)?.pictures || [])];

  // The skills a session can use, as Claude Code listed them. Kept apart from the snapshot: it's long, and rarely changes.
  const skills = (s) => digests[s.id]?.skills || null;

  // What the step that left a command running in the background (by Claude Code's id for it) was called.
  const taskTitle = (s, id) => digests[s.id]?.tasks?.get(id) || null;

  // The slash commands it ran, and what each printed (noteRan).
  const ran = (s) => digests[s.id]?.ran || [];

  // The subagents it started, as workers (noteWorker), each with its last step while it's going. They run in its
  // process, so one can't outlive it: those still going when it ended or fell asleep stopped then.
  function workers(s) {
    const over = s.state === "done" ? s.ended : s.asleep ? s.slept : null;
    return [...(digests[s.id]?.workers?.values() || [])].map((w) => (!going(w) ? { ...w, step: null } : over ? { ...w, state: "stopped", ended: over, step: null } : { ...w }));
  }

  return { digest, poll, live, interrupted, snapshot, skills, images, pictures, taskTitle, ran, workers, load: loadEdit, forget: (key) => delete digests[key] };
}
