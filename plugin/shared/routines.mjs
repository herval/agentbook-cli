// Routines: what runs on a schedule. One is three choices:
// - when: every N minutes, a cron (daily at 08:00, weekdays…), once at a time, only when you run it, or live: while
//   its page is open (a code routine for a page), every N seconds, with the page's filters as its inputs, its
//   widgets going to the screen rather than a version;
// - what (`kind`): "code", a small JavaScript module agentbook runs with no model, calling the same MCP tools an
//   agent would (ctx.tool) and commands (ctx.sh), but only the ones its reach names; or "agent", a prompt an agent
//   runs in a folder, each run a session started the way the composer starts one;
// - what it's linked to (`links`): any number of agents, pages and threads. Each shows it, and each run is told
//   about them. Where a run goes is its own choice: a new thread each time, or continuing one thread (`thread`), a
//   message to it that resumes it if it ended. A code routine for a page (`page`) writes the widgets it keeps there.
// Its owner OKs each version an agent writes before it runs: a new routine, and every change to its code and
// reach, or its prompt, agent, folder and model. What the owner makes or changes themselves needs no OK.
//
// A routine: { id, kind, owner, page, thread, links: [{ kind: "agent" | "page" | "thread", id }], name, about, cant_keep, schedule, on, keeps: [widget ids], live_v (the
// version that runs: the newest one OK'd), code_v (the newest), ok_at, timeout, agent, by: { agent, post } |
// { user }, created, updated, fails (in a row), failing_since, last: { at, ok, ms, error, version, v, changed,
// lid, post, skipped }, last_ok, memo }.
// Its versions (state.routine_code): { id: "<rid>@<v>", routine, v, at, by, summary, test, ok: { at, by } | null,
// passed: "kept" | "newer" | null }, with code and reach: { tools, commands } for code, and prompt, agent, root
// and model for an agent. One waits for an OK while it's newer than live_v and nothing passed it over. Its runs
// (state.routine_runs), newest last.
//
// The store applies the ops with applyRoutine(). The server schedules them (server/routines.mjs); a code run is a
// CLI's (plugin/cli/routines.mjs): a routine's code never runs on the server. An agent run is a session a machine
// starts, the way the composer starts one.

import { nextCron } from "./cron.mjs";

// What every agent routine's run is told about asking, after which routine it is: on its machine from its signed OK
// (gate.mjs), else by the server (main.mjs routinePrompt). Nobody watches it, so it decides for itself, but before it
// gives up on what only its owner can fix (a sign-in), it asks them and waits a while, rather than writing the run off.
export const unwatched = (owner) =>
  `Nobody is watching it run: make reasonable choices without asking, and say in the thread what you found. Use ab_ask for a decision that's ${owner}'s to make, and before giving up on something only they can fix (a site that's signed out, a passkey or 2FA prompt, an expired token, a missing permission): say exactly what to do, offer to go on once it's done or to skip this run, make skipping the default by a deadline later today (until), and wait for it (wait_seconds: 300). Once it's fixed, go on. If it isn't by then, do what doesn't need it and end your turn with the question still open: the answer starts your next turn. Write the run off as failed, on its pages or in the thread, only once they skip it or the default applies.`;

export const RUNS_KEPT = 200; // per routine
const CODE_MAX = 100 * 1024;
// An agent routine's prompt; a run adds a few lines about the routine before it, and post.start takes 12000.
const PROMPT_MAX = 8000;
export const MEMO_MAX = 64 * 1024;
export const MIN_EVERY_MS = 60e3;
export const LIVE_MIN_MS = 10e3; // a live routine runs at most this often while its page is open
const LIVE_EVERY_MS = 30e3;
export const AGENT_MIN_EVERY_MS = 3600e3; // an agent routine an agent writes runs at most hourly (you can set it more often)
export const TIMEOUT_MS = 60e3;
export const TIMEOUT_MAX_MS = 300e3;

const str = (v, max) => (v == null ? "" : String(v).slice(0, max));
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/* ---------- what a routine is made of ---------- */

