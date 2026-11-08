// Claude's routines: what it does on a schedule, on its profile under Routines.
//
// - Routines on claude.ai: Claude Code's cloud routines (`/schedule`) and the scheduled tasks the Claude app
//   runs (Cowork), which claude.ai keeps together. agentbook reads them from the API `/schedule` uses
//   (api.anthropic.com/v1/code/triggers), signed in as Claude Code is on this machine: its claude.ai sign-in,
//   from the macOS keychain ("Claude Code-credentials") or ~/.claude/.credentials.json. agentbook never renews
//   that sign-in: Claude Code does, whenever it runs, and until then the routines say it expired. Each run is a
//   session on claude.ai: how it went and what it said are read from its events. Run now, Pause and Resume act
//   on the routine there.
// - Its usage limits (limits.mjs): how much of its plan's 5-hour and weekly limits Claude Code has used, what
//   `/usage` shows, from api.anthropic.com/api/oauth/usage with the same sign-in, when its profile asks.
// - Loops (`/loop`): what a session set itself to do again, read from its transcript (transcript.mjs). They live
//   in their post and stop with its session, so only a live post's are listed. Run now writes the loop's prompt
//   to the post, and Stop asks the session to stop it, both as messages from you.
//
// The real sign-in is used only by the agentbook that runs with the default data folder and Claude Code
// folder, so tests and demos never reach claude.ai, and only on a machine whose agentbook-server is this machine
// (`agentbook up`): one logged in to a server elsewhere leaves Claude Code's sign-in alone, since Anthropic's terms
// don't let software collect or pass on claude.ai credentials, and the account at stake is its person's.
// AGENTBOOK_CLAUDE_ROUTINES=1 turns it on anyway, =0 off; AGENTBOOK_CLAUDE_TOKEN (with AGENTBOOK_CLAUDE_API) signs
// in with a token of your own.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describeTool, loopName } from "../transcript.mjs";
import { failedRoutines, nextCron } from "../../shared/cron.mjs";
import { claudeLimitsOf, claudePlanOf, limitsReader } from "../limits.mjs";

const API = () => (process.env.AGENTBOOK_CLAUDE_API || "https://api.anthropic.com").replace(/\/$/, "");
const BETA = "ccr-triggers-2026-01-30";
const USAGE_BETA = "oauth-2025-04-20"; // what Claude Code's /usage asks with
const LIST_MS = Number(process.env.AGENTBOOK_CLAUDE_ROUTINES_MS || 180e3); // how often its routines are listed
const configDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const WEEK = 7 * 86400e3; // a recurring loop's life
const PACED_GRACE = 25 * 60e3; // a self-paced loop that didn't say when it looks again gets one more look, ~20m on

