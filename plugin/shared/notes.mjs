// Notes: documents a person writes in agentbook, a block at a time, kept as markdown; the
// comments on their words, and the edits agents suggest. A note is a person's, like a page, and lives in the
// server's store. Every change to its text is a version, with who made it: { user } by hand, or { agent, post }.
//
// Comments and suggestions find their words by the words (a comment's `quote`, a suggestion's `find`), not by a
// place in the text, so they stay on them as the note changes around them. A comment is a short conversation: its
// messages, yours and agents', and the thread it talks to (`launch`, then `post`) once it names an agent. A
// suggestion is one of those messages: these words, replaced by those, until you accept or reject it.
//
// You can also @ an agent in the text itself, at a point in it: that's a comment on the line it's in, whose `spot` is
// that line of the markdown, which its agent is told to work at. And a thread can name a note, or read one, without a
// comment: `refs` keeps those, so the note can list every thread tied to it.
//
// A note is its owner's. They say who else sees it (`visibility`: private, followers or public, visibility.mjs) and
// who's on it (`people`, by account id): the people on it, or on a note it's inside of, see it and work in it as its
// owner does.
//
// The store applies the ops with applyNote(): note.create, note.write, note.archive, note.visibility, note.person,
// note.comment, note.reply, note.thread, note.resolve, note.suggest, note.settle and note.ref. The routes (main.mjs)
// check and shape what goes in.

import { levelOf } from "./visibility.mjs";

export const NOTE_MAX = 200 * 1024; // a note's markdown
export const COMMENT_MAX = 8000;
export const VERSIONS_KEPT = 300; // per note; older ones go
export const REFS_KEPT = 200; // the threads that named or read a note, the latest ones
const SITTING_MS = 5 * 60e3; // your edits this close together are one version

// A note's id, from its title, as a page's is ("Soft launch: the first 20" is "soft-launch-the-first-20"), and the
// next one with that title "...-2". It stays when the title changes: links and agents use it.
export function noteId(title, taken) {
  const base = String(title || "note").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "note";
  if (!taken(base)) return base;
  for (let n = 2; ; n++) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
}

// Its comments that are open, and whose words are where: what the page and an agent read of it.
export const openComments = (n) => (n.comments || []).filter((c) => !c.resolved);
export const openSuggestions = (n) => (n.suggestions || []).filter((s) => s.state === "open");

// Accepting a suggestion: its words, replaced. Null when they aren't there any more.
export function acceptIn(text, s) {
  const at = s.find ? String(text).indexOf(s.find) : -1;
  return at < 0 ? null : text.slice(0, at) + s.replace + text.slice(at + s.find.length);
}

/* ---------- applying the ops (the store calls this) ---------- */

// The note as it is now, as its next version. Your hand edits a sitting apart are one: the last version, made by
// you by hand less than five minutes before, is replaced by this one (with a new id, since a version, once
// written, is never written again).
function addVersion(state, n, { at, by, hand = false, accepted = null }) {
  const mine = state.note_versions.filter((v) => v.note === n.id);
  const last = mine[mine.length - 1];
  const sitting = hand && !accepted && last && last.hand && last.v > 1 && !last.accepted && by?.user && last.by?.user === by.user && Date.parse(at) - Date.parse(last.started || last.at) < SITTING_MS;
  if (sitting) state.note_versions = state.note_versions.filter((v) => v !== last);
  else n.version = (n.version || 0) + 1;
  const v = { id: `${n.id}@${n.version}${sitting ? `.${Date.parse(at)}` : ""}`, note: n.id, v: n.version, at, started: sitting ? last.started || last.at : at, by, hand, ...(accepted ? { accepted } : {}), title: n.title, text: n.text };
  state.note_versions.push(v);
  n.updated = at;
  n.last = { v: n.version, at, by, hand, ...(accepted ? { accepted } : {}) };
  const drop = mine.length + (sitting ? 0 : 1) - VERSIONS_KEPT;
  if (drop > 0) {
    const old = new Set(mine.filter((x) => x !== last || !sitting).slice(0, drop));
    state.note_versions = state.note_versions.filter((x) => !old.has(x));
  }
}

const msgOf = (op, now) => ({ id: op.mid, at: now, by: op.by, text: op.text || "", ...(op.sid ? { sugg: op.sid } : {}) });