// When it runs, from what an agent or the page sends:
// - how often: "30m", "1h", "90 min", "2 hours", "1d", 1800 (seconds), { every: "30m" } -> { kind: "every", everyMs };
// - a cron, in this machine's time: "0 8 * * 1-5", { cron: "0 8 * * 1-5" } -> { kind: "cron", expr };
// - once: { at: "2026-10-12T09:00" } -> { kind: "at", at };
// - only when it's run: "manual" -> { kind: "manual" }.
// The shapes it stores come back as they are.
export function scheduleFrom(x) {
  if (x && typeof x === "object" && x.kind) {
    if (x.kind === "every") return scheduleFrom({ every: x.everyMs / 1000 });
    if (x.kind === "cron") return scheduleFrom({ cron: x.expr });
    if (x.kind === "at") return scheduleFrom({ at: x.at });
    if (x.kind === "manual") return { kind: "manual" };
    if (x.kind === "live") return scheduleFrom({ live: x.everyMs / 1000 });
  }
  const o = x && typeof x === "object" ? x : {};
  if (x === "manual" || o.manual) return { kind: "manual" };
  // Live, while its page is open: "live", "live 30s", { live: "30s" } or { live: 30 } (seconds).
  const live = typeof x === "string" && /^live\b/i.test(x.trim()) ? x.trim().replace(/^live\s*(every\s*)?/i, "") : o.live;
  if (live !== undefined) {
    let ms = LIVE_EVERY_MS;
    if (typeof live === "number" && Number.isFinite(live)) ms = live * 1000;
    else if (live !== true && String(live ?? "").trim()) {
      const m = String(live).trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?)?$/);
      if (!m) throw new Error(`"${live}" isn't how often: give seconds, like "live 30s".`);
      ms = Number(m[1]) * ((m[2] || "s")[0] === "m" ? 60e3 : 1e3);
    }
    if (ms < LIVE_MIN_MS) throw new Error("A live routine runs at most every 10 seconds.");
    return { kind: "live", everyMs: Math.round(ms) };
  }
  const cron = typeof x === "string" && x.trim().split(/\s+/).length === 5 ? x : o.cron;
  if (cron != null) {
    const expr = String(cron).trim().split(/\s+/).join(" ");
    if (!nextCron(expr)) throw new Error(`"${cron}" isn't a cron agentbook can read: five fields, minute hour day month weekday, like "0 8 * * 1-5".`);
    const next = nextCron(expr);
    if (nextCron(expr, Date.parse(next)) && Date.parse(nextCron(expr, Date.parse(next))) - Date.parse(next) < MIN_EVERY_MS) throw new Error("A routine runs at most once a minute.");
    return { kind: "cron", expr };
  }
  if (o.at != null) {
    const t = Date.parse(o.at);
    if (!t) throw new Error(`"${o.at}" isn't a time: give one like "2026-10-12T09:00".`);
    return { kind: "at", at: new Date(t).toISOString() };
  }
  const v = x && typeof x === "object" ? (x.every ?? x.everyMs / 1000) : x;
  let ms = null;
  if (typeof v === "number" && Number.isFinite(v)) ms = v * 1000;
  else {
    const m = String(v ?? "").trim().toLowerCase().match(/^(?:every\s+)?(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)?$/);
    if (m) ms = Number(m[1]) * ({ s: 1e3, m: 60e3, h: 3600e3, d: 864e5 }[(m[2] || "m")[0]] || 60e3);
    else if (/^(hourly|daily)$/i.test(String(v).trim())) ms = /^hourly$/i.test(String(v).trim()) ? 3600e3 : 864e5;
  }
  if (!ms) throw new Error('schedule is when it runs: how often ("30m", "1h"), a cron ("0 8 * * 1-5"), { at: "2026-10-12T09:00" } for once, "manual", or "live 30s" while its page is open.');
  if (ms < MIN_EVERY_MS) throw new Error("A routine runs at most once a minute.");
  return { kind: "every", everyMs: Math.round(ms) };
}
// How often it runs, for routines that run every so often: "every 30 min", "hourly", "every 2 hours", "daily".
export function everyText(s) {
  if (s && s.kind && s.kind !== "every") return scheduleText(s);
  const ms = s?.everyMs || 0;
  if (ms === 3600e3) return "hourly";
  if (ms === 864e5) return "daily";
  if (ms % 864e5 === 0) return `every ${ms / 864e5} days`;
  if (ms % 3600e3 === 0) return `every ${ms / 3600e3} hours`;
  return `every ${Math.round(ms / 60e3)} min`;
}
const DAYS = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"];
const pad2 = (n) => String(n).padStart(2, "0");
// When it runs, in words: "every 30 min", "weekdays at 08:00", "Mondays at 09:30", "once, Oct 12 09:00", "when
// you run it".
export function scheduleText(s) {
  if (!s || s.kind === "every") return everyText(s);
  if (s.kind === "manual") return "when you run it";
  if (s.kind === "live") return `live while its page is open, every ${s.everyMs % 60e3 === 0 ? `${s.everyMs / 60e3} min` : `${Math.round(s.everyMs / 1000)} s`}`;
  if (s.kind === "at") return `once, ${new Date(s.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}`;
  const [min, hour, dom, mon, dow] = String(s.expr || "").split(" ");
  if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === "*" && mon === "*") {
    const at = `at ${pad2(hour)}:${pad2(min)}`;
    if (dow === "*") return `daily ${at}`;
    if (dow === "1-5") return `weekdays ${at}`;
    if (dow === "0,6" || dow === "6,0") return `weekends ${at}`;
    if (/^[0-7]$/.test(dow)) return `${DAYS[Number(dow) % 7]} ${at}`;
  }
  if (/^\d+$/.test(min) && hour === "*" && dom === "*" && mon === "*" && dow === "*") return min === "0" ? "hourly" : `hourly, at :${pad2(min)}`;
  const step = hour?.match(/^\*\/(\d+)$/)?.[1];
  if (/^\d+$/.test(min) && step && dom === "*" && mon === "*" && dow === "*") return `every ${step} hours${min === "0" ? "" : `, at :${pad2(min)}`}`;
  return `on the cron ${s.expr}`;
}
// How many times a day it runs, about: for the OK of an agent routine, which costs a model run each time.
export function runsPerDay(s) {
  if (!s || s.kind === "manual" || s.kind === "at" || s.kind === "live") return 0;
  if (s.kind === "every") return 864e5 / s.everyMs;
  let n = 0;
  for (let t = Date.now(), i = 0; i < 2000; i++) {
    const next = nextCron(s.expr, t);
    if (!next || Date.parse(next) > Date.now() + 7 * 864e5) break;
    n++;
    t = Date.parse(next);
  }
  return n / 7;
}