const short = (s, n = 160) => {
  s = String(s ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};
const iso = (v) => (v && Date.parse(v) > 0 ? new Date(v).toISOString() : null);
const refused = (status, message) => Object.assign(new Error(message), { status });
const textOf = (content) => (typeof content === "string" ? content : Array.isArray(content) ? content.filter((c) => c?.type === "text").map((c) => c.text).join("\n") : "");

// Whether agentbook may use Claude Code's sign-in, and how: "claude" (Claude Code's own, read from this machine),
// "token" (AGENTBOOK_CLAUDE_TOKEN), or null. `hosted`: whether this machine reports to an agentbook-server that isn't
// on this machine; then Claude Code's sign-in is read only when AGENTBOOK_CLAUDE_ROUTINES=1 says so.
export function claudeSignInSource({ env = process.env, hosted = false } = {}) {
  if (env.AGENTBOOK_CLAUDE_ROUTINES === "0") return null;
  if (env.AGENTBOOK_CLAUDE_TOKEN) return "token";
  if (env.AGENTBOOK_CLAUDE_ROUTINES === "1") return "claude";
  if (hosted) return null;
  if (!env.AGENTBOOK_HOME && !env.CLAUDE_CONFIG_DIR) return "claude";
  return null;
}

/* ---------- when a cron runs next ---------- */

// The cron reader is shared with agentbook's routines (shared/cron.mjs).
export { nextCron };

// host: { state, commit, changed, log, hosted }: `hosted()` says whether this machine's agentbook-server is elsewhere.
export function createClaudeRoutines(host) {
  const log = host.log || (() => {});
  const signInSource = () => claudeSignInSource({ hosted: !!host.hosted?.() });
  let saidOff = false;
  let routinesList = null; // its routines on claude.ai (see routineOf), null until listed or when it can't be
  let listedAt = 0;
  let listError = null;
  let listing = null;
  let auth = null; // { token, org, at }
  const results = new Map(); // run session id -> { status, summary, took }: a finished run's outcome, read once
  const cursors = new Map(); // routine -> { offset: next_cursor }, for older runs

  /* ---------- claude.ai ---------- */

  const run = (bin, args) =>
    new Promise((resolve, reject) => execFile(bin, args, { timeout: 10000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))));

  // Claude Code's claude.ai sign-in, read again every minute (Claude Code renews it as it runs).
  async function signIn() {
    if (auth && Date.now() - auth.at < 60e3) return auth;
    const source = signInSource();
    if (!source) return null;
    let org = process.env.CLAUDE_CODE_ORGANIZATION_UUID || null;
    if (!org) {
      try {
        org = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), ".claude.json"), "utf8")).oauthAccount?.organizationUuid || null;
      } catch {}
    }
    if (source === "token") return (auth = { token: process.env.AGENTBOOK_CLAUDE_TOKEN, org, at: Date.now() });
    let creds = null;
    try {
      creds = JSON.parse(fs.readFileSync(path.join(configDir(), ".credentials.json"), "utf8"));
    } catch {}
    if (!creds && process.platform === "darwin") {
      try {
        creds = JSON.parse(await run("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"]));
      } catch {}
    }
    const o = creds?.claudeAiOauth;
    if (!o?.accessToken) throw refused(401, "Claude Code isn't signed in to claude.ai on this machine.");
    if (o.expiresAt && o.expiresAt < Date.now() + 30e3) throw refused(401, "Claude Code's claude.ai sign-in has expired. It renews it the next time it runs.");
    // What it may do (routines need user:sessions:claude_code, its usage user:profile), and its plan ("Max 20x").
    return (auth = { token: o.accessToken, org, at: Date.now(), scopes: Array.isArray(o.scopes) ? o.scopes : null, plan: claudePlanOf(o) });
  }
  const may = (a, scope, what) => {
    if (a.scopes && !a.scopes.includes(scope)) throw refused(401, `Claude Code's sign-in here can't see ${what}: sign in again with /login.`);
  };

  async function api(method, p, body) {
    const a = await signIn();
    if (!a) throw refused(404, "agentbook doesn't read routines here.");
    may(a, "user:sessions:claude_code", "routines");
    const res = await fetch(`${API()}${p}`, {
      method,
      headers: { authorization: `Bearer ${a.token}`, "content-type": "application/json", "anthropic-version": "2023-06-01", "anthropic-beta": BETA, ...(a.org ? { "x-organization-uuid": a.org } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {}
    if (!res.ok) {
      if (res.status === 401) auth = null;
      throw refused(res.status === 404 ? 404 : 502, `claude.ai said ${res.status}${data?.error?.message ? `: ${short(data.error.message, 200)}` : ""}`);
    }
    return data;
  }

  // "CRON_TZ=America/Fortaleza 0 2 * * *": a time zone of its own. Without one, the times are UTC.
  function scheduleOf(t) {
    if (t.run_once_at) return { kind: "at", at: iso(t.run_once_at) };
    const m = String(t.cron_expression || "").match(/^(?:CRON_TZ=(\S+)\s+)?(.+)$/);
    return m && m[2] ? { kind: "cron", expr: m[2].trim(), tz: m[1] || "UTC" } : null;
  }
  // How a run went, in OpenClaw's words: ok, error, running.
  const statusOf = (s) => (/SUCCEEDED|SUCCESS|COMPLETED/.test(s) ? "ok" : /FAIL|ERROR|CANCEL|TIMEOUT/.test(s) ? "error" : /RUNNING|PENDING|PROGRESS|START|QUEUED/.test(s) ? "running" : null);
  const reasonOf = (r) => (r && !/UNSPECIFIED/.test(r) ? r.replace(/^ROUTINE_RUN_FAILURE_REASON_/, "").replace(/_/g, " ").toLowerCase() : null);
  // What it's told to do: the prompt it was saved with.
  function promptOf(t) {
    if (t.derived_state?.prompt) return t.derived_state.prompt;
    const ev = t.job_config?.ccr?.events?.[0]?.data || t.session_request?.events?.[0]?.payload;
    return textOf(ev?.message?.content) || "";
  }
  function routineOf(t) {
    const last = t.last_run || null;
    const status = last ? statusOf(last.status) : null;
    const ctx = t.job_config?.ccr?.session_context || {};
    const repos = (ctx.sources || []).map((s) => s.git_repository?.url).filter(Boolean).map((u) => String(u).replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, ""));
    const tags = t.session_request?.tags || t.job_config?.ccr?.tags || [];
    const suspended = t.suspension_reason || t.ended_reason || null;
    return {
      id: t.id,
      agent: "claude",
      group: "cloud",
      name: t.name || "Routine",
      description: "",
      enabled: t.enabled !== false,
      kind: "agentTurn",
      what: String(promptOf(t)),
      model: t.derived_state?.model || ctx.model || null,
      schedule: scheduleOf(t),
      next: t.enabled !== false ? iso(t.next_run_at) : null,
      running: status === "running" ? iso(last.fired_at) : null,
      last: iso(last?.fired_at || t.last_fired_at),
      status: status === "running" ? null : status,
      error: status === "error" ? reasonOf(last.failure_reason) || "It failed" : suspended ? short(String(suspended).replace(/_/g, " ").toLowerCase()) : null,
      took: last?.finished_at && last?.fired_at ? Date.parse(last.finished_at) - Date.parse(last.fired_at) : null,
      failing: status === "error" ? 1 : 0,
      created: iso(t.created_at),
      // Where it runs: Claude Code on the web, in its repos, or the Claude app (Cowork), on the computer it's bound to.
      place: { cowork: tags.some((x) => String(x).startsWith("cowork")), device: t.bound_device?.display_name || null, repos, folders: t.derived_state?.folders || [] },
      url: `https://claude.ai/code/routines/${t.id}`,
      acts: ["run", "pause"],
    };
  }

  async function loadRoutines() {
    listing ||= (async () => {
      listedAt = Date.now();
      try {
        const list = [];
        for (let cursor = null, i = 0; i < 10; i++) {
          const r = await api("GET", `/v1/code/triggers${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
          list.push(...(r?.data || []));
          cursor = r?.next_cursor || null;
          if (!r?.has_more || !cursor) break;
        }
        listError = null;
        const next = list.map(routineOf);
        if (JSON.stringify(next) === JSON.stringify(routinesList)) return;
        routinesList = next;
      } catch (e) {
        if (listError !== e.message) log(`claude routines: ${(listError = e.message)}`);
        if (e.status === 404 && !signInSource()) return;
      }
      host.changed();
    })().finally(() => (listing = null));
    return listing;
  }
  const fresh = () => (Date.now() - listedAt > 15e3 ? loadRoutines() : null);

  // A run is a session on claude.ai. Its outcome is its last event ("result"), read once it's finished.
  const sessionUrl = (id) => `https://claude.ai/code/${String(id).replace(/^cse_/, "session_")}`;
  async function outcome(s) {
    if (results.has(s.id)) return results.get(s.id);
    const r = await api("GET", `/v1/code/sessions/${encodeURIComponent(s.id)}/events?limit=8&sort_order=desc`).catch(() => null);
    const done = (r?.data || []).map((e) => e.payload).find((p) => p?.type === "result");
    if (!done) return null;
    const out = { status: done.is_error || done.subtype !== "success" ? "error" : "ok", summary: short(done.result, 400) || null, took: Number(done.duration_ms) || null };
    results.set(s.id, out);
    return out;
  }
  function runOf(s, job) {
    const busy = s.worker_status === "running" || s.worker_status === "busy";
    const o = results.get(s.id);
    return {
      id: s.id,
      job,
      at: iso(s.created_at),
      took: o?.took ?? (!busy && s.last_event_at ? Date.parse(s.last_event_at) - Date.parse(s.created_at) : null),
      status: busy ? "running" : o?.status || null,
      error: o?.status === "error" ? o.summary : null,
      summary: o?.status === "error" ? null : o?.summary || null,
      session: s.id,
      post: null,
      url: sessionUrl(s.id),
      manual: !!s.config?.origin && s.config.origin !== "scheduled_trigger",
      model: s.config?.model || null,
    };
  }

  /* ---------- loops ---------- */

  const isClaude = (s) => host.state.agents[s.agent]?.kind === "claude-code" && !s.cloud;
  // A loop as it stands: live while its post is awake and it's neither stopped, expired nor spent.
  function loopOf(s, l) {
    const now = Date.now();
    const lastRun = l.runs?.at(-1)?.at || null;
    const expires = l.kind === "cron" && l.recurring ? new Date(Date.parse(l.at) + WEEK).toISOString() : null;
    const awake = s.state !== "done" && !s.asleep;
    const pending = l.kind === "paced" ? !!l.next || (lastRun && now - Date.parse(lastRun) < PACED_GRACE) : l.recurring ? !expires || Date.parse(expires) > now : !lastRun;
    const live = awake && !l.ended && !!pending;
    const next = !live ? null : l.kind === "paced" ? l.next : nextCron(l.cron, now);
    return {
      id: `loop-${s.id}-${l.id}`,
      loop: l.id,
      agent: s.agent,
      group: "loop",
      name: loopName(l.prompt),
      what: l.prompt || "",
      kind: "agentTurn",
      enabled: live,
      live,
      schedule: l.kind === "paced" ? { kind: "paced", reason: l.reason || null } : l.recurring ? { kind: "cron", expr: l.cron } : { kind: "at", at: nextCron(l.cron, Date.parse(l.at) - 60e3) },
      // It runs again on its own (a cron, a /loop someone started), or it's a check Claude set itself, once.
      repeats: l.kind === "paced" ? !!l.slash : l.recurring,
      next: next && (!expires || next < expires) ? next : null,
      last: lastRun,
      runs: l.runs?.length || 0,
      expires,
      ended: l.ended || null,
      created: l.at,
      post: s.id,
      status: null,
      acts: live ? [...(/^<<autonomous-loop>>$/.test(String(l.prompt).trim()) ? [] : ["run"]), "stop"] : [],
    };
  }
  // A post's loops, newest first, for its page: the live ones, and the ones that ended in the last day.
  function loopsOf(s) {
    if (!s.loops?.length || !isClaude(s)) return null;
    const day = Date.now() - 86400e3;
    const out = s.loops.map((l) => loopOf(s, l)).filter((l) => l.live || Date.parse(l.ended || l.last || l.created) > day);
    return out.length ? out.sort((a, b) => b.created.localeCompare(a.created)) : null;
  }
  const liveLoops = (agent) =>
    Object.values(host.state.sessions)
      .filter((s) => s.agent === agent && s.loops?.length && isClaude(s))
      .flatMap((s) => s.loops.map((l) => loopOf(s, l)))
      .filter((l) => l.live);
  const findLoop = (agent, job) => {
    const m = String(job).match(/^loop-(.+)-([^-]+)$/);
    const s = m && host.state.sessions[m[1]];
    const l = s && s.agent === agent && isClaude(s) ? s.loops?.find((x) => x.id === m[2]) : null;
    return l ? { s, l, r: loopOf(s, l) } : null;
  };

  /* ---------- what the profile and pages ask ---------- */

  // What its profile shows before you open them. null: nothing to show.
  function routinesOf(id) {
    const loops = liveLoops(id);
    const cloud = id === "claude" ? routinesList || [] : [];
    if (!loops.length && !cloud.length && !(id === "claude" && listError && signInSource())) return null;
    const all = [...cloud, ...loops];
    const next = all.map((r) => r.next).filter(Boolean).sort()[0] || null;
    const last = all.map((r) => r.last).filter(Boolean).sort().at(-1) || null;
    return { n: all.length, loops: loops.length, paused: cloud.filter((r) => !r.enabled).length, failing: cloud.filter((r) => r.enabled && r.status === "error").length, failed: failedRoutines(cloud), running: cloud.filter((r) => r.running).length, next, last, error: id === "claude" ? listError : null };
  }

  async function routines(id) {
    if (id === "claude") await fresh();
    return { routines: [...(id === "claude" ? routinesList || [] : []), ...liveLoops(id)], error: id === "claude" ? listError : null };
  }

  // One routine, with its runs, newest first. A loop's runs are turns of its post.
  async function routine(id, job, { offset = 0 } = {}) {
    const loop = findLoop(id, job);
    if (loop) {
      const runs = [...(loop.l.runs || [])].reverse().map((r, i) => ({ id: `${job}-${r.at}`, job, at: r.at, took: null, status: null, summary: null, session: null, post: loop.s.id, turn: r.turn, n: loop.l.runs.length - i }));
      return { routine: loop.r, runs, total: runs.length, more: false };
    }
    if (id !== "claude") return null;
    await fresh();
    const r = routinesList?.find((x) => x.id === job);
    if (!r) return null;
    const cursor = offset ? cursors.get(job)?.[offset] : null;
    if (offset && !cursor) return { routine: r, runs: [], total: null, more: false };
    const page = await api("GET", `/v1/code/sessions?trigger_id=${encodeURIComponent(job)}&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    const list = page?.data || [];
    if (page?.next_cursor) cursors.set(job, { ...cursors.get(job), [offset + list.length]: page.next_cursor });
    // How each finished run went, a few at a time; the ones read before are remembered.
    const todo = list.filter((s) => !results.has(s.id) && s.worker_status !== "running");
    for (let i = 0; i < todo.length; i += 6) await Promise.all(todo.slice(i, i + 6).map(outcome));
    return { routine: r, runs: list.map((s) => runOf(s, job)), total: null, more: !!page?.next_cursor };
  }

  // A run on claude.ai: the steps it took and what it said, from its newest 200 events.
  async function routineRun(id, job, session) {
    if (id !== "claude" || !routinesList?.some((x) => x.id === job) || !/^(?:cse|session)_\w+$/.test(session || "")) return null;
    const r = await api("GET", `/v1/code/sessions/${encodeURIComponent(session)}/events?limit=200&sort_order=desc`);
    const events = [...(r?.data || [])].reverse();
    const steps = [];
    const byId = new Map();
    let reply = null;
    let model = null;
    for (const e of events) {
      const p = e.payload || {};
      const at = iso(e.created_at || p.timestamp);
      if (p.type === "system" && p.subtype === "init") model = p.model || model;
      if (p.type === "assistant") {
        for (const b of Array.isArray(p.message?.content) ? p.message.content : []) {
          if (b.type === "text" && b.text?.trim()) {
            steps.push({ id: `${e.event_id || at}:say`, kind: "say", at, text: short(b.text, 600) });
            reply = { text: b.text, at };
          } else if (b.type === "tool_use" && b.name !== "ToolSearch") {
            const step = { id: b.id, kind: "tool", at, tool: b.name, title: describeTool(b.name, b.input || {}), done: null, error: null };
            steps.push(step);
            byId.set(b.id, step);
          }
        }
      } else if (p.type === "user") {
        for (const b of Array.isArray(p.message?.content) ? p.message.content : []) {
          const step = b.type === "tool_result" && byId.get(b.tool_use_id);
          if (!step) continue;
          step.done = at;
          if (b.is_error) step.error = short(textOf(b.content) || "Failed");
        }
      } else if (p.type === "result" && p.result) reply = { text: p.result, at };
    }
    return { steps, reply, model, url: sessionUrl(session) };
  }

  // Run one now, or pause or resume it. A loop's Run now and Stop are messages to its post.
  async function routineDo(id, job, what) {
    const loop = findLoop(id, job);
    if (loop) {
      if (!loop.r.acts.includes(what)) throw refused(409, loop.r.live ? "This loop can't do that." : "This loop isn't running anymore.");
      const text = what === "run" ? (/^<<autonomous-loop-dynamic>>$/.test(String(loop.l.prompt).trim()) ? "/loop" : loop.l.prompt) : `Stop the loop “${short(loop.r.name, 80)}”${loop.l.kind === "cron" ? ` (scheduled task ${loop.l.id})` : ""}.`;
      host.commit({ t: "message.add", post: loop.s.id, from: "human", via: "dash", text });
      return true;
    }
    if (id !== "claude" || !routinesList?.some((x) => x.id === job)) return false;
    if (what === "run") await api("POST", `/v1/code/triggers/${encodeURIComponent(job)}/run`, {});
    else if (what === "pause" || what === "resume") await api("POST", `/v1/code/triggers/${encodeURIComponent(job)}`, { enabled: what === "resume" });
    else throw refused(400, "action: run, pause or resume");
    await loadRoutines();
    return true;
  }

  /* ---------- its usage limits ---------- */

  // How much of its plan's limits Claude Code has used on this machine's sign-in (the 5-hour one, the week's, a
  // model's), read when its profile asks, at most once a minute.
  const usage = limitsReader(async () => {
    const a = await signIn();
    if (!a) throw refused(404, "agentbook doesn't read Claude's usage here.");
    may(a, "user:profile", "its usage");
    const res = await fetch(`${API()}/api/oauth/usage`, { headers: { authorization: `Bearer ${a.token}`, accept: "application/json", "anthropic-version": "2023-06-01", "anthropic-beta": USAGE_BETA }, signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {}
    if (!res.ok) {
      if (res.status === 401) auth = null;
      throw refused(502, res.status === 429 ? "claude.ai asked to be asked less often." : `claude.ai said ${res.status}${data?.error?.message ? `: ${short(data.error.message, 200)}` : ""}`);
    }
    return { limits: [claudeLimitsOf(data, a.plan)] };
  });
  // Only its own agent's ("claude"), whose sign-in this is, and only where it may read it.
  const limits = (id) => (id === "claude" && signInSource() ? usage() : null);

  // Its machine may log in to a server after it started, so each tick asks again whether it may read the sign-in.
  function begin() {
    const tick = () => {
      if (signInSource()) return loadRoutines().catch(() => {});
      if (host.hosted?.() && !saidOff && claudeSignInSource({ hosted: false })) {
        saidOff = true;
        log("claude routines: off, since this machine reports to an agentbook-server elsewhere: Claude Code's claude.ai sign-in stays here (AGENTBOOK_CLAUDE_ROUTINES=1 reads it anyway)");
      }
    };
    setTimeout(tick, 4000).unref();
    setInterval(tick, LIST_MS).unref();
  }

  return { name: "claude.ai", begin, owns: (id) => host.state.agents[id]?.kind === "claude-code", routinesOf, routines, routine, routineRun, routineDo, loopsOf, limits };
}
