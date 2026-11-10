// What OpenClaw's and Hermes's drivers share: a post's steps (its digest), what the page shows of them, the
// names of their tools in words, and handing a post's queued events to the agent.

import { argEdits, COMMITS, filesChanged, noteEdit } from "../changes.mjs";
import { notePrs } from "../../shared/prs.mjs";
import { describeTool, liveStep, said, SEEN_TOOL, seenTitle } from "../transcript.mjs";

export const KEEP = 3000; // steps kept per post

export const short = (s, n = 90) => {
  s = String(s ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};
export const iso = (t) => {
  if (t == null || t === "") return null;
  const ms = typeof t === "number" ? (t < 1e12 ? t * 1000 : t) : Date.parse(t);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

// A post's steps: what it said ("say") and the tools it used ("tool"), turn by turn, with its stats. `edits`
// and `commits`: what it changed (changes.mjs), from its tools' arguments, once they've succeeded (`asked`).
// `prs`: the pull requests its shell commands opened or worked on (pulls.mjs). `skill_uses`: how often it
// used each skill (see skillsOf).
export function blank() {
  return { steps: [], byId: new Map(), plan: null, turn: 0, tools: 0, errors: 0, worked: 0, context: 0, model: null, ai_title: null, n: 0, edits: [], commits: [], prs: {}, skill_uses: {}, asked: new Map() };
}

export function addSay(d, { id, at, text }) {
  if (!text?.trim()) return;
  d.steps.push({ id, turn: d.turn, at, kind: "say", text: said(text) });
  trim(d);
}
export function addTool(d, { id, at, name, args, cwd }) {
  if (d.byId.has(id)) return d.byId.get(id);
  const step = { id, turn: d.turn, at, kind: "tool", tool: name, title: toolTitle(name, args, cwd) };
  d.steps.push(step);
  d.byId.set(id, step);
  d.tools++;
  trim(d);
  for (const k of skillsOf(name, args)) d.skill_uses[k] = (d.skill_uses[k] || 0) + 1;
  const edits = argEdits(name, args, cwd);
  const command = ALIASES[String(name || "").toLowerCase()]?.[0] === "Bash" ? String(parsed(args).command ?? parsed(args).cmd ?? "") : "";
  if (edits.length || COMMITS.test(command) || /\bgh\s+pr\b/.test(command)) d.asked.set(id, { edits, commits: COMMITS.test(command), command, cwd });
  return step;
}
export function toolDone(d, id, { at, error, output }) {
  const step = d.byId.get(id);
  if (!step || step.done) return;
  step.done = at;
  if (error) {
    step.error = short(error, 300);
    d.errors++;
  }
  const asked = d.asked.get(id);
  d.asked.delete(id);
  if (!asked || error) return;
  for (const e of asked.edits) noteEdit(d, step, { ...e, at }, asked.cwd);
  if (asked.commits) d.commits.push({ step: id, turn: step.turn, from: step.at, to: at, sha: null });
  if (asked.command) notePrs((d.prs ||= {}), asked.command, output, at);
}
const parsed = (a) => {
  if (typeof a !== "string") return a || {};
  try {
    return JSON.parse(a) || {};
  } catch {
    return {};
  }
};
// The skills a tool call used. OpenClaw's and Hermes's agents read a skill's SKILL.md, with their read tool or
// a command, or (OpenClaw's code mode) ask for it by name inside exec, `skills.read("<name>")`; one on the
// claude-cli runtime uses Claude Code's Skill tool, where OpenClaw hands it its skills as a plugin of its own
// ("openclaw-skills:<name>"). A skill read from its file is named after its folder, when that's a name
// (not a glob's `*`, or a shell variable's `$d`).
const SKILL_MD = /(?<![^\s/\\'"`=])([\w.-]+)[/\\]SKILL\.md\b/g;
const SKILL_READ = /\bskills\.read\(\s*["'`]([^"'`]+)["'`]/g;
const skillName = (k) => String(k).replace(/^openclaw-skills:/, "");
export function skillsOf(name, args) {
  const a = parsed(args);
  const tool = ALIASES[String(name || "").toLowerCase()]?.[0] || name;
  if (tool === "Skill") return a.skill ? [skillName(a.skill)] : [];
  const text = tool === "Read" ? String(a.path ?? a.file_path ?? "") : tool === "Bash" ? Object.values(a).filter((v) => typeof v === "string").join("\n") : "";
  return [...new Set([...text.matchAll(SKILL_MD), ...text.matchAll(SKILL_READ)].map((m) => m[1]))];
}
function trim(d) {
  if (d.steps.length > KEEP) for (const s of d.steps.splice(0, d.steps.length - KEEP)) d.byId.delete(s.id);
}

// OpenClaw's, Hermes's and dsh's tools, in the words agentbook uses for Claude Code's.
const ALIASES = {
  exec: ["Bash", (a) => ({ command: a.command ?? a.cmd })],
  bash: ["Bash", (a) => ({ command: a.command })],
  terminal: ["Bash", (a) => ({ command: a.command })],
  shell: ["Bash", (a) => ({ command: a.command })],
  pwsh: ["Bash", (a) => ({ command: a.command })],
  read: ["Read", (a) => ({ file_path: a.path ?? a.file_path })],
  read_file: ["Read", (a) => ({ file_path: a.path ?? a.file_path })],
  write: ["Write", (a) => ({ file_path: a.path ?? a.file_path })],
  write_file: ["Write", (a) => ({ file_path: a.path ?? a.file_path })],
  edit: ["Edit", (a) => ({ file_path: a.path ?? a.file_path })],
  patch: ["Edit", (a) => ({ file_path: a.path ?? a.file_path })],
  search_files: ["Grep", (a) => ({ pattern: a.pattern ?? a.query })],
  grep: ["Grep", (a) => ({ pattern: a.pattern })],
  glob: ["Glob", (a) => ({ pattern: a.pattern })],
  web_search: ["WebSearch", (a) => ({ query: a.query })],
  web_fetch: ["WebFetch", (a) => ({ url: a.url })],
  web_extract: ["WebFetch", (a) => ({ url: Array.isArray(a.urls) ? a.urls[0] : a.url })],
};
export function toolTitle(name, args, cwd = "") {
  let a = args;
  if (typeof a === "string") {
    try {
      a = JSON.parse(a);
    } catch {
      a = {};
    }
  }
  a ||= {};
  const alias = ALIASES[String(name || "").toLowerCase()];
  if (alias) return describeTool(alias[0], alias[1](a), cwd);
  if (SEEN_TOOL.test(String(name || ""))) return seenTitle(name, a);
  // OpenClaw's message tool (mcp__openclaw__message in a claude-cli agent): what it sent, a file or its words.
  if (/^(?:\w+__)?message$/i.test(String(name || "")) && /^send/i.test(String(a.action || ""))) {
    const file = [a.media, a.mediaUrl, a.path, a.filePath, a.fileUrl, ...(Array.isArray(a.attachments) ? a.attachments.map((x) => x?.media || x?.path) : [])].find((v) => typeof v === "string" && v.trim());
    const text = [a.message, a.text, a.caption].find((v) => typeof v === "string" && v.trim());
    if (file) return `Sent ${short(String(file).split(/[\\/]/).pop(), 70)}`;
    if (text) return `Sent "${short(text.replace(/\s+/g, " "), 70)}"`;
  }
  const what = a.description || a.query || a.path || a.url || a.command;
  return what ? `${name}: ${short(what, 70)}` : `Use ${name}`;
}

// What a post shows while it runs, and its summary (title, model, stats), kept in the log like Claude's.
export function liveOf(d) {
  if (!d) return null;
  const turn = d.steps.filter((x) => x.turn === d.turn);
  const step = [...turn].reverse().find((x) => x.kind === "tool" && !x.done) || turn.at(-1) || null;
  return { step: liveStep(step), plan: d.plan, steps: d.tools, turn_steps: turn.filter((x) => x.kind === "tool").length, turn_start: turn[0]?.at || null };
}
export function summaryOf(d, s) {
  if (!d) return null;
  const files = s ? filesChanged(d.edits, s) : 0;
  const { uses } = skillUses(d, s);
  return { ai_title: d.ai_title, model: d.model, plan: d.plan, context: d.context, prs: d.prs || {}, ...(Object.keys(uses).length ? { skill_uses: uses } : {}), stats: { steps: d.tools, errors: d.errors, worked_ms: d.worked, ...(files ? { files } : {}) } };
}

// How often a post used each skill: what its digest counted. A digest of only its latest history (after a
// restart, a long post's) is never less than the post already says, under the skill's own name (one counted
// under OpenClaw's plugin's moves to it; what isn't a skill's name goes); one of all of it (`whole`) is.
// `changed`: that isn't what the post says.
const SKILL_NAME = /^[\w.-]+(:[\w.-]+)*$/;
export function skillUses(d, s) {
  const kept = s?.skill_uses || {};
  const uses = {};
  if (!d?.whole)
    for (const [k, n] of Object.entries(kept)) {
      const name = skillName(k).replace(/^[*?]+/, "");
      if (SKILL_NAME.test(name)) uses[name] = (uses[name] || 0) + n;
    }
  for (const [k, n] of Object.entries(d?.skill_uses || {})) uses[k] = Math.max(uses[k] || 0, n);
  const changed = Object.keys(uses).length !== Object.keys(kept).length || Object.entries(uses).some(([k, n]) => kept[k] !== n);
  return { uses, changed };
}

// Hand a post's queued events to its agent, one post at a time: Allow/Deny and answers to what it asked go
// to `answer` (true when it took the event), everything else is sent as one message. The files you attached
// are named in it with their paths here, or, with `sendsFiles` (an agent that may be on another machine),
// handed to `send` to go with it: [{ name, size, path }]. What doesn't get there is the host's to say
// (undelivered: your messages stay, to send again or delete). `send` hears `owner` too: whether all of it is its
// owner's own words (messages, none from someone they let operate it, and no news from its group riding along),
// which a driver may send with more than it sends anyone else's (OpenClaw's admin).
export function deliverer({ host, log, name, answer, send, sendsFiles = false }) {
  const busy = new Set();
  const again = new Set();
  return async function deliver(id) {
    if (busy.has(id)) return void again.add(id);
    busy.add(id);
    // A slash command goes alone, as typed, with nothing after it (not even its group's news): what's before it goes
    // first, what's after it next time.
    const pending = host.pending(id);
    const at = pending.findIndex((o) => o.event.type === "message" && o.event.command);
    const events = at === 0 ? pending.slice(0, 1) : at > 0 ? pending.slice(0, at) : pending;
    if (events.length < pending.length) again.add(id);
    const taken = new Set();
    try {
      if (!events.length) return;
      if (at === 0) {
        await send(id, events[0].event.text, [], { command: events[0].event.command, owner: !events[0].event.user });
        host.commit({ t: "outbox.ack", oids: [events[0].oid] });
        return;
      }
      const texts = [];
      const files = [];
      let owner = true;
      for (const o of events) {
        const e = o.event;
        if ((e.type === "permission" || e.type === "answer") && (await answer(id, e))) {
          taken.add(o);
          continue;
        }
        if (e.type !== "message" || e.user) owner = false;
        if (e.type === "message" && sendsFiles) {
          if (e.text?.trim()) texts.push(e.text.trim());
          files.push(...(e.files || []));
        } else if (e.type === "file" && sendsFiles) files.push(e);
        else if (e.type === "message") texts.push(`${e.text || ""}${host.attached(e.files)}`.trim());
        else if (e.type !== "permission") texts.push(host.describe(e));
      }
      // What changed in its group since it last heard rides along; it never makes a message of its own.
      const news = texts.length || files.length ? await Promise.resolve(host.news?.(id)).catch(() => null) : null;
      if (texts.length || files.length) await send(id, [...texts, news].filter(Boolean).join("\n\n"), files, { owner: owner && !news });
      host.commit({ t: "outbox.ack", oids: events.map((o) => o.oid) });
    } catch (e) {
      log(`${name.toLowerCase()} deliver ${id}: ${e.message}`);
      if (taken.size) host.commit({ t: "outbox.ack", oids: [...taken].map((o) => o.oid) });
      host.undelivered(id, events.filter((o) => !taken.has(o)), `couldn't reach ${name}: ${e.message}`);
    } finally {
      busy.delete(id);
      if (again.delete(id)) deliver(id);
    }
  };
}