// A routine's id, from its name, unique among all routines: "Numbers" is "numbers", the next "numbers-2".
export function routineId(name, taken) {
  const base = String(name || "routine").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "routine";
  let id = base;
  for (let i = 2; taken(id); i++) id = `${base}-${i}`;
  return id;
}

// What it may reach: MCP tools as "server/tool", and commands by name.
export function reachFrom(x) {
  const r = x && typeof x === "object" ? x : {};
  const tools = [...new Set((Array.isArray(r.tools) ? r.tools : []).map((t) => str(t, 200).trim()).filter(Boolean))];
  for (const t of tools) if (!/^[^/\s]+\/[^/\s]+$/.test(t)) throw new Error(`reach.tools are "server/tool", like "acme-litellm/acme_eng-dd_span_stats" (not "${t}").`);
  const commands = [...new Set((Array.isArray(r.commands) ? r.commands : []).map((c) => str(c, 80).trim()).filter(Boolean))];
  for (const c of commands) if (!/^[\w.+-]+$/.test(c)) throw new Error(`reach.commands are commands by name, like "gh" (not "${c}").`);
  return { tools: tools.slice(0, 60), commands: commands.slice(0, 20) };
}
const sameReach = (a, b) => JSON.stringify(reachFrom(a)) === JSON.stringify(reachFrom(b));
// What it reaches, in words: "acme-litellm: dd_span_stats, k8s_top · runs gh".
export function reachText(reach) {
  const r = reachFrom(reach);
  const by = {};
  for (const t of r.tools) {
    const [server, tool] = t.split("/");
    (by[server] ||= []).push(tool);
  }
  const parts = Object.entries(by).map(([s, ts]) => `${s}: ${ts.join(", ")}`);
  if (r.commands.length) parts.push(`runs ${r.commands.join(", ")}`);
  return parts.join(" · ") || "nothing outside it";
}
// The tools a version reaches that the one before it didn't.
export const reachAdded = (from, to) => {
  const a = reachFrom(from);
  const b = reachFrom(to);
  return [...b.tools.filter((t) => !a.tools.includes(t)), ...b.commands.filter((c) => !a.commands.includes(c)).map((c) => `the command ${c}`)];
};
// Tool names that sound like they change something, for the OK to point out.
export const soundsLikeWrite = (t) => /(^|[_\-./])(create|update|delete|remove|toggle|set|start|stop|publish|send|post|write|apply|merge|close|comment|save|add|enable|disable)([_\-.]|$)/i.test(t);

// What it's linked to, checked: [{ kind: "agent" | "page" | "thread", id }], each once.
export function linksFrom(x) {
  if (!Array.isArray(x)) throw new Error('links is a list: [{ kind: "page", id: "reliability" }, { kind: "thread", id: "this" }].');
  const out = [];
  for (const l of x) {
    const kind = str(l?.kind, 10);
    const id = str(l?.id, 200).trim();
    if (!["agent", "page", "thread"].includes(kind) || !id) throw new Error(`A link is { kind: "agent" | "page" | "thread", id } (not ${JSON.stringify(l)}).`);
    if (!out.some((o) => o.kind === kind && o.id === id)) out.push({ kind, id });
  }
  return out.slice(0, 20);
}

