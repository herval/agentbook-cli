// Codex's routines: the automations the ChatGPT app's Codex runs on a schedule, read from where the app keeps
// them on this machine. Nothing here changes them: there's no way in from outside the app, so a routine's page
// opens it in the app (codex://automations/<id>) for Run now and Pause.
//
// - An automation is ~/.codex/automations/<id>/automation.toml (the app's source of truth for one kept on this
//   machine), and a row in the app's database (~/.codex/sqlite/codex.db, or codex-dev.db), which also holds the
//   ones kept in ChatGPT's cloud, and when each runs next. Times there are in milliseconds.
// - A "cron" automation runs its prompt in a thread of its own each time (`automation_runs`: the thread, how it
//   went, what it reported for the app's inbox). A "heartbeat" sends its prompt into one thread again and again:
//   Codex's /loop. Its runs are that thread's turns.
// - When it runs is an RFC 5545 rule (FREQ=HOURLY;INTERVAL=24;BYMINUTE=0), in this machine's time.
// - The app runs them only while it's open.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "../../shared/db.mjs";

// Codex's folder. Tests and demos that run a stand-in for Codex's daemon (AGENTBOOK_CODEX_SOCK) never read the
// real one: they name theirs, or have none.
const HOME = () => process.env.AGENTBOOK_CODEX_HOME || (process.env.AGENTBOOK_CODEX_SOCK ? null : path.join(os.homedir(), ".codex"));
const iso = (ms) => (Number(ms) > 0 ? new Date(Number(ms)).toISOString() : null);

/* ---------- TOML, as much as automation.toml needs ---------- */

// Keys and values: strings (basic, literal, multi-line), numbers, booleans, dates (kept as text), arrays, inline
// tables, and [table] headers, whose keys come back as "table.key".
export function parseToml(text) {
  const out = {};
  let i = 0;
  let prefix = "";
  const s = String(text);
  const ws = () => {
    for (;;) {
      while (i < s.length && /[ \t\r\n]/.test(s[i])) i++;
      if (s[i] !== "#") return;
      while (i < s.length && s[i] !== "\n") i++;
    }
  };
  const inline = () => {
    while (s[i] === " " || s[i] === "\t") i++;
  };
  const key = () => {
    const parts = [];
    for (;;) {
      inline();
      if (s[i] === '"' || s[i] === "'") parts.push(str());
      else {
        const m = s.slice(i).match(/^[A-Za-z0-9_-]+/);
        if (!m) throw new Error(`bad key at ${i}`);
        parts.push(m[0]);
        i += m[0].length;
      }
      inline();
      if (s[i] !== ".") return parts.join(".");
      i++;
    }
  };
  const ESC = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\" };
  function str() {
    const q = s[i];
    const multi = s.startsWith(q.repeat(3), i);
    i += multi ? 3 : 1;
    if (multi && s[i] === "\n") i++;
    else if (multi && s.startsWith("\r\n", i)) i += 2;
    let v = "";
    for (;;) {
      if (i >= s.length) throw new Error("unterminated string");
      if (multi ? s.startsWith(q.repeat(3), i) && s[i + 3] !== q : s[i] === q) {
        i += multi ? 3 : 1;
        return v;
      }
      const c = s[i++];
      if (c === "\\" && q === '"') {
        const e = s[i++];
        if (e === "u" || e === "U") {
          const n = e === "u" ? 4 : 8;
          v += String.fromCodePoint(parseInt(s.slice(i, i + n), 16));
          i += n;
        } else if (multi && /[ \t\r\n]/.test(e)) {
          while (i < s.length && /[ \t\r\n]/.test(s[i])) i++; // a line-ending backslash joins the lines
        } else v += ESC[e] ?? e;
      } else v += c;
    }
  }
  function value() {
    inline();
    const c = s[i];
    if (c === '"' || c === "'") return str();
    if (c === "[") {
      i++;
      const arr = [];
      for (;;) {
        ws();
        if (s[i] === "]") return i++, arr;
        arr.push(value());
        ws();
        if (s[i] === ",") i++;
      }
    }
    if (c === "{") {
      i++;
      const obj = {};
      for (;;) {
        inline();
        if (s[i] === "}") return i++, obj;
        const k = key();
        if (s[i++] !== "=") throw new Error(`expected = at ${i}`);
        obj[k] = value();
        inline();
        if (s[i] === ",") i++;
      }
    }
    const m = s.slice(i).match(/^[^\s,\]}#]+/);
    if (!m) throw new Error(`bad value at ${i}`);
    i += m[0].length;
    const raw = m[0];
    if (raw === "true" || raw === "false") return raw === "true";
    const n = raw.replace(/_/g, "");
    return /^[+-]?(\d+(\.\d+)?([eE][+-]?\d+)?|0x[0-9a-f]+|inf|nan)$/i.test(n) ? Number(n) : raw;
  }
  for (;;) {
    ws();
    if (i >= s.length) return out;
    if (s[i] === "[") {
      const arrayTable = s[i + 1] === "[";
      i += arrayTable ? 2 : 1;
      prefix = key();
      i += arrayTable ? 2 : 1;
      continue;
    }
    const k = key();
    if (s[i++] !== "=") throw new Error(`expected = at ${i}`);
    out[prefix ? `${prefix}.${k}` : k] = value();
  }
}

