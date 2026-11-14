// agentbook's database: SQLite, built into Node (node:sqlite), at <data folder>/agentbook.db.
//
// The server works on its state in memory, and every change is an op (see store.mjs). The database keeps
// both halves:
// - `events`: every op, written as it's committed, so nothing is lost if the server dies.
// - one table per kind of thing (agents, sessions, messages, files…): the state, written as a checkpoint
//   every few seconds and when the server exits, along with the last op it includes (`meta.checkpoint`).
// Starting up loads the tables, then replays the ops after the checkpoint. Rows keep what queries need in
// columns (post, owner, visibility) and the whole thing as JSON in `data`. A row goes only when what it keeps
// does: a thread's history out of memory (store.mjs) keeps its rows.

import fs from "node:fs";

// node:sqlite works without a flag since Node 22.13 but still warns that it's experimental; say nothing.
const emit = process.emitWarning;
process.emitWarning = (warning, ...rest) => (/SQLite/i.test(String(warning?.message ?? warning)) ? undefined : emit.call(process, warning, ...rest));
const { DatabaseSync } = await import("node:sqlite");
process.emitWarning = emit;
export { DatabaseSync }; // for reading other programs' databases (Hermes's), as quietly

const MIGRATIONS = [
  // 1: the state the server keeps, and its log of changes
  `create table meta (key text primary key, value text);
   create table events (seq integer primary key, at text not null, op text not null);
   create table agents (id text primary key, owner text, data text not null);
   create table sessions (id text primary key, agent text, owner text, visibility text, updated text, data text not null);
   create table procs (proc text primary key, post text not null);
   create table launches (id text primary key, post text, ord integer not null, data text not null);
   create table questions (id text primary key, post text, ord integer not null, data text not null);
   create table todos (id text primary key, post text, ord integer not null, data text not null);
   create table files (id text primary key, post text, owner text, ord integer not null, data text not null);
   create table messages (id text primary key, post text, ord integer not null, data text not null);
   create table outbox (id text primary key, post text, delivered integer, ord integer not null, data text not null);
   create index sessions_agent on sessions (agent);
   create index messages_post on messages (post, ord);
   create index questions_post on questions (post);
   create index files_post on files (post);
   create index outbox_post on outbox (post, delivered);`,
  // 2: people, how they sign in, invites, and the machines they've connected
  `create table users (id text primary key, username text not null unique, display_name text, bio text, password text not null, role text not null default 'member', created text not null);
   create table auth_sessions (token_hash text primary key, user_id text not null references users (id) on delete cascade, created text not null, expires text not null, last_seen text, user_agent text);
   create table invites (code text primary key, created_by text not null references users (id) on delete cascade, created text not null, used_by text references users (id), used_at text, revoked integer not null default 0);
   create table devices (id text primary key, user_id text not null references users (id) on delete cascade, name text not null, token_hash text not null unique, created text not null, last_seen text, revoked integer not null default 0);
   create table device_requests (code text primary key, poll_hash text not null unique, name text not null, created text not null, approved_by text references users (id) on delete cascade, token text);
   create index auth_sessions_user on auth_sessions (user_id);
   create index devices_user on devices (user_id);`,
  // 3: pins are each person's own
  `create table pins (user_id text not null references users (id) on delete cascade, post text not null, at text not null, primary key (user_id, post));`,
  // 4: workspaces, the repos and folders people keep their sessions in
  `create table workspaces (id text primary key, owner text, ord integer not null, data text not null);
   create index workspaces_owner on workspaces (owner);`,
  // 5: each person's to-do list
  `create table tasks (id text primary key, owner text, data text not null);
   create index tasks_owner on tasks (owner);`,
  // 6: pages agents keep up to date, and every version of each
  `create table pages (id text primary key, visibility text, updated text, data text not null);
   create table page_versions (id text primary key, page text not null, ord integer not null, data text not null);
   create index page_versions_page on page_versions (page, ord);`,
  // 7: people's avatars (JSON: { image, type } or { emoji })
  `alter table users add column avatar text;`,
  // 8: page routines, each version of their code, and their runs
  `create table routines (id text primary key, page text, data text not null);
   create table routine_code (id text primary key, routine text not null, ord integer not null, data text not null);
   create table routine_runs (id text primary key, routine text not null, ord integer not null, data text not null);
   create index routine_code_routine on routine_code (routine, ord);
   create index routine_runs_routine on routine_runs (routine, ord);`,
  // 9: the pages each person follows (1) or stopped following (0); a page with no row follows its default
  `create table follows (user_id text not null references users (id) on delete cascade, page text not null, following integer not null, at text not null, primary key (user_id, page));`,
  // 10: groups, a space many agents share: their notes, every version of their files, and what happened in them
  `create table groups (id text primary key, updated text, data text not null);
   create table group_notes (id text primary key, grp text not null, ord integer not null, data text not null);
   create table group_files (id text primary key, grp text not null, ord integer not null, data text not null);
   create table group_events (id text primary key, grp text not null, ord integer not null, data text not null);
   create index group_notes_grp on group_notes (grp, ord);
   create index group_files_grp on group_files (grp, ord);
   create index group_events_grp on group_events (grp, ord);`,
  // 11: the group each post is in, as agentbook-server keeps it (a post is its machine's)
  `create table group_posts (id text primary key, grp text, data text not null);`,
  // 12: notes people write, with their comments and suggestions, and every version of each
  `create table notes (id text primary key, owner text, updated text, data text not null);
   create table note_versions (id text primary key, note text not null, ord integer not null, data text not null);
   create index notes_owner on notes (owner);
   create index note_versions_note on note_versions (note, ord);`,
  // 13: a thread's guests, the agents brought into it, and how far each thread there heard the others
  `create table thread_guests (id text primary key, host text, data text not null);
   create table thread_seen (id text primary key, data text not null);
   create index thread_guests_host on thread_guests (host);`,
  // 14: threads people start themselves, with no agent behind them
  `create table talks (id text primary key, owner text, updated text, data text not null);
   create index talks_owner on talks (owner);`,
  // 15: WIPs of many, the ones people make to hold pull requests, branches and threads
  `create table wip_sets (id text primary key, owner text, updated text, data text not null);
   create index wip_sets_owner on wip_sets (owner);`,
  // 16: the page a thread's person put it on by hand, or took it off
  `create table page_posts (id text primary key, page text, data text not null);`,
  // 17: who follows which agent, at what level
  `create table agent_follows (id text primary key, agent text, follower text, data text not null);
   create index agent_follows_agent on agent_follows (agent);`,
  // 18: who follows which person, at what level
  `create table person_follows (id text primary key, person text, follower text, data text not null);
   create index person_follows_person on person_follows (person);`,
  // 19: the page updates each person archived off their feed
  `create table feed_archived (id text primary key, data text not null);`,
  // 20: the cloud sandbox each machine runs in, as its owner said or as agentbook made it
  `create table machine_cloud (id text primary key, data text not null);`,
  // 21: images for cloud machines, as their owners define them, and each build of one
  `create table images (id text primary key, owner text, data text not null);
   create table image_builds (id text primary key, image text, data text not null);
   create index image_builds_image on image_builds (image);`,
  // 22: shared machines: who's on each, by the machine that's shared
  `create table boxes (id text primary key, owner text, data text not null);`,
];