// What's sent, checked: the settings, and code and reach (or an agent routine's prompt, agent, folder and model)
// when they're given. `page`: the page it's for, when it's for one, so a code routine keeps widgets there. `user`:
// its owner sent it, from agentbook, rather than an agent. Throws with what's wrong.
export function routineInput(b, prev, { page = prev?.page, user = false } = {}) {
  const kind = prev?.kind || (b.kind === "agent" || (b.kind == null && b.prompt != null && b.code == null && b.file == null) ? "agent" : "code");
  if (b.kind != null && prev && b.kind !== prev.kind) throw new Error(`"${prev.name}" is ${prev.kind === "agent" ? "an agent" : "a code"} routine, and stays one. Make a new routine instead.`);
  const out = prev ? {} : { kind };
  if (b.name != null || !prev) {
    out.name = str(b.name, 80).trim();
    if (!out.name) throw new Error(`A routine needs a name, like ${kind === "agent" ? '"Morning digest"' : '"Numbers"'}.`);
  }
  if (b.about != null) out.about = str(b.about, 600);
  if (b.cant_keep != null) out.cant_keep = str(b.cant_keep, 600);
  if (b.links != null) out.links = linksFrom(b.links);
  if (b.schedule != null || !prev) out.schedule = scheduleFrom(b.schedule ?? (kind === "agent" ? "manual" : "30m"));
  if (out.schedule?.kind === "live" && (kind !== "code" || !page)) throw new Error("A live routine is code that keeps widgets on a page: it runs while the page is open, so it needs a page and keeps.");
  if (out.schedule?.kind === "every" && kind === "agent" && !user && out.schedule.everyMs < AGENT_MIN_EVERY_MS) throw new Error("An agent routine runs at most hourly, since each run is a model's. The person can set it to run more often.");
  if (kind === "code" && page && (b.keeps != null || !prev)) {
    if (!Array.isArray(b.keeps) || !b.keeps.length) throw new Error("keeps lists the ids of the widgets it writes: [\"m_p95\", \"c_hourly\"].");
    out.keeps = [...new Set(b.keeps.map((id) => str(id, 60).trim()).filter(Boolean))].slice(0, 60);
  } else if (!prev) out.keeps = [];
  if (b.timeout != null) out.timeout = Math.min(TIMEOUT_MAX_MS, Math.max(5e3, Number(b.timeout) * 1000 || TIMEOUT_MS));
  if (kind === "code") {
    if (b.code != null) {
      out.code = String(b.code);
      if (!out.code.trim()) throw new Error("code is the module's source: export default async function (ctx) { … }.");
      if (out.code.length > CODE_MAX) throw new Error("The code is over 100 KB.");
    } else if (!prev) throw new Error(`A new routine needs its code: export default async function (ctx) { … return { ${page ? "widgets: [...]" : "summary"} } }, or a prompt for an agent (kind: "agent").`);
    if (b.reach != null || !prev) out.reach = reachFrom(b.reach);
    return out;
  }
  // An agent routine's version: what it asks, of whom, where, with which model.
  if (b.prompt != null || !prev) {
    out.prompt = String(b.prompt ?? "").trim();
    if (!out.prompt) throw new Error("An agent routine needs its prompt: what the agent should do each time it runs.");
    if (out.prompt.length > PROMPT_MAX) throw new Error(`The prompt is ${out.prompt.length.toLocaleString("en-US")} characters, over the ${PROMPT_MAX.toLocaleString("en-US")} a routine's prompt can have. Make it shorter.`);
  }
  if (b.agent != null) out.agent = str(b.agent, 120).trim() || null;
  if (b.root != null || b.folder != null) out.root = str(b.root ?? b.folder, 1000).trim() || null;
  if (b.model != null) out.model = str(b.model, 80).trim() || null;
  return out;
}
// What an agent routine's version runs, as text: for diffs, and to tell two versions apart.
export const bodyOf = (c) => (c?.prompt != null ? c.prompt : c?.code || "");
const sameAgentRun = (a, b) => a && b && a.prompt === b.prompt && (a.agent || null) === (b.agent || null) && (a.root || null) === (b.root || null) && (a.model || null) === (b.model || null);

/* ---------- a line diff, for the OK ---------- */

