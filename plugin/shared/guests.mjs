// A thread's guests: the agents brought into it by @-ing them in its box. A guest runs as
// a thread of its own; what it says shows in the thread it's a guest in, and each thread there hears what the others
// said with the next message it gets. The server keeps which thread a guest is in, and how far each thread there has
// heard, by the page's ids: a guest and its thread can be on different machines.
//
// The store applies the ops with applyGuest():
//   thread.guest { gid, host, agent, launch?, post?, by }: a guest joins thread `host` (again, if it had left).
//     `launch`: the start of its session, while it isn't there yet; `post` once it is. A thread that was there
//     already has no launch, and `after`: the last message it had when it joined ("none" for none), since what it
//     said before isn't part of the conversation.
//   thread.guest { gid, post }: the session its launch became.
//   thread.guest { gid, remove: true, by }: it leaves; what it said stays in the thread.
//   thread.seen { post, upto }: thread `post` has heard the others' messages up to `upto` (an ISO time).

// What a guest's reply may be, in what the others hear: the rest is ab_thread_read's.
export const NEWS_LINES = 6;
export const NEWS_CHARS = 2000;

export function applyGuest(state, op, now) {
  const guests = (state.thread_guests ||= {});
  switch (op.t) {
    case "thread.guest": {
      const g = guests[op.gid];
      if (op.remove) {
        if (g && !g.removed) Object.assign(g, { removed: now, removed_by: op.by || null });
        break;
      }
      if (!g) {
        if (!op.host) break;
        guests[op.gid] = { id: op.gid, host: op.host, agent: op.agent || null, launch: op.launch || null, post: op.post || null, by: op.by || null, at: now, removed: null, ...(op.after ? { after: op.after } : {}) };
        break;
      }
      if (op.post) g.post = op.post;
      // Brought in again: it hears the thread from now on, as when it first joined.
      if (op.host && g.removed) Object.assign(g, { removed: null, removed_by: null, back: now, ...(op.after ? { after: op.after } : {}) });
      break;
    }
    case "thread.seen": {
      const seen = (state.thread_seen ||= {});
      if (op.post && op.upto && !(seen[op.post] >= op.upto)) seen[op.post] = op.upto;
      break;
    }
  }
}

// A thread's guests, in the order they came, with those that left (`removed`).
export const guestsOf = (state, host) => Object.values(state.thread_guests || {}).filter((g) => g.host === host).sort((a, b) => a.at.localeCompare(b.at));

// A message as the others hear it: on one line, and not longer than a reply may be.
export function newsQuote(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return `"${t.length > NEWS_CHARS ? `${t.slice(0, NEWS_CHARS - 1)}…` : t}"`;
}

// What a thread hears with its next message: `lines` [{ at, text }] since it last heard, oldest first, the last
// NEWS_LINES of them. "" when there are none.
export function newsText(lines) {
  if (!lines.length) return "";
  const shown = lines.slice(-NEWS_LINES);
  const more = lines.length - shown.length;
  return `From your thread since your last turn:\n${shown.map((l) => `  ${l.text}`).join("\n")}${more ? `\n  and ${more} earlier ${more === 1 ? "line" : "lines"}: ab_thread_read has them` : ""}`;
}
