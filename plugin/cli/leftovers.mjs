// What agentbook-cli's database still kept from before the split, when one process kept everything in it, in
// tables nothing uses now: accounts with their password hashes,
// sign-ins, invites, machines, pins and follows, and the parts of the state that are agentbook-server's now (tasks,
// pages and their versions, routines, workspaces, groups, notes…). Nothing here reads them, and since agentbook-server
// import took them in, the server is their record.
//
// They go once a server has this machine (it acknowledged its changes): before that, `agentbook-server import` may
// still read them from here. The state's parts are written to cli/before-the-split.json first (its person's only),
// in case this machine went to a server without that import; the accounts' rows aren't, and are overwritten as
// they're deleted (secure_delete), with the database's log folded in after, so the password hash isn't left on disk.

import fs from "node:fs";
import path from "node:path";

const ACCOUNT_TABLES = ["auth_sessions", "invites", "device_requests", "devices", "pins", "follows", "users"];
export const SERVER_PARTS = ["tasks", "pages", "page_versions", "routines", "routine_code", "routine_runs", "workspaces", "groups", "group_notes", "group_files", "group_events", "group_posts", "notes", "note_versions", "thread_guests", "thread_seen", "talks", "wip_sets", "page_posts", "agent_follows", "person_follows"];
const DONE = "split_leftovers";

// -> { kept: what of the state's parts went to the file, by part, accounts: rows deleted } once it's done them, or
// null (not yet: no server has this machine; or done before).
export function forgetLeftovers({ store, home, log = () => {} }) {
  const { db, state } = store;
  if (!(store.acked?.() > 0)) return null;
  if (db.prepare("select value from meta where key = ?").get(DONE)) return null;
  const count = (part) => (Array.isArray(state[part]) ? state[part].length : Object.keys(state[part] || {}).length);
  const kept = Object.fromEntries(SERVER_PARTS.filter((p) => count(p)).map((p) => [p, count(p)]));
  if (Object.keys(kept).length) {
    const file = path.join(home, "before-the-split.json");
    const parts = Object.fromEntries(Object.keys(kept).map((p) => [p, state[p]]));
    // Never over one written before (a database restored from a backup, cleaned again).
    const out = fs.existsSync(file) ? path.join(home, `before-the-split-${Date.now()}.json`) : file;
    fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), why: "agentbook-server keeps these since the split; agentbook-cli's database no longer does", parts }, null, 1) + "\n", { mode: 0o600 });
  }
  let accounts = 0;
  db.exec("pragma secure_delete = on");
  try {
    for (const p of SERVER_PARTS) if (state[p]) state[p] = Array.isArray(state[p]) ? [] : {};
    store.checkpoint(true);
    db.exec("begin immediate");
    try {
      for (const t of ACCOUNT_TABLES) accounts += db.prepare(`delete from ${t}`).run().changes;
      db.prepare("insert into meta (key, value) values (?, ?) on conflict (key) do update set value = excluded.value").run(DONE, new Date().toISOString());
      db.exec("commit");
    } catch (e) {
      db.exec("rollback");
      throw e;
    }
  } finally {
    db.exec("pragma secure_delete = off");
  }
  try {
    db.exec("pragma wal_checkpoint(TRUNCATE)");
  } catch {}
  const parts = Object.entries(kept).map(([p, n]) => `${n} ${p}`).join(", ");
  log(`agentbook-cli's database no longer keeps what agentbook-server does: ${accounts} rows of accounts and sign-ins${parts ? `, and ${parts} (written to ${path.join(home, "before-the-split.json")})` : ""}`);
  return { kept, accounts };
}