// Lines the same (" "), taken out ("-") and added ("+"), with runs of unchanged lines folded to their edges
// ("…": how many). For two versions of a routine's code.
export function lineDiff(a, b, context = 2) {
  const x = String(a ?? "").split("\n");
  const y = String(b ?? "").split("\n");
  const n = x.length;
  const m = y.length;
  if (n * m > 4e6) return { lines: [{ t: "…", text: "Too long to compare line by line." }], added: m, removed: n };
  const lcs = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const all = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) all.push({ t: " ", text: x[i++], j: j++ });
    else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) all.push({ t: "+", text: y[j++] });
    else all.push({ t: "-", text: x[i++] });
  }
  const near = all.map((l, k) => l.t !== " " || all.slice(Math.max(0, k - context), k + context + 1).some((o) => o.t !== " "));
  const lines = [];
  for (let k = 0; k < all.length; k++) {
    if (near[k]) lines.push({ t: all[k].t, text: all[k].text });
    else if (!near[k - 1] && lines.at(-1)?.t === "…") lines.at(-1).n++;
    else lines.push({ t: "…", n: 1 });
  }
  for (const l of lines) if (l.t === "…") l.text = `${plural(l.n, "line")} the same`;
  return { lines, added: all.filter((l) => l.t === "+").length, removed: all.filter((l) => l.t === "-").length };
}
export const diffText = (d, max = 6000) => d.lines.map((l) => (l.t === "…" ? `  … ${l.text} …` : `${l.t} ${l.text}`)).join("\n").slice(0, max);

/* ---------- applying the ops (the store calls this) ---------- */

const versionsOf = (state, rid) => state.routine_code.filter((c) => c.routine === rid);
export const versionOf = (state, rid, v) => state.routine_code.find((c) => c.routine === rid && c.v === v) || null;
// The version waiting for an OK, if one is.
export const waiting = (state, r) => versionsOf(state, r.id).find((c) => c.v > (r.live_v || 0) && !c.ok && !c.passed) || null;

