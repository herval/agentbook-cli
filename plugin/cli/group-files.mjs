// A group's files on this machine: a folder (<data>/cli/groups/<id>) every agent in the group reads and writes, kept the
// same as the group's files on agentbook-server, which keeps every version of each (server/main.mjs, groups).
//
// The server sends a group's files as they stand (group.sync: each path's latest version, its sha256, or that it
// was deleted), and this machine writes what changed into the folder, fetching each file's bytes by its sha. What
// agents write there with their own tools (Claude Code and Codex, started by agentbook) it notices, by watching the
// folder and looking every 15 s anyway, and sends up as a new version, credited to the post whose transcript wrote
// it (`credit`), or else to this machine. An edit here and a newer version there are told apart by `known`: each
// file as this machine last had it in step with the server ({ v, sha }), kept in <data>/cli/group-files.json. When
// both changed, this machine's edit is the newer version, and the server's stays one before it.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FILE_MAX, cleanPath } from "../shared/groups.mjs";

const SCAN_MS = Number(process.env.AGENTBOOK_GROUP_SCAN_MS || 15000);
const MAX_FILES = 2000; // per group, when scanning
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
// Files an agent takes as its instructions when they're in a folder it works in. group.sync can't be signed: what it
// carries was written by agents and other people, with nobody there to sign. So what a server elsewhere sends doesn't
// get to put one here. (cleanPath already refuses a hidden name, so .claude/ can't arrive this way.)
const STEERS = /(^|\/)(claude(\.local)?|agents(\.override)?|gemini|hermes)\.md$/i;

