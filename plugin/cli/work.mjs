// A post's work, sent up as it happens: its steps and plan, the pictures its
// agent saw, and what it changed, so the server shows a post whole while its machine is off.
//
// Each goes up as an op in the store's log (post.steps, post.images, post.changes), so it's sent once, in order,
// and resent after a dropped connection like any other. Only what changed since it was last sent goes: the steps
// from the first one that differs, pictures not sent yet (their bytes as blobs, once each), and the scopes of
// its changes whose content changed. What was sent is remembered in the store's database, so a restart doesn't
// send it all again.

import crypto from "node:crypto";

const hash = (v) => crypto.createHash("sha1").update(JSON.stringify(v ?? null)).digest("base64url").slice(0, 16);
const BACKFILL_DAYS = 14;
const AT_ONCE = 2; // posts worked out at the same time
const QUIET_MS = 800; // a post that keeps changing is looked at once it pauses, or every few seconds
const STEPS_BYTES = 512 * 1024; // the steps one op holds, so a long thread's go behind a proxy that takes 1 MB (with its plan and one more step)

// `stepsOf(s)`: { steps, plan, turn } for a post, or null. `imagesOf(s, step)`: [{ type, data (base64) }].
// `changesOf(s)`: { scopes: { key: data }, meta } for what it changed (see daemon.mjs). `blobPut(buf, type)`: keeps
// bytes on the server, by their sha256.
function parts(steps, from) {
  const out = [{ from, steps: [] }];
  let bytes = 0;
  for (let i = from; i < steps.length; i++) {
    const size = JSON.stringify(steps[i]).length;
    if (bytes && bytes + size > STEPS_BYTES) {
      out.push({ from: i, steps: [] });
      bytes = 0;
    }
    out.at(-1).steps.push(steps[i]);
    bytes += size;
  }
  return out;
}

export function createWork({ store, stepsOf, imagesOf, changesOf, blobPut, historyFrom = () => 0, log = () => {} }) {
  const { state, commit, db } = store;
  db.exec("create table if not exists work_sent (post text primary key, data text not null)");
  const sentOf = (post) => {
    const r = db.prepare("select data from work_sent where post = ?").get(post);
    return r ? JSON.parse(r.data) : { steps: [], plan: null, turn: null, images: {}, changes: {} };
  };
  const keep = (post, sent) => db.prepare("insert into work_sent (post, data) values (?, ?) on conflict (post) do update set data = excluded.data").run(post, JSON.stringify(sent));

  const due = new Map(); // post -> { at, changes }: posts to look at
  let running = 0;
  let timer = null;

  // Look at a post again soon: its steps, and with `changes`, what it changed.
  function touch(post, { changes = false, now = false } = {}) {
    if (!state.sessions[post]) return;
    const d = due.get(post) || { at: Date.now() + (now ? 0 : QUIET_MS), changes: false, first: Date.now() };
    // Pushed back while it keeps changing, but not more than a few seconds.
    if (!now && Date.now() - d.first < 4000) d.at = Date.now() + QUIET_MS;
    d.changes ||= changes;
    due.set(post, d);
    schedule();
  }
  function schedule() {
    if (timer) return;
    const next = Math.min(...[...due.values()].map((d) => d.at));
    if (!Number.isFinite(next)) return;
    timer = setTimeout(() => {
      timer = null;
      pump();
    }, Math.max(0, next - Date.now()));
    timer.unref?.();
  }
  function pump() {
    const now = Date.now();
    for (const [post, d] of due) {
      if (running >= AT_ONCE) break;
      if (d.at > now) continue;
      due.delete(post);
      running++;
      send(post, d)
        .catch((e) => log(`work ${post}: ${e.message}`))
        .finally(() => {
          running--;
          schedule();
        });
    }
    schedule();
  }

  async function send(post, { changes }) {
    const s = state.sessions[post];
    if (!s || s.cloud) return;
    const sent = sentOf(post);
    let later = false; // a picture couldn't go up: looked at again in a while
    const d = await stepsOf(s);
    if (d) {
      // The steps from the first one that isn't what was sent, with the plan and the turn.
      const hashes = d.steps.map(hash);
      let from = 0;
      while (from < hashes.length && from < sent.steps.length && hashes[from] === sent.steps[from]) from++;
      const plan = hash(d.plan);
      if (from < hashes.length || hashes.length < sent.steps.length || plan !== sent.plan || d.turn !== sent.turn) {
        // In parts, each from where the last one ended, which is how the server reads them.
        for (const part of parts(d.steps, from)) commit({ t: "post.steps", post, from: part.from, steps: part.steps, total: d.steps.length, plan: d.plan ?? null, turn: d.turn ?? 0 });
        Object.assign(sent, { steps: hashes, plan, turn: d.turn });
      }
      // Pictures its agent saw, by step: the ones not sent yet.
      for (const step of d.steps) {
        const n = step.images || 0;
        if (!n || (sent.images[step.id] || 0) >= n) continue;
        const pics = (await imagesOf(s, step.id).catch(() => [])) || [];
        const list = [];
        for (const p of pics) {
          const buf = Buffer.from(p.data, "base64");
          const sha = await blobPut(buf, p.type).catch(() => null);
          if (!sha) break;
          list.push({ sha, type: p.type, size: buf.length });
        }
        // The server out of reach: this step's pictures wait, and the rest goes on (its steps aren't sent again).
        if (list.length < pics.length) {
          later = true;
          continue;
        }
        if (list.length) commit({ t: "post.images", post, step: step.id, images: list });
        sent.images[step.id] = pics.length;
      }
    }
    if (changes || !sent.changesAt) {
      const c = await changesOf(s).catch(() => null);
      if (c) {
        for (const [key, data] of Object.entries(c.scopes)) {
          const h = hash(data);
          if (sent.changes[key] === h) continue;
          commit({ t: "post.changes", post, scope: key, data });
          sent.changes[key] = h;
        }
        const mh = hash(c.meta);
        if (sent.changes.meta !== mh) {
          commit({ t: "post.changes", post, scope: "meta", data: c.meta });
          sent.changes.meta = mh;
        }
        sent.changesAt = new Date().toISOString();
      }
    }
    keep(post, sent);
    if (later) setTimeout(() => touch(post), 30e3).unref?.();
  }

  // Posts of the last two weeks whose work hasn't gone up yet (an agentbook from before the split, or a new
  // server): looked at a few at a time, after a little while.
  function backfill() {
    const since = Math.max(Date.now() - BACKFILL_DAYS * 86400e3, historyFrom());
    const have = new Set(db.prepare("select post from work_sent").all().map((r) => r.post));
    const posts = Object.values(state.sessions)
      .filter((s) => !s.cloud && !have.has(s.id) && Date.parse(s.updated || s.started || 0) > since)
      .sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
    posts.forEach((s, i) => setTimeout(() => touch(s.id, { changes: true, now: true }), 2000 + i * 300).unref?.());
    if (posts.length) log(`sending the work of ${posts.length} threads from the last ${BACKFILL_DAYS} days`);
  }

  // A server that has none of it: everything is to be sent again.
  const reset = () => db.prepare("delete from work_sent").run();
  return { touch, backfill, reset, forget: (post) => db.prepare("delete from work_sent where post = ?").run(post) };
}

// The kinds of op that carry a post's work: what the CLI no longer needs once its server has them.
export const WORK_OPS = ["post.steps", "post.images", "post.changes", "post.picture"];