export function applyRoutine(state, op, now) {
  const r = state.routines[op.rid];
  switch (op.t) {
    case "routine.write": {
      let x = r;
      if (!x) {
        const kind = op.kind === "agent" ? "agent" : "code";
        if (kind === "code" ? !op.code : !op.prompt) break;
        // `owner`: whose it is, on a server many people use (a page's is its page owner's).
        x = state.routines[op.rid] = { id: op.rid, kind, owner: op.owner || null, page: op.page || null, thread: op.thread || null, links: [], name: op.name, about: "", cant_keep: "", schedule: op.schedule, on: true, keeps: op.keeps || [], timeout: TIMEOUT_MS, live_v: 0, code_v: 0, agent: op.by?.agent || null, by: op.by || null, created: now, updated: now, fails: 0, last: null, last_ok: null, memo: {} };
      }
      for (const k of ["name", "about", "cant_keep", "schedule", "keeps", "timeout", "links"]) if (op[k] !== undefined) x[k] = op[k];
      if (op.thread !== undefined && r) x.thread = op.thread || null;
      x.updated = now;
      const newest = versionOf(state, x.id, x.code_v);
      let version = null;
      if (x.kind === "agent") {
        const run = { prompt: op.prompt ?? newest?.prompt, agent: op.agent !== undefined ? op.agent : newest?.agent || null, root: op.root !== undefined ? op.root : newest?.root || null, model: op.model !== undefined ? op.model : newest?.model || null };
        if (run.prompt && (!newest || !sameAgentRun(newest, run))) version = run;
      } else {
        const reach = op.reach !== undefined ? op.reach : newest?.reach || { tools: [], commands: [] };
        if (op.code != null && (!newest || newest.code !== op.code || !sameReach(newest.reach, reach))) version = { code: op.code, reach };
      }
      if (version) {
        // A newer version passes over the one that waited before it.
        for (const c of versionsOf(state, x.id)) if (c.v > (x.live_v || 0) && !c.ok && !c.passed) c.passed = "newer";
        x.code_v = (x.code_v || 0) + 1;
        state.routine_code.push({ id: `${x.id}@${x.code_v}`, routine: x.id, v: x.code_v, at: now, by: op.by || null, ...version, summary: op.summary || "", test: op.test || null, ok: null, passed: null });
      }
      break;
    }
    case "routine.test": {
      const c = r && versionOf(state, r.id, op.v);
      if (c) c.test = op.test;
      break;
    }
    case "routine.ok": {
      // Use this version from now on (`use`), or keep the one that runs and pass this one over.
      const c = r && versionOf(state, r.id, op.v);
      if (!c || c.ok || c.passed) break;
      if (op.use) {
        // `signed`: its owner's passkey's OK of it, which its runs carry to a machine that keeps their keys.
        c.ok = { at: now, by: op.by || null, ...(op.signed ? { signed: op.signed } : {}) };
        for (const o of versionsOf(state, r.id)) if (o.v < c.v && o.v > (r.live_v || 0) && !o.ok && !o.passed) o.passed = "newer";
        r.live_v = c.v;
        r.ok_at = now;
        r.fails = 0;
      } else c.passed = "kept";
      r.updated = now;
      break;
    }
    case "routine.signed": {
      // A version OK'd before its owner's machines kept their passkeys, signed now: its runs carry the signature.
      const c = r && versionOf(state, r.id, op.v);
      if (c?.ok && op.signed) c.ok = { ...c.ok, signed: op.signed };
      break;
    }
    case "routine.on": {
      if (r) Object.assign(r, { on: !!op.on, updated: now });
      break;
    }
    case "routine.fix": {
      // Its owner asked an agent to fix it: the launch that went out (`lid`), the newest only.
      if (r && op.lid) r.fix = { lid: op.lid, agent: op.agent || null, at: now };
      break;
    }
    case "routine.run": {
      if (!r || !op.run) break;
      const run = { ...op.run, id: op.run.id || `${r.id}#${op.seq}`, routine: r.id, page: r.page };
      state.routine_runs.push(run);
      // An agent run: the launch it started (`lid`), or the thread it wrote to (`post`). `skipped`: why it didn't run.
      r.last = { at: run.at, ok: run.ok, ms: run.ms, error: run.error || null, version: run.version || null, v: run.v, changed: run.changed || [], why: run.why, lid: run.lid || null, post: run.post || null, skipped: run.skipped || null };
      r.fails = run.ok ? 0 : (r.fails || 0) + 1;
      r.failing_since = run.ok ? null : r.failing_since || run.at;
      if (run.ok) {
        r.last_ok = run.at;
        if (op.memo !== undefined) r.memo = op.memo;
      }
      const mine = state.routine_runs.filter((x) => x.routine === r.id);
      if (mine.length > RUNS_KEPT) {
        const drop = new Set(mine.slice(0, mine.length - RUNS_KEPT));
        state.routine_runs = state.routine_runs.filter((x) => !drop.has(x));
      }
      break;
    }
    // Removing one archives it, so one removed by accident can be brought back: it stops running and leaves the
    // lists, with its versions, runs and memo kept for a restore.
    case "routine.archive": {
      if (r) Object.assign(r, { archived: { at: now, by: op.by || null }, updated: now });
      break;
    }
    // Back from the archive; or, with `snapshot` ({ routine, code, runs }), one deleted before archiving existed,
    // rebuilt from the log, put back (archived, when `archived` says so).
    case "routine.restore": {
      let x = r;
      if (!x && op.snapshot?.routine) {
        const s = structuredClone(op.snapshot);
        x = state.routines[op.rid] = { ...s.routine, id: op.rid };
        const codes = new Set(state.routine_code.map((c) => c.id));
        const runs = new Set(state.routine_runs.map((c) => c.id));
        state.routine_code.push(...(s.code || []).filter((c) => c.routine === op.rid && !codes.has(c.id)));
        state.routine_runs.push(...(s.runs || []).filter((c) => c.routine === op.rid && !runs.has(c.id)));
      }
      if (!x) break;
      if (op.archived) x.archived = op.archived;
      else delete x.archived;
      x.updated = now;
      break;
    }
    // Deleted for good: what removing did before archiving (old logs replay it).
    case "routine.remove": {
      if (!r) break;
      delete state.routines[r.id];
      state.routine_code = state.routine_code.filter((c) => c.routine !== r.id);
      state.routine_runs = state.routine_runs.filter((x) => x.routine !== r.id);
      break;
    }
  }
}

/* ---------- how they're shown ---------- */

