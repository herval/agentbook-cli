// A thread on a routine, to fix it or ask for changes on it. A routine's page has a box that starts a thread with an agent: one of an agent's own routines
// (an OpenClaw cron job, a routine on claude.ai, a Codex automation) with that agent, one of agentbook's with the agent
// you pick. With what you wrote, its agent is told which routine the thread is on, how it's set up, how its last runs
// went, and how it changes it. The routine's page lists the threads started on it, the newest 20
// (state.routine_threads, store.mjs's routine.thread), keyed by threadKey.

const RUNS_TOLD = 5; // the last runs its agent hears of
const WHAT_MAX = 1500; // of its prompt or code, quoted
// When it fails for a reason outside it, a change to it fixes nothing.
const NOT_IT = "If it fails for a reason outside it (a sign-in, a key, a machine or a service that's down), don't change it: say what's wrong, and what the person should do.";

// Which routine a thread is on: one of an agent's ("<agent id>/<job>", as Needs you keys a failed one) or one of
// agentbook's (its id, which has no "/").
export const threadKey = (agentId, job) => (agentId ? `${agentId}/${job}` : String(job));

const cut = (s, n) => {
  const t = String(s ?? "").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const line = (s) => cut(String(s ?? "").replace(/\s+/g, " "), 300);
const quoted = (s) =>
  cut(s, WHAT_MAX)
    .split("\n")
    .map((l) => `  > ${l}`)
    .join("\n");

// When it runs, as its machine says: a cron expression and its zone, every so often, once, or an RFC 5545 rule.
function scheduleLine(s) {
  if (!s) return "no schedule";
  if (s.kind === "cron") return `cron "${s.expr}"${s.tz ? ` (${s.tz})` : ""}`;
  if (s.kind === "every") return `every ${Math.max(1, Math.round((s.everyMs || 0) / 60e3))} minutes`;
  if (s.kind === "at") return `once${s.at ? `, at ${s.at}` : ""}`;
  if (s.kind === "rrule") return `the rule ${s.rule}`;
  return s.kind || "no schedule";
}

// Its last runs, newest first: when, and how each went.
function runLines(runs) {
  return runs.slice(0, RUNS_TOLD).map((x) => {
    const how = x.status === "error" ? `failed: ${line(x.error || "no reason given")}` : x.status === "skipped" ? `skipped${x.error ? `: ${line(x.error)}` : ""}` : x.status === "ok" ? `ok${x.summary ? `: ${line(x.summary)}` : ""}` : x.status || "ran";
    return `  - ${x.at || "?"}: ${how}`;
  });
}

// What its agent is told about one of its own routines, as its machine reads it (read.agent_routine): `routine` and
// its `runs`, newest first, or neither when its machine couldn't be read (`job` is all there is then). `kind`: its
// agent's (openclaw, claude-code, codex).
export function agentRoutineNote({ kind, job, routine: r = null, runs = [] }) {
  const id = r?.id || job;
  const what =
    kind === "openclaw"
      ? `an OpenClaw cron job (automation), id ${id}`
      : r?.group === "cloud" || kind === "claude-code"
        ? `a routine on claude.ai, trigger id ${id}${r?.url ? ` (${r.url})` : ""}`
        : kind === "codex"
          ? `a Codex automation in the ChatGPT app, id ${id}`
          : `id ${id}`;
  const out = [`This thread is on your routine${r?.name ? ` "${r.name}"` : ""}: ${what}. Here's how it stands; it's what the person sees on its page on agentbook.`];
  if (r) {
    out.push(`- Runs: ${scheduleLine(r.schedule)}; ${r.enabled === false ? "paused" : `on${r.next ? `, next at ${r.next}` : ""}`}.`);
    if (r.description) out.push(`- About it: ${line(r.description)}`);
    if (r.what) out.push(`- ${r.kind === "command" ? "The command it runs" : r.kind === "script" ? "The script it runs" : "What it's told"}:\n${quoted(r.what)}`);
    const where = [r.model ? `model ${r.model}` : "", r.delivery ? `results go to ${r.delivery.channel || r.delivery.mode}${r.delivery.to ? ` (${r.delivery.to})` : ""}` : "", r.target && r.target !== "isolated" ? `runs in ${r.target === "main" ? "your main session" : r.target}` : ""].filter(Boolean);
    if (where.length) out.push(`- ${where.join("; ")}.`);
    if (r.failing > 1) out.push(`- It has failed ${r.failing} times in a row.`);
    else if (r.status === "error" && r.error && !runs.some((x) => x.status === "error")) out.push(`- Its last run failed: ${line(r.error)}`);
    if (runs.length) out.push(`- Its last runs:\n${runLines(runs).join("\n")}`);
  } else out.push("- agentbook couldn't read it from its machine just now, so look it up yourself.");
  const how =
    kind === "openclaw"
      ? `Your automations tool (cron, in older OpenClaw) reads it whole (get), changes it (update) and runs it now (run), by its id.`
      : kind === "codex"
        ? `On the machine the ChatGPT app keeps it on, it's ~/.codex/automations/${id}/automation.toml (its prompt, rule and status); the app runs it while it's open, and opens it at codex://automations/${id}.`
        : `RemoteTrigger (what /schedule uses) reads it whole, changes it and runs it, by its trigger id.`;
  out.push(`${how} Change this one, as the person asks, rather than making another, and say what you changed. ${NOT_IT}`);
  return out.join("\n");
}

// What its agent is told about one of agentbook's routines (routineDetail): how it's set up and how its last runs
// went, and that ab_routine_read and ab_routine_write read and change it, with the person's OK.
export function myRoutineNote(r) {
  const out = [`This thread is on agentbook's routine "${r.name}" (id ${r.id}): ${r.kind === "agent" ? `an agent routine${r.runs_as ? ` run by ${r.runs_as}` : ""}` : "code, with no model"}, ${r.when || "no schedule"}; ${r.archived ? "removed (archived)" : !r.live_v ? "not OK'd yet" : r.on ? "on" : "paused"}. Here's how it stands; it's what the person sees on its page.`];
  if (r.about) out.push(`- About it: ${line(r.about)}`);
  if (r.page) out.push(`- It keeps widgets on the page ${r.page}${r.keeps?.length ? `: ${r.keeps.join(", ")}` : ""}.`);
  if (r.kind === "agent" && r.prompt) out.push(`- What it asks:\n${quoted(r.prompt)}`);
  if (r.fails > 1) out.push(`- Its last ${r.fails} runs failed${r.failing_since ? `, since ${r.failing_since}` : ""}.`);
  const runs = (r.runs || []).slice(0, RUNS_TOLD).map((x) => `  - ${x.at}: ${x.skipped ? `skipped: ${line(x.skipped)}` : x.ok ? "ok" : `failed: ${line(x.error || "no reason given")}`}`);
  if (runs.length) out.push(`- Its last runs:\n${runs.join("\n")}`);
  out.push(`ab_routine_read with routine "${r.id}" reads its ${r.kind === "agent" ? "prompt" : "code"}, its versions and its runs with their logs; ab_routine_write with routine "${r.id}"${r.page ? ` and page "${r.page}"` : ""} changes it (test: true tries it first), and the person OKs the new version before it runs. Change this one, as the person asks, rather than making another, and say what you changed. ${NOT_IT}`);
  return out.join("\n");
}