export function openDb(file) {
  const db = new DatabaseSync(file);
  try {
    return migrate(db);
  } catch (e) {
    leaveOpen(file, db);
    throw e;
  }
}

// A connection that failed, kept open and in reach until the process ends. Closed, it deletes the -wal beside a file
// SQLite can't read, and a connection nothing refers to is closed by the next garbage collection. One per file, as a
// server tries a machine's store again at each hello; the one it replaces isn't the last, so it deletes nothing.
const failed = new Map();
export const leaveOpen = (file, db) => failed.set(file, db);

// Its settings, and its tables brought up to date.
export function migrate(db) {
  db.exec("pragma journal_mode = wal; pragma synchronous = normal; pragma busy_timeout = 5000; pragma foreign_keys = on;");
  db.exec("create table if not exists schema_version (version integer not null)");
  const version = db.prepare("select version from schema_version").get()?.version ?? 0;
  for (let v = version; v < MIGRATIONS.length; v++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[v]);
      db.exec("delete from schema_version");
      db.prepare("insert into schema_version (version) values (?)").run(v + 1);
    });
  }
  return db;
}

// SQLite's own word for a file it can't read as a database: SQLITE_CORRUPT or SQLITE_NOTADB, extended codes included.
// Locked, busy, read-only or can't-open never are: those pass, or are about something else, and the data is fine.
export const isCorrupt = (e) => e?.code === "ERR_SQLITE_ERROR" && [11, 26].includes(e.errcode & 0xff);