// When it runs next. A code routine runs right away once a newer version is OK'd, to fill its widgets. Otherwise
// it's its schedule's next time after its last run (or after it was OK'd): an agent routine waits for its time.
// One that runs only when it's run, or ran once already, has none.
export function nextAt(r) {
  if (!r.on || !r.live_v || r.archived) return null;
  const s = r.schedule || { kind: "every", everyMs: 1800e3 };
  if (s.kind === "manual" || s.kind === "live") return null;
  if (s.kind === "at") return r.last && Date.parse(r.last.at) >= Date.parse(s.at) ? null : Date.parse(s.at);
  if (r.kind !== "agent" && (!r.last || r.last.v !== r.live_v)) return Date.now();
  const since = Date.parse(r.last?.at || r.ok_at || r.created);
  if (s.kind === "cron") {
    const n = nextCron(s.expr, since);
    return n ? Date.parse(n) : null;
  }
  return since + (s.everyMs || 1800e3);
}
// A page routine's widgets are stale when its last two runs failed, or it hasn't refreshed them in 3 of its
// intervals.
export function staleSince(r) {
  if (!r.live_v || r.kind === "agent" || !r.page || r.schedule?.kind === "live") return null;
  if (r.fails >= 2) return r.last_ok || r.created;
  const every = r.schedule?.kind === "every" ? r.schedule.everyMs : null;
  if (every && r.last_ok && Date.now() - Date.parse(r.last_ok) > 3 * every) return r.last_ok;
  return null;
}
// Everything it's linked to: the agent it runs as, the page it keeps, the thread it continues, and its links.
export function routineLinks(state, r) {
  const run = versionOf(state, r.id, r.live_v) || versionOf(state, r.id, r.code_v);
  const runsAs = r.kind === "agent" ? (r.thread ? state.sessions?.[r.thread]?.agent : null) || run?.agent || r.agent : null;
  const all = [runsAs && { kind: "agent", id: runsAs }, r.page && { kind: "page", id: r.page }, r.thread && { kind: "thread", id: r.thread }, ...(r.links || [])].filter(Boolean);
  const out = [];
  for (const l of all) if (!out.some((o) => o.kind === l.kind && o.id === l.id)) out.push(l);
  const order = { agent: 0, page: 1, thread: 2 };
  return out.sort((a, b) => order[a.kind] - order[b.kind]);
}
export const linkedTo = (state, r, kind, id) => routineLinks(state, r).some((l) => l.kind === kind && l.id === id);
// The thread an agent run became: its launch's, once the session registered.
const runPost = (state, x) => x.post || (x.lid && state.launches?.[x.lid]?.post) || null;

// A routine in brief, for its page in the feed's state and the Routines list: no code, no runs.
export function routineSummary(state, r, running) {
  const w = waiting(state, r);
  const live = versionOf(state, r.id, r.live_v);
  const newest = versionOf(state, r.id, r.code_v);
  const run = live || newest;
  return {
    id: r.id,
    kind: r.kind || "code",
    name: r.name,
    about: r.about,
    on: r.on,
    archived: r.archived || null,
    every: r.schedule,
    when: scheduleText(r.schedule),
    links: routineLinks(state, r),
    page: r.page || null,
    thread: r.thread || null, // where its runs go: this thread, continued; null for a new thread each run
    keeps: r.keeps,
    live_v: r.live_v,
    code_v: r.code_v,
    reach: live?.reach || null,
    // An agent routine's: who runs it, where, and what it's asked (the version that runs, or the one waiting).
    ...(r.kind === "agent" ? { runs_as: run?.agent || r.agent, root: run?.root || null, model: run?.model || null, prompt: run?.prompt || "" } : {}),
    waiting: w ? { v: w.v, at: w.at, summary: w.summary, by: w.by } : null,
    last: r.last ? { ...r.last, post: runPost(state, r.last) } : null,
    last_ok: r.last_ok,
    fails: r.fails,
    failing_since: r.fails ? r.failing_since || r.last?.at || null : null,
    stale: staleSince(r),
    // The agent last asked to fix it, and the thread that became, once it has one.
    fix: r.fix ? { ...r.fix, post: runPost(state, r.fix) } : null,
    next: nextAt(r) ? new Date(nextAt(r)).toISOString() : null,
    running: !!running?.has(r.id),
    agent: r.agent,
    by: r.by,
    created: r.created,
  };
}
// A page's routines and everyone's leave out the archived ones; `archived: true` keeps them in (Routines lists them
// under Archived, to restore).
export const routinesOfPage = (state, pid, running) =>
  Object.values(state.routines)
    .filter((r) => !r.archived && (r.page === pid || linkedTo(state, r, "page", pid)))
    .sort((a, b) => a.created.localeCompare(b.created))
    .map((r) => routineSummary(state, r, running));
export const allRoutines = (state, running, { archived = false } = {}) =>
  Object.values(state.routines)
    .filter((r) => archived || !r.archived)
    .sort((a, b) => a.created.localeCompare(b.created))
    .map((r) => routineSummary(state, r, running));

// What an agent routine's version changes besides its prompt: "runs as codex", "in ~/dev/app", "with opus".
export function runChanges(from, to) {
  if (!from || to.prompt == null) return [];
  const out = [];
  if ((from.agent || null) !== (to.agent || null)) out.push(`runs as ${to.agent || "its writer"}`);
  if ((from.root || null) !== (to.root || null)) out.push(`in ${to.root || "its writer's folder"}`);
  if ((from.model || null) !== (to.model || null)) out.push(`with ${to.model || "the default model"}`);
  return out;
}