// `upload(gid, path, { buf, sha } | null, by)`: a version sent up (null: it was deleted) -> { v } or { error }.
// `fetchBlob(sha)`: a version's bytes, from the server. `credit(gid, abs)`: the post (this machine's id) whose
// transcript wrote that file lately, or null.
export function createGroupFiles({ home, upload, fetchBlob, credit = async () => null, log = () => {}, hosted = () => false }) {
  const root = path.join(home, "cli", "groups");
  const knownFile = path.join(home, "cli", "group-files.json");
  let known = {}; // gid -> { path -> { v, sha } }
  try {
    known = JSON.parse(fs.readFileSync(knownFile, "utf8")) || {};
  } catch {}
  const saveKnown = () => {
    try {
      fs.mkdirSync(path.dirname(knownFile), { recursive: true });
      fs.writeFileSync(knownFile, JSON.stringify(known));
    } catch (e) {
      log(`group files: couldn't keep what's in step: ${e.message}`);
    }
  };
  const groups = new Map(); // gid -> { archived }: the groups this machine keeps a folder for
  const seen = new Map(); // abs path -> { mtimeMs, size, sha }: what the last look read, so it reads only what changed
  const watchers = new Map();
  const queues = new Map(); // gid -> the work on it, one thing at a time

  const dirOf = (gid) => path.join(root, gid);
  // One thing at a time per group: a sync, a scan, a write.
  function serial(gid, fn) {
    const next = (queues.get(gid) || Promise.resolve()).then(fn);
    queues.set(gid, next.catch(() => {}));
    return next;
  }
  // A file's sha256 as it is now, or null when it isn't there.
  function shaNow(abs) {
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      return null;
    }
    if (!st.isFile()) return null;
    const was = seen.get(abs);
    if (was && was.mtimeMs === st.mtimeMs && was.size === st.size) return was.sha;
    if (st.size > FILE_MAX) return `big:${st.size}:${st.mtimeMs}`;
    const hash = sha256(fs.readFileSync(abs));
    seen.set(abs, { mtimeMs: st.mtimeMs, size: st.size, sha: hash });
    return hash;
  }
  function put(abs, buf) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.${process.pid}.part`;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, abs);
    const st = fs.statSync(abs);
    seen.set(abs, { mtimeMs: st.mtimeMs, size: st.size, sha: sha256(buf) });
  }

  // The server's files for a group, as they stand: [{ path, v, sha, deleted }]. What's newer than this machine had
  // is written (or deleted), unless it was changed here since: then this machine's goes up as the newer version.
  function sync(gid, files = [], { archived = false } = {}) {
    groups.set(gid, { archived: !!archived });
    return serial(gid, async () => {
      const dir = dirOf(gid);
      fs.mkdirSync(dir, { recursive: true });
      const k = (known[gid] ||= {});
      for (const f of files) {
        const p = cleanPath(f.path);
        if (!p || !Number.isInteger(f.v)) continue;
        const had = k[p];
        if (had && had.v >= f.v) continue; // it has that version already, or a newer one
        const want = f.deleted ? null : f.sha;
        if (want != null && hosted() && STEERS.test(p)) {
          log(`group ${gid}: left out ${p}: a file that steers agents doesn't come from a server elsewhere`);
          continue;
        }
        const abs = path.join(dir, p);
        const now = shaNow(abs);
        if (now === want) {
          k[p] = { v: f.v, sha: want };
          continue;
        }
        // Changed here since it was last in step: this machine's is newer (the next look sends it up).
        if (now !== (had?.sha ?? null)) continue;
        try {
          if (want == null) {
            fs.rmSync(abs, { force: true });
            seen.delete(abs);
          } else {
            // Written only as the bytes its sha256 says: a server (or whatever's between) can't send others under it.
            const buf = await fetchBlob(want);
            if (!buf || sha256(buf) !== want) {
              log(`group ${gid}: ${p} came with other bytes than its sha256 says, so it's left as it was`);
              continue;
            }
            put(abs, buf);
          }
          k[p] = { v: f.v, sha: want };
        } catch (e) {
          log(`group ${gid}: couldn't get ${p}: ${e.message}`);
        }
      }
      saveKnown();
      if (!archived) watch(gid);
    }).then(() => {
      // What changed here meanwhile goes up after (not before the server hears this sync went through).
      if (!archived) setImmediate(() => scan(gid));
    });
  }

  // Every file in the folder, relative to it: none hidden, nothing in hidden folders or node_modules.
  function walk(dir) {
    const out = [];
    const go = (rel) => {
      if (out.length >= MAX_FILES) return;
      let entries = [];
      try {
        entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith(".") || e.name === "node_modules" || e.name.endsWith(".part")) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) go(r);
        else if (e.isFile()) out.push(r);
      }
    };
    go("");
    return out;
  }

  // Look through a group's folder for what changed since it was last in step with the server, and send it up.
  function scan(gid) {
    if (!groups.has(gid) || groups.get(gid).archived) return Promise.resolve();
    return serial(gid, async () => {
      const dir = dirOf(gid);
      if (!fs.existsSync(dir)) return;
      const k = (known[gid] ||= {});
      const here = new Set(walk(dir));
      let changed = false;
      for (const p of here) {
        if (!cleanPath(p)) continue;
        const abs = path.join(dir, p);
        const now = shaNow(abs);
        if (!now || now.startsWith("big:") || now === k[p]?.sha) continue;
        let buf;
        try {
          buf = fs.readFileSync(abs);
        } catch {
          continue;
        }
        if (sha256(buf) !== now) continue; // changing as it's read: the next look gets it
        const post = await credit(gid, abs).catch(() => null);
        const r = await upload(gid, p, { buf, sha: now }, post);
        if (r?.error) {
          log(`group ${gid}: couldn't send ${p} up: ${r.error}`);
          continue;
        }
        k[p] = { v: r.v, sha: now };
        changed = true;
      }
      // Files it had in step that the folder doesn't have now: deleted here.
      for (const [p, had] of Object.entries(k)) {
        if (!had.sha || here.has(p)) continue;
        const abs = path.join(dir, p);
        seen.delete(abs);
        const r = await upload(gid, p, null, await credit(gid, abs).catch(() => null));
        if (r?.error) continue;
        k[p] = { v: r.v, sha: null };
        changed = true;
      }
      if (changed) saveKnown();
    }).catch((e) => log(`group ${gid} files: ${e.message}`));
  }

  // Watch a group's folder, so what agents write goes up within a second or two.
  function watch(gid) {
    if (watchers.has(gid)) return;
    const dir = dirOf(gid);
    fs.mkdirSync(dir, { recursive: true });
    let timer = null;
    try {
      const w = fs.watch(dir, { recursive: true }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => scan(gid), 400);
      });
      w.on("error", () => {});
      watchers.set(gid, w);
    } catch (e) {
      watchers.set(gid, null);
      log(`group ${gid}: can't watch its folder (${e.message}); looking every ${SCAN_MS / 1000}s`);
    }
  }

  let timer = null;
  function start() {
    timer ||= setInterval(() => {
      for (const gid of groups.keys()) scan(gid);
    }, SCAN_MS);
    timer.unref?.();
  }
  function stop() {
    clearInterval(timer);
    for (const w of watchers.values()) w?.close();
    watchers.clear();
  }

  // An agent's write through ab_group_write: sent up as a version by its post, then put in the folder. -> the
  // version ({ path, v }).
  function write(gid, p, buf, post) {
    const rel = cleanPath(p);
    if (!rel) throw Object.assign(new Error("That isn't a path inside the group's folder."), { status: 400 });
    if (buf.length > FILE_MAX) throw Object.assign(new Error("A group's file can be up to 10 MB."), { status: 400 });
    return serial(gid, async () => {
      const hash = sha256(buf);
      const r = await upload(gid, rel, { buf, sha: hash }, post);
      if (r?.error) throw Object.assign(new Error(r.error), { status: r.status || 502 });
      put(path.join(dirOf(gid), rel), buf);
      (known[gid] ||= {})[rel] = { v: r.v, sha: hash };
      saveKnown();
      return { path: rel, v: r.v, url: r.url || null };
    });
  }

  return { dirOf, sync, scan, watch, start, stop, write, groups };
}
