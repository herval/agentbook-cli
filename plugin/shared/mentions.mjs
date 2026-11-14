// Naming a page, or one of its widgets, in a message: "@page" or "@page/widget", by their ids
// ("@reliability-ledger", "@reliability-ledger/m_p95"). Ids, not titles: titles change and repeat, and ids
// are what ab_page_read and ab_page_write use. Saved, a token with a "/" is a widget and one without is a page.
//
// A widget on the page a message is about can be named in short ("@m_p95"): the server writes it out in full
// when it saves the message, so it means the same thing anywhere. The agent gets the message as written, then a
// note on each page and widget it names, with what it showed then (mentionNote).
//
// A workspace is "@ws:<id>" ("@ws:wmg2k1x0a3f"): its id, since names change, and "ws:" so it's never a page's.
// A task is "@task:<id>" and a group "@group:<id>", the same way. Naming one does more than tell the agent: the
// thread the message starts, or is in, goes on that task, or in that group (server/main.mjs). A note is "@note:<id>":
// its agent is told what it is, and the thread shows in the note's Threads.
//
// The UI reads the same tokens (app.js, "mentions"): a token is a chip only if what it names exists.

import { outline } from "./pages.mjs";

// "@page" or "@page/widget", after the start, a space or a bracket. Page ids are made of [a-z0-9-] (pageId()).
export const MENTION = /(^|[\s(])@(?!(?:ws|task|group|note):)([a-z0-9][a-z0-9-]*)(?:\/([A-Za-z0-9_.-]*[A-Za-z0-9_]))?(?![\w/-])/g;
// "@widget", in short, for a widget on the page the message is about.
const SHORT = /(^|[\s(])@(?!(?:ws|task|group|note):)([A-Za-z0-9_.-]*[A-Za-z0-9_])(?![\w/-])/g;
// "@ws:<id>", a workspace. Its ids are made of [a-z0-9] (workspaceId()).
export const WS_MENTION = /(^|[\s(])@ws:([a-z0-9]+)(?![\w/-])/g;
// "@task:<id>", one of your tasks (taskId(): [a-z0-9]), and "@group:<id>", one of your groups (groupId(): [a-z0-9-]).
export const TASK_MENTION = /(^|[\s(])@task:([a-z0-9]+)(?![\w/-])/g;
export const GROUP_MENTION = /(^|[\s(])@group:([a-z0-9][a-z0-9-]*)(?![\w/-])/g;
// "@note:<id>", one of your notes (noteId(): [a-z0-9-]).
export const NOTE_MENTION = /(^|[\s(])@note:([a-z0-9][a-z0-9-]*)(?![\w/-])/g;

// A claude.ai artifact's link: claude.ai/artifact/<id> or claude.ai/code/artifact/<uuid>. claude.ai won't be framed
// by another site, so a thread shows one as a copy its agent hands over (ab_artifact, plugin/cli/artifact.mjs).
export const ARTIFACT_URL = /https:\/\/(?:preview\.)?claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9][A-Za-z0-9_-]{5,200}/g;
// The artifact links in a message, once each, in order.
export const artifactLinks = (text) => [...new Set(String(text || "").match(ARTIFACT_URL) || [])];
// What its agent is told about each (mentionNote).
const ARTIFACT_NOTE = "a claude.ai artifact, which agentbook can't show from its link. If you have Claude Code's Artifact tool, put a copy on this thread with ab_artifact";

const widgetOf = (p, id) => (p?.widgets || []).find((w) => w.id === id) || null;

// Short tokens naming a widget on `page` (the page the message is about, or null), written out in full. A short
// token that names no widget there stays as it is: it may name a page.
export function expandMentions(text, page) {
  if (!page || !text) return text;
  return String(text).replace(SHORT, (m, pre, id) => (widgetOf(page, id) ? `${pre}@${page.id}/${id}` : m));
}

// What a message names, once each, in order: [{ page, widget }] (widget null for a page). Tokens naming nothing
// (an npm scope, a person, an email address) aren't any.
export function mentionsIn(text, pages) {
  const out = [];
  const seen = new Set();
  for (const m of String(text || "").matchAll(MENTION)) {
    const page = pages[m[2]];
    const widget = m[3] ? widgetOf(page, m[3]) : null;
    if (!page || (m[3] && !widget)) continue;
    const ref = widget ? `${page.id}/${widget.id}` : page.id;
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push({ ref, page, widget });
  }
  return out;
}

// The text with what it names in words, for where a chip can't go (a thread's title, taken from its prompt):
// "why did @reliability-ledger/m_p95 jump?" reads "why did HTTP p95 latency, 24h jump?".
export function plainMentions(text, pages) {
  return String(text || "").replace(MENTION, (m, pre, pid, wid) => {
    const page = pages[pid];
    const widget = wid ? widgetOf(page, wid) : null;
    return !page || (wid && !widget) ? m : pre + (widget ? widget.title || widget.id : page.title);
  });
}

const plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;
function ago(iso, now) {
  const m = Math.max(0, Math.round((now - Date.parse(iso)) / 60e3));
  if (!Number.isFinite(m)) return "";
  if (m < 1) return "just now";
  if (m < 60) return `${plural(m, "minute")} ago`;
  if (m < 48 * 60) return `${plural(Math.round(m / 60), "hour")} ago`;
  return `${plural(Math.round(m / 1440), "day")} ago`;
}

// The workspaces a message names, once each, in order: [{ ref, workspace }]. `workspaces`: by id, the sender's.
export function workspacesIn(text, workspaces) {
  const out = [];
  for (const m of String(text || "").matchAll(WS_MENTION)) {
    const w = workspaces[m[2]];
    if (w && !out.some((x) => x.workspace === w)) out.push({ ref: `ws:${w.id}`, workspace: w, at: m.index });
  }
  return out;
}

// The tasks and the groups a message names, once each, in order: [{ ref, task, at }] and [{ ref, group, at }].
// `tasks`, `groups`: by id, the sender's.
const namedBy = (re, kind) => (text, byId) => {
  const out = [];
  for (const m of String(text || "").matchAll(re)) {
    const x = byId?.[m[2]];
    if (x && !out.some((y) => y[kind] === x)) out.push({ ref: `${kind}:${x.id}`, [kind]: x, at: m.index });
  }
  return out;
};
export const tasksIn = namedBy(TASK_MENTION, "task");
export const groupsIn = namedBy(GROUP_MENTION, "group");
export const notesIn = namedBy(NOTE_MENTION, "note");

// Where a workspace is, for its agent: its repo, and each checkout of it ({ machine, root }).
function whereIs(w) {
  const at = (w.checkouts || []).map((c) => `${c.root} on ${c.machine}`);
  if (w.repo) return `the repo ${w.repo}, ${at.length ? `checked out at ${at.join(", and at ")}` : "not checked out on any of your machines"}`;
  return at.length ? `the folder ${at.join(", and ")}` : "a folder no machine has now";
}

// A task, for its agent: its title, whether it's done, and the start of its body.
function taskIs(t) {
  const body = String(t.note || "").trim().replace(/\s+/g, " ");
  return `the task "${t.text}" on their Tasks${t.done ? ", done" : ""}${body ? ` (${body.length > 300 ? `${body.slice(0, 299)}…` : body})` : ""}`;
}

// The note an agent gets after a message that names pages, widgets, workspaces, tasks or groups: what each is, what
// a widget showed when the message was sent (a routine may refresh it before the agent looks), where a workspace is,
// and the task or the group its thread is now on or in; and a line for each claude.ai artifact it links to. "" when
// it names none. `workspaces`, `tasks`, `groups`: the
// sender's, by id, each workspace with its `checkouts`; a task or a group with `here` is one the thread is on or in.
// `notes`: the notes the sender sees, by id, each with `whose` when it's someone else's.
export function mentionNote(text, pages, now = Date.now(), workspaces = {}, { tasks = {}, groups = {}, notes = {} } = {}) {
  const at = new Map([...String(text || "").matchAll(MENTION)].map((m) => [m[3] ? `${m[2]}/${m[3]}` : m[2], m.index]).reverse());
  const named = [...mentionsIn(text, pages).map((x) => ({ ...x, at: at.get(x.ref) })), ...workspacesIn(text, workspaces), ...tasksIn(text, tasks), ...groupsIn(text, groups), ...notesIn(text, notes)].sort((a, b) => a.at - b.at);
  const artifacts = artifactLinks(text).map((url) => `- ${url}: ${ARTIFACT_NOTE}`);
  if (!named.length && !artifacts.length) return "";
  const lines = named.map(({ ref, page: p, widget: w, workspace: ws, task: t, group: g, note }) => {
    if (note) return `- @${ref}: the note "${note.title}"${note.whose ? `, ${note.whose}'s` : ""} on agentbook (ab_note_read with note "${note.id}" reads it)`;
    if (ws) return `- @${ref}: the workspace "${ws.name}", ${whereIs(ws)}`;
    if (t) return `- @${ref}: ${taskIs(t)}${t.here ? "; this thread is on it now (ab_tasks lists it first; tick it off there once it's done)" : ""}`;
    if (g) return `- @${ref}: the group "${g.name}"${g.here ? "; this thread is in it now (ab_group_read has its brief, its threads and its files)" : ""}`;
    if (w) {
      const when = [w.v ? `changed in v${w.v}` : "", w.at ? ago(w.at, now) : ""].filter(Boolean).join(", ");
      return `- @${ref}: the widget "${w.title || w.id}" on the page "${p.title}": ${outline(w)}${when ? ` (${when})` : ""}`;
    }
    const n = (p.widgets || []).length;
    return `- @${ref}: the page "${p.title}", ${plural(n, "widget")} (v${p.version}${p.updated ? `, changed ${ago(p.updated, now)}` : ""})${p.archived ? ", archived" : ""}`;
  });
  return `Named:\n${[...lines, ...artifacts].join("\n")}`;
}