// One routine in full: its versions (newest first, with code or prompt, and each one's diff from the version
// before it), what waits for an OK (its diff from what runs, and what it adds to the reach), and its newest runs.
export function routineDetail(state, rid, running, { runs = 50 } = {}) {
  const r = state.routines[rid];
  if (!r) return null;
  const versions = versionsOf(state, rid).sort((a, b) => b.v - a.v);
  const live = versionOf(state, rid, r.live_v);
  const w = waiting(state, r);
  return {
    ...routineSummary(state, r, running),
    cant_keep: r.cant_keep,
    timeout: r.timeout,
    memo_size: JSON.stringify(r.memo || {}).length,
    versions: versions.map((c) => {
      const before = versions.find((o) => o.v < c.v);
      const d = before ? lineDiff(bodyOf(before), bodyOf(c)) : null;
      return { v: c.v, at: c.at, by: c.by, summary: c.summary, code: c.code, reach: c.reach, prompt: c.prompt, agent: c.agent, root: c.root, model: c.model, test: c.test, ok: c.ok ? { at: c.ok.at, by: c.ok.by, signed: !!c.ok.signed } : null, passed: c.passed, live: c.v === r.live_v, diff: d, from: before?.v || null, also: runChanges(before, c) };
    }),
    change: w
      ? r.kind === "agent"
        ? { v: w.v, from: live?.v || null, diff: live ? lineDiff(bodyOf(live), bodyOf(w)) : null, also: runChanges(live, w), added: [], writes: [] }
        : { v: w.v, from: live?.v || null, diff: live ? lineDiff(live.code, w.code) : null, added: live ? reachAdded(live.reach, w.reach) : reachFrom(w.reach).tools, writes: reachFrom(w.reach).tools.filter(soundsLikeWrite) }
      : null,
    runs: state.routine_runs
      .filter((x) => x.routine === rid)
      .slice(-runs)
      .reverse()
      .map((x) => (x.lid ? { ...x, post: runPost(state, x) } : x)),
  };
}

/* ---------- what a run returned, checked ---------- */

// What a run of a routine's code returned on its machine (raw: { ok, ms, error, log, out, memo }, or { error } when
// the machine couldn't run it), checked as a write is: widgets it keeps, a memo that fits, and what they'd change
// on the page (`checkWrite(page, out)`). A run for no page returns a line, something notable, or an ask, and no
// widgets. -> { ok, ms, log, widgets, changes, summary, notable, ask, memo } or { ok: false, ms, error, log }.
export function checkRun(raw, { page, keeps, checkWrite }) {
  const result = raw && typeof raw === "object" ? raw : {};
  const ms = Number(result.ms) || 0;
  if (!result.ok) return { ok: false, ms, error: str(result.error || "It didn't run.", 2000), log: result.log || "" };
  const out = result.out && typeof result.out === "object" ? result.out : {};
  const list = Array.isArray(out.widgets) ? out.widgets : null;
  const fail = (error) => ({ ok: false, ms, error, log: result.log || "" });
  if (!page) {
    if (list?.length) return fail("It returned widgets, but it isn't for a page. It should return { summary, notable?, ask? }.");
    if (JSON.stringify(result.memo || {}).length > MEMO_MAX) return fail("Its memo is over 64 KB.");
    return { ok: true, ms, log: result.log || "", widgets: [], changes: [], summary: str(out.summary, 200), notable: str(out.notable, 200), ask: str(out.ask, 500), memo: result.memo };
  }
  if (!list) return fail('It returned no widgets. It should return { widgets: [{ id, data }], summary? }.');
  const kept = new Set(keeps || []);
  const strays = list.map((w) => String(w?.id ?? "")).filter((id) => !kept.has(id));
  if (strays.length) return fail(`It wrote ${strays.map((s) => `"${s}"`).join(", ")}, which it doesn't keep. It keeps ${[...kept].join(", ")}.`);
  if (JSON.stringify(result.memo || {}).length > MEMO_MAX) return fail("Its memo is over 64 KB.");
  let check;
  try {
    check = checkWrite(page, { widgets: list, summary: out.summary });
  } catch (e) {
    return fail(e.message);
  }
  return { ok: true, ms, log: result.log || "", widgets: check.widgets, changes: check.changes, summary: str(out.summary, 200), notable: str(out.notable, 200), ask: str(out.ask, 500), memo: result.memo };
}