// Move a database out of the way whole: its -wal holds what was written last, and SQLite wants it beside the file,
// under the same name. `db`: its open connection. As the last one closes, SQLite folds the -wal into the file and
// deletes it, or only deletes it when it can't read the file, so what's kept is copied first; and what's left goes
// before the file does, or a new database would read an old -wal. Nothing already there is written over.
// -> where it went.
export const CORRUPT = ".corrupt-";
export function moveAside(file, db) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let to = `${file}${CORRUPT}${stamp}`;
  for (let n = 2; fs.existsSync(to); n++) to = `${file}${CORRUPT}${stamp}-${n}`;
  const sides = ["-wal", "-shm"].filter((s) => fs.existsSync(file + s));
  for (const s of sides) fs.copyFileSync(file + s, to + s);
  try {
    db.close();
  } catch {}
  for (const s of sides) fs.rmSync(file + s, { force: true });
  fs.renameSync(file, to);
  return to;
}

export function transaction(db, fn) {
  db.exec("begin immediate");
  try {
    const out = fn();
    db.exec("commit");
    return out;
  } catch (e) {
    db.exec("rollback");
    throw e;
  }
}

// How each part of the state maps to a table. Keyed parts are objects by id; listed parts are arrays,
// kept in order with `ord` (files are newest first). A thread's history (`paged`: its questions, files and
// messages) can be out of memory while its rows stay (pageOut), and back (pageIn).
const PARTS = {
  agents: { keyed: true, columns: (a) => ({ owner: a.owner ?? null }) },
  sessions: { keyed: true, columns: (s) => ({ agent: s.agent ?? null, owner: s.owner ?? null, visibility: s.visibility ?? null, updated: s.updated ?? null }) },
  procs: { keyed: true, plain: true },
  launches: { keyed: true, ordered: true, columns: (l) => ({ post: l.post ?? null }) },
  questions: { paged: true, columns: (q) => ({ post: q.post ?? null }) },
  todos: { columns: (t) => ({ post: t.post ?? null }) },
  files: { paged: true, newestFirst: true, columns: (f) => ({ post: f.post ?? null, owner: f.owner ?? null }) },
  messages: { paged: true, columns: (m) => ({ post: m.post ?? null }) },
  outbox: { idOf: (o) => o.oid, columns: (o) => ({ post: o.post ?? null, delivered: o.delivered ? 1 : 0 }) },
  workspaces: { keyed: true, ordered: true, columns: (w) => ({ owner: w.owner ?? null }) },
  tasks: { keyed: true, columns: (t) => ({ owner: t.owner ?? null }) },
  pages: { keyed: true, columns: (p) => ({ visibility: p.visibility ?? null, updated: p.updated ?? null }) },
  // A version never changes once made, so a checkpoint skips the ones it wrote already.
  page_versions: { immutable: true, columns: (v) => ({ page: v.page }) },
  routines: { keyed: true, columns: (r) => ({ page: r.page ?? null }) },
  routine_code: { columns: (c) => ({ routine: c.routine }) },
  routine_runs: { immutable: true, columns: (x) => ({ routine: x.routine }) },
  groups: { keyed: true, columns: (g) => ({ updated: g.updated ?? null }) },
  group_notes: { columns: (n) => ({ grp: n.group }) },
  // A file's version and a line in a group's feed never change once made.
  group_files: { immutable: true, columns: (v) => ({ grp: v.group }) },
  group_events: { immutable: true, columns: (e) => ({ grp: e.group }) },
  group_posts: { keyed: true, columns: (m) => ({ grp: m.group ?? null }) },
  notes: { keyed: true, columns: (n) => ({ owner: n.owner ?? null, updated: n.updated ?? null }) },
  // A version never changes once made (a sitting's next edit makes a new one in its place).
  note_versions: { immutable: true, columns: (v) => ({ note: v.note }) },
  thread_guests: { keyed: true, columns: (g) => ({ host: g.host ?? null }) },
  thread_seen: { keyed: true },
  talks: { keyed: true, columns: (t) => ({ owner: t.owner ?? null, updated: t.updated ?? null }) },
  wip_sets: { keyed: true, columns: (w) => ({ owner: w.owner ?? null, updated: w.updated ?? null }) },
  page_posts: { keyed: true, columns: (m) => ({ page: m.page ?? null }) },
  agent_follows: { keyed: true, columns: (f) => ({ agent: f.agent ?? null, follower: f.user ?? null }) },
  person_follows: { keyed: true, columns: (f) => ({ person: f.person ?? null, follower: f.user ?? null }) },
  // By person: the pages whose latest update they archived, and when each had last moved up the feed.
  feed_archived: { keyed: true },
  // By machine: the cloud sandbox it runs in, and the connector of its owner's that wakes it.
  machine_cloud: { keyed: true },
  images: { keyed: true, columns: (i) => ({ owner: i.owner ?? null }) },
  image_builds: { keyed: true, columns: (b) => ({ image: b.image ?? null }) },
  // By the machine that's shared (its owner's): the people on it.
  boxes: { keyed: true, columns: (b) => ({ owner: b.owner ?? null }) },
};