/* ---------- the app's automations ---------- */

export function createCodexAutomations({ log = () => {} } = {}) {
  let cache = null; // { key, list }
  let warned = null;

  // The app's database: codex.db, or codex-dev.db, whichever it wrote last.
  function dbFile() {
    if (!HOME()) return null;
    const dir = path.join(HOME(), "sqlite");
    const files = ["codex.db", "codex-dev.db"].map((n) => path.join(dir, n)).filter((f) => fs.existsSync(f));
    return files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || null;
  }
  function query(sql, ...params) {
    const file = dbFile();
    if (!file) return [];
    let db;
    try {
      db = new DatabaseSync(file, { readOnly: true });
      return db.prepare(sql).all(...params);
    } catch (e) {
      if (warned !== e.message && !/no such table/.test(e.message)) log(`codex automations: ${(warned = e.message)}`);
      return [];
    } finally {
      try {
        db?.close();
      } catch {}
    }
  }
  const tomls = () => {
    if (!HOME()) return [];
    const dir = path.join(HOME(), "automations");
    try {
      return fs.readdirSync(dir).map((id) => path.join(dir, id, "automation.toml")).filter((f) => fs.existsSync(f));
    } catch {
      return [];
    }
  };
  const stamp = (f) => {
    try {
      const st = fs.statSync(f);
      return `${f}:${st.mtimeMs}:${st.size}`;
    } catch {
      return "";
    }
  };

  // Every automation: its file where it has one, the database for the rest and for when it runs next.
  function list() {
    const files = tomls();
    const db = dbFile();
    const key = [db, db && stamp(db), db && stamp(`${db}-wal`), ...files.map(stamp)].join("|");
    if (cache?.key === key) return cache.list;
    const rows = Object.fromEntries(query("SELECT * FROM automations WHERE status != 'DELETED'").map((r) => [r.id, r]));
    const byId = {};
    for (const f of files) {
      try {
        const t = parseToml(fs.readFileSync(f, "utf8"));
        const id = t.id || path.basename(path.dirname(f));
        byId[id] = { ...rows[id], ...t, id, local: true, next_run_at: rows[id]?.next_run_at ?? null, last_run_at: rows[id]?.last_run_at ?? t.last_run_at ?? null };
      } catch (e) {
        log(`codex automations: couldn't read ${f}: ${e.message}`);
      }
    }
    for (const [id, r] of Object.entries(rows)) byId[id] ||= { ...r, local: false };
    const out = Object.values(byId).filter((a) => String(a.status || "ACTIVE").toUpperCase() !== "DELETED");
    cache = { key, list: out };
    return out;
  }
  const cwdsOf = (a) => {
    if (Array.isArray(a.cwds)) return a.cwds;
    try {
      return JSON.parse(a.cwds || "[]");
    } catch {
      return [];
    }
  };
  const ms = (v) => (typeof v === "number" ? (v < 1e12 ? v * 1000 : v) : Date.parse(v) || null);

  // An automation as a routine (the shape OpenClaw's have). `thread`: a heartbeat's thread.
  function routineOf(a, latest) {
    const enabled = String(a.status || "ACTIVE").toUpperCase() === "ACTIVE";
    const heartbeat = a.kind === "heartbeat";
    return {
      id: a.id,
      agent: "codex",
      group: heartbeat ? "loop" : "codex",
      name: a.name || "Automation",
      description: "",
      enabled,
      kind: "agentTurn",
      what: String(a.prompt || ""),
      model: a.model || null,
      effort: a.reasoning_effort || null,
      schedule: a.rrule ? { kind: "rrule", rule: String(a.rrule) } : null,
      next: enabled ? iso(ms(a.next_run_at)) : null,
      running: latest?.status === "IN_PROGRESS" ? iso(latest.created_at) : null,
      last: iso(ms(a.last_run_at)) || iso(latest?.created_at),
      status: latest && latest.status !== "IN_PROGRESS" ? "ok" : null, // Codex says a run finished, not how it went
      error: null,
      took: null,
      failing: 0,
      created: iso(ms(a.created_at)),
      thread: heartbeat ? a.target_thread_id || null : null,
      place: { cwds: cwdsOf(a), worktree: a.execution_environment === "worktree", cloud: !a.local },
      url: `codex://automations/${encodeURIComponent(a.id)}?automationSource=${a.local ? "local" : "cloud"}`,
      acts: [],
    };
  }
  const STATUS = { IN_PROGRESS: "running", PENDING_REVIEW: "ok", ACCEPTED: "ok", ARCHIVED: "ok" };
  const runOf = (r) => ({
    id: r.thread_id,
    job: r.automation_id,
    at: iso(r.created_at),
    took: r.status !== "IN_PROGRESS" && r.updated_at > r.created_at ? r.updated_at - r.created_at : null,
    status: STATUS[r.status] || null,
    error: null,
    summary: r.inbox_summary || r.inbox_title || null,
    session: String(r.thread_id).startsWith("pending:") ? null : r.thread_id,
    post: null,
    unread: r.status === "PENDING_REVIEW" && !r.read_at,
  });
  const latestRuns = () => Object.fromEntries(query("SELECT automation_id, status, created_at FROM automation_runs r WHERE created_at = (SELECT MAX(created_at) FROM automation_runs WHERE automation_id = r.automation_id)").map((r) => [r.automation_id, r]));

  // Asked for every time the page's state is sent, so kept for a few seconds.
  let shown = null;
  function routines() {
    if (shown && Date.now() - shown.at < 3000) return shown.list;
    const all = list();
    const latest = all.length ? latestRuns() : {};
    shown = { at: Date.now(), list: all.map((a) => routineOf(a, latest[a.id])) };
    return shown.list;
  }
  function one(id) {
    const a = list().find((x) => x.id === id);
    if (!a) return null;
    return routineOf(a, latestRuns()[a.id]);
  }
  function runs(id, { offset = 0, limit = 50 } = {}) {
    const rows = query("SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?", id, limit + 1, offset);
    const total = query("SELECT COUNT(*) AS n FROM automation_runs WHERE automation_id = ?", id)[0]?.n ?? null;
    return { runs: rows.slice(0, limit).map(runOf), total, more: rows.length > limit };
  }
  const isRun = (id, thread) => query("SELECT 1 AS ok FROM automation_runs WHERE automation_id = ? AND thread_id = ?", id, thread).length > 0;

  return { routines, one, runs, isRun };
}