export function applyNote(state, op, now) {
  const n = state.notes[op.nid];
  if (op.t !== "note.create" && !n) return;
  if (n) n.rev = (n.rev || 0) + 1; // anything that happens on it: the page reads it again
  switch (op.t) {
    case "note.create": {
      if (n) break;
      // `owner`: the person whose note it is; `made`: the agent that made it, which may write it straight away
      // (it keeps it). `parent`: the note it's inside of.
      const note = { id: op.nid, title: op.title || "Untitled", emoji: op.emoji || "📄", parent: op.parent || null, owner: op.owner || null, by: op.by, made: op.made || null, workspace: op.workspace || null, page: op.page || null, text: op.text || "", visibility: levelOf(op.visibility), people: [], version: 0, created: now, updated: now, archived: null, comments: [], suggestions: [], rev: 1 };
      state.notes[op.nid] = note;
      addVersion(state, note, { at: now, by: op.by, hand: !!op.hand });
      break;
    }
    case "note.write": {
      const before = { text: n.text, title: n.title, emoji: n.emoji };
      for (const k of ["text", "title", "emoji"]) if (op[k] !== undefined) n[k] = op[k];
      for (const k of ["parent", "workspace", "page"]) if (op[k] !== undefined) n[k] = op[k] || null;
      // A new text or title is a version; where it is and what it's linked to aren't.
      if (n.text !== before.text || n.title !== before.title || n.emoji !== before.emoji) addVersion(state, n, { at: now, by: op.by, hand: !!op.hand });
      else n.updated = now;
      break;
    }
    case "note.archive":
      n.archived = op.archived === false ? null : now;
      break;
    case "note.visibility":
      n.visibility = levelOf(op.visibility, levelOf(n.visibility));
      break;
    case "note.person": {
      // Someone on it (`user`, their account id), or taken off it (`remove`).
      const was = (n.people || []).find((p) => p.user === op.user);
      n.people = (n.people || []).filter((p) => p.user !== op.user);
      if (!op.remove) n.people.push(was || { user: op.user, at: now, by: op.by || null });
      break;
    }
    case "note.comment": {
      if (n.comments.some((c) => c.id === op.cid)) break;
      // `quote`: the words it's on, as they read (none: the whole note); `nth`: which of the places they are. `spot`:
      // the line of the markdown an agent was @'d in, for one made there in the text.
      n.comments.push({ id: op.cid, at: now, by: op.by, quote: op.quote || "", nth: op.nth || 0, ...(op.spot ? { spot: op.spot } : {}), msgs: [msgOf(op, now)], launch: null, post: op.post || null, resolved: null });
      n.updated = now;
      break;
    }
    case "note.reply": {
      const c = n.comments.find((x) => x.id === op.cid);
      if (!c || c.msgs.some((m) => m.id === op.mid)) break;
      c.msgs.push(msgOf(op, now));
      // Something said in it opens it again.
      c.resolved = null;
      n.updated = now;
      break;
    }
    case "note.thread": {
      // The thread a comment talks to: the launch that starts it, then its post once it has one.
      const c = n.comments.find((x) => x.id === op.cid);
      if (!c) break;
      if (op.launch !== undefined) c.launch = op.launch || null;
      if (op.post !== undefined) c.post = op.post || null;
      break;
    }
    case "note.resolve": {
      const c = n.comments.find((x) => x.id === op.cid);
      if (c) c.resolved = op.resolved === false ? null : { at: now, by: op.by };
      break;
    }
    case "note.suggest": {
      if (n.suggestions.some((s) => s.id === op.sid)) break;
      n.suggestions.push({ id: op.sid, at: now, by: op.by, comment: op.cid, find: op.find, replace: op.replace ?? "", state: "open", settled: null });
      const c = n.comments.find((x) => x.id === op.cid);
      if (c && !c.msgs.some((m) => m.id === op.mid)) {
        c.msgs.push(msgOf(op, now));
        c.resolved = null;
      }
      n.updated = now;
      break;
    }
    case "note.settle": {
      // Accepting one is a version of the note by whoever accepted it, saying whose suggestion it was.
      const s = n.suggestions.find((x) => x.id === op.sid);
      if (!s || s.state !== "open") break;
      if (op.keep) {
        const text = acceptIn(n.text, s);
        if (text == null) break;
        n.text = text;
        addVersion(state, n, { at: now, by: op.by, hand: true, accepted: { sid: s.id, by: s.by } });
        // The comment it answers moves onto the words it put in, so it stays beside them. One made in the text says
        // so in `quote` (the route's: it's the page's words, not the markdown's), and has no line to work at any more.
        const c = n.comments.find((x) => x.id === s.comment);
        if (c?.spot && op.quote !== undefined) {
          if (op.quote) c.quote = op.quote;
          delete c.spot;
        } else if (c?.quote && c.quote.includes(s.find)) c.quote = c.quote.replace(s.find, s.replace);
        else if (c?.quote && s.find.includes(c.quote) && s.replace) c.quote = s.replace;
      }
      s.state = op.keep ? "kept" : "undone";
      s.settled = { at: now, by: op.by };
      break;
    }
    case "note.ref": {
      // A thread that names it or reads it (`how`), by its `post`, or by its `launch` while it starts. Named is the
      // stronger of the two, and stays.
      const refs = (n.refs ||= []);
      const was = refs.find((r) => (op.post && r.post === op.post) || (op.launch && r.launch === op.launch));
      if (was) {
        if (op.how === "named") was.how = "named";
        was.at = now;
      } else refs.push({ ...(op.post ? { post: op.post } : { launch: op.launch }), how: op.how, at: now });
      if (refs.length > REFS_KEPT) n.refs = refs.slice(-REFS_KEPT);
      break;
    }
  }
}

// What the list, the tree and the left column read of a note: all of it but its text and its conversations, which
// its own page asks for. `plain`: its words without markdown (notes-md.js, on the server's side).
export function noteSummary(n, plain = (t) => t) {
  const open = openComments(n);
  // how it starts: its first lines, one after another
  const lines = plain(n.text || "").split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const words = lines.join(" ");
  return {
    id: n.id, title: n.title, emoji: n.emoji, parent: n.parent, owner: n.owner, by: n.by, made: n.made, workspace: n.workspace, page: n.page,
    visibility: levelOf(n.visibility), people: (n.people || []).map((p) => p.user),
    version: n.version, created: n.created, updated: n.updated, archived: n.archived, last: n.last, rev: n.rev || 0,
    start: lines.join(" · ").slice(0, 160), words: words ? words.split(" ").length : 0,
    comments: open.length, suggestions: openSuggestions(n).length,
    // the threads its comments talk to, so the page can say when one is working or waits on you
    threads: [...new Set(open.map((c) => c.post).filter(Boolean))],
  };
}
