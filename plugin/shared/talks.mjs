// Threads you start yourself: a thread that's a person's, not an agent's, kept on
// agentbook-server with no machine behind it. The agents you @ in it join it as guests (guests.mjs): each one a thread
// of its own, whose messages show in yours. Here: your thread, and what you write in it. "talk" is the name inside;
// the page calls it a thread, as it does any other.
//
// The store applies the ops with applyTalk():
//   talk.create { tid, mid, owner, by, text, files?, workspace?, visibility? }: a thread of yours, with its first message.
//   talk.say { tid, mid, by, text, files? }: a message of yours in it. `files`: what you attached, as machines fetch it.
//   talk.sent { tid, mid, to }: it went to guest `to` (its record's id, guests.mjs). One sent to nobody stays here.
//   talk.title { tid, title }: its title, when you give one; else it's the first line of its first message.
//   talk.flag { tid, archived }
//   talk.visibility { tid, visibility }: "private" (the default) or "public" (anyone signed in reads it).

// Its id: "t-" and 12 hex digits, so it's never a session's (a uuid) or a machine's (machine~id).
import { levelOf } from "./visibility.mjs";

export const TALK_ID = /^t-[0-9a-f]{12}$/;
export const isTalkId = (id) => typeof id === "string" && TALK_ID.test(id);
// What it keeps of its messages: the latest.
export const TALK_MESSAGES = 500;
export const TALK_TEXT_MAX = 12000;

export function applyTalk(state, op, now) {
  const talks = (state.talks ||= {});
  const t = talks[op.tid];
  switch (op.t) {
    case "talk.create": {
      if (t || !isTalkId(op.tid) || !op.owner) break;
      talks[op.tid] = { id: op.tid, owner: op.owner, by: op.by || null, title: null, at: now, updated: now, workspace: op.workspace || null, visibility: levelOf(op.visibility), archived: false, messages: [msgOf(op, now)] };
      break;
    }
    case "talk.say": {
      if (!t || t.messages.some((m) => m.id === op.mid)) break;
      t.messages.push(msgOf(op, now));
      if (t.messages.length > TALK_MESSAGES) t.messages.splice(1, t.messages.length - TALK_MESSAGES);
      t.updated = now;
      // Writing in an archived one brings it back, as it does a thread.
      t.archived = false;
      break;
    }
    case "talk.sent": {
      const m = t?.messages.find((x) => x.id === op.mid);
      if (m && op.to && !m.sent.includes(op.to)) m.sent.push(op.to);
      break;
    }
    case "talk.title":
      if (t) t.title = String(op.title || "").trim() || null;
      break;
    case "talk.flag":
      if (t) t.archived = !!op.archived;
      break;
    case "talk.visibility":
      if (t) t.visibility = levelOf(op.visibility);
      break;
  }
}
const msgOf = (op, now) => ({ id: op.mid, by: op.by || null, text: String(op.text || ""), files: op.files || [], sent: [], at: now });

// Its title: the one you gave it, or its first message's first line (as a thread's prompt titles it).
export const talkTitle = (t) => t.title || (t.messages[0]?.text || "").split("\n")[0].trim().slice(0, 200) || "New thread";
// Its text, under the title: the rest of its first message, when the title is its first line.
export const talkText = (t) => {
  const first = t.messages[0]?.text || "";
  return t.title ? first : first.split("\n").slice(1).join("\n").trim();
};