// Read and write the state. `checkpoint` writes only what changed since the last one.
export function createTables(db) {
  const written = new Map(); // "part id" -> the JSON last written
  const ords = new WeakMap(); // a list item -> its place
  let nextOrd = 1;
  const ordOf = (x) => {
    if (!ords.has(x)) ords.set(x, nextOrd++);
    return ords.get(x);
  };

  const meta = (key) => db.prepare("select value from meta where key = ?").get(key)?.value ?? null;
  const setMeta = db.prepare("insert into meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value");
  const logOp = db.prepare("insert or ignore into events (seq, at, op) values (?, ?, ?)");

  function load() {
    const state = { agents: {}, sessions: {}, procs: {}, launches: {}, questions: [], todos: [], files: [], messages: [], outbox: [], workspaces: {}, tasks: {}, pages: {}, page_versions: [], routines: {}, routine_code: [], routine_runs: [], groups: {}, group_notes: [], group_files: [], group_events: [], group_posts: {}, notes: {}, note_versions: [] , thread_guests: {}, thread_seen: {}, talks: {}, wip_sets: {}, page_posts: {}, agent_follows: {}, person_follows: {}, feed_archived: {}, machine_cloud: {}, images: {}, image_builds: {}, boxes: {} };
    for (const [part, spec] of Object.entries(PARTS)) {
      const rows = db.prepare(spec.plain ? `select proc, post from ${part}` : `select id, ${spec.keyed && !spec.ordered ? "null as ord" : "ord"}, data from ${part} ${spec.keyed && !spec.ordered ? "" : `order by ord ${spec.newestFirst ? "desc" : "asc"}`}`).all();
      for (const r of rows) {
        if (spec.plain) {
          state.procs[r.proc] = r.post;
          written.set(`procs ${r.proc}`, JSON.stringify(r.post));
          continue;
        }
        const x = JSON.parse(r.data);
        if (r.ord != null) {
          ords.set(x, r.ord);
          nextOrd = Math.max(nextOrd, r.ord + 1);
        }
        if (spec.keyed) state[part][r.id] = x;
        else state[part].push(x);
        written.set(`${part} ${r.id}`, r.data);
      }
    }
    return { state, seq: Number(meta("seq") || 0), checkpoint: Number(meta("checkpoint") || 0) };
  }

  // The ops after the checkpoint, to replay over what load() returned.
  const since = (seq) => db.prepare("select op from events where seq > ? order by seq").all(seq).map((r) => JSON.parse(r.op));

  // What it writes and deletes is kept apart (`wrote`, `gone`) until it commits: one that rolls back (a full disk, a
  // record that can't be written) wrote nothing, so the next one writes all of it again rather than skip what this
  // one only meant to write, and take the checkpoint past it.
  function checkpoint(state) {
    let changes = 0;
    const wrote = new Map();
    const gone = new Set();
    const last = (key) => (wrote.has(key) ? wrote.get(key) : written.get(key));
    transaction(db, () => {
      const seen = new Set();
      for (const [part, spec] of Object.entries(PARTS)) {
        const items = spec.keyed ? Object.entries(state[part] || {}) : (state[part] || []).map((x) => [spec.idOf ? spec.idOf(x) : x.id, x]);
        // Order list items oldest first, so new ones get later places (files are kept newest first).
        if (spec.newestFirst) items.reverse();
        for (const [id, x] of items) {
          const key = `${part} ${id}`;
          seen.add(key);
          if (spec.immutable && last(key) !== undefined) continue;
          const json = JSON.stringify(x);
          if (last(key) === json) continue;
          if (spec.plain) db.prepare("insert into procs (proc, post) values (?, ?) on conflict (proc) do update set post = excluded.post").run(id, x);
          else {
            const cols = { ...(spec.columns ? spec.columns(x) : {}), ...(spec.keyed && !spec.ordered ? {} : { ord: ordOf(x) }) };
            const names = Object.keys(cols);
            db.prepare(`insert into ${part} (id, ${names.join(", ")}${names.length ? ", " : ""}data) values (?, ${names.map(() => "?").join(", ")}${names.length ? ", " : ""}?) on conflict (id) do update set ${[...names, "data"].map((n) => `${n} = excluded.${n}`).join(", ")}`).run(id, ...names.map((n) => cols[n]), json);
          }
          wrote.set(key, json);
          changes++;
        }
      }
      for (const key of written.keys()) {
        if (seen.has(key)) continue;
        const [part, ...rest] = key.split(" ");
        const id = rest.join(" ");
        db.prepare(`delete from ${part} where ${part === "procs" ? "proc" : "id"} = ?`).run(id);
        gone.add(key);
        changes++;
      }
      setMeta.run("seq", String(state.seq));
      setMeta.run("checkpoint", String(state.seq));
    });
    for (const [key, json] of wrote) written.set(key, json);
    for (const key of gone) written.delete(key);
    return changes;
  }

  // Ops already in a checkpoint and older than `days` aren't needed to rebuild anything. The last one it took is kept
  // (`meta.pruned`), so a machine's store knows how far back its log still goes.
  function prune(seq, days = 30) {
    const before = new Date(Date.now() - days * 86400e3).toISOString();
    const upTo = db.prepare("select max(seq) n from events where seq <= ? and at < ?").get(seq, before)?.n;
    const changes = db.prepare("delete from events where seq <= ? and at < ?").run(seq, before).changes;
    if (changes && upTo > Number(meta("pruned") || 0)) setMeta.run("pruned", String(upTo));
    return changes;
  }

  // A paged part's rows, as items in its order (each knows its place): those of `post`, or of every post `keep` takes.
  function rows(part, { post, keep } = {}) {
    if (!PARTS[part]?.paged) throw new Error(`${part} isn't paged`);
    const order = `order by ord ${PARTS[part].newestFirst ? "desc" : "asc"}`;
    const found = post !== undefined ? db.prepare(`select id, post, ord, data from ${part} where post = ? ${order}`).all(post) : db.prepare(`select id, post, ord, data from ${part} ${order}`).all().filter((r) => !keep || keep(r.post));
    return found.map((r) => {
      const x = JSON.parse(r.data);
      ords.set(x, r.ord);
      return { id: r.id, x, data: r.data };
    });
  }
  // A thread's history back in memory: its rows in a paged part, as items checkpoints know (written as they read).
  function pageIn(part, post) {
    return rows(part, { post }).map(({ id, x, data }) => {
      written.set(`${part} ${id}`, data);
      return x;
    });
  }
  // Items out of memory, their rows kept: checkpoints forget them rather than delete them. Only right after a
  // checkpoint, when their rows say what they do.
  function pageOut(part, items) {
    const idOf = PARTS[part].idOf || ((x) => x.id);
    for (const x of items) written.delete(`${part} ${idOf(x)}`);
  }
  // Items of a paged part in its order, by their places: one no checkpoint wrote yet is newer than all that were.
  function inOrder(part, items) {
    const at = (x) => ords.get(x) ?? Infinity;
    return items.sort(PARTS[part].newestFirst ? (a, b) => at(b) - at(a) : (a, b) => at(a) - at(b));
  }
  // Which post a paged item's row is on (null: none, or no such row).
  const postOf = (part, id) => (PARTS[part]?.paged ? (db.prepare(`select post from ${part} where id = ?`).get(id)?.post ?? null) : null);

  return { load, since, checkpoint, prune, meta, setMeta: (key, value) => setMeta.run(key, String(value)), rows: (part, keep) => rows(part, { keep }).map((r) => r.x), pageIn, pageOut, inOrder, postOf, log: (op) => logOp.run(op.seq, op.at, JSON.stringify(op)), empty: () => !meta("checkpoint") && !db.prepare("select 1 from events limit 1").get() };
}
