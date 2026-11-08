// The workers a thread's agent hands work to: its subagents (Claude Code's Agent tool, OpenClaw's sessions_spawn,
// Codex's spawned agents, Hermes's delegated tasks). They run on their own, but aren't threads of their own: each
// shows in the conversation of the thread that started it, and one still going keeps that thread working.
//
// Every runtime says its workers the same way: { id, title, state, started, ended, error, step }.
// - `state`: queued, running, done, failed, timed out or stopped.
// - `started`, `ended`: when, as ISO times; `ended` only once it stopped.
// - `error`: why it failed, timed out or was stopped, when the runtime says.
// - `step`: what it last started, as a step is called ({ title, at }), when the runtime says.
// - `n`: how many tools it started, where agentbook can read its steps (read.worker): a Claude Code subagent's, from
//   its transcript; an OpenClaw one's, from its session's history. None where it can't.

export const going = (w) => w.state === "queued" || w.state === "running";

// Each runtime's word for how one is going, as a worker's state. One it doesn't know is left to the runtime.
const STATES = {
  queued: "queued",
  pending: "queued",
  pendingInit: "queued",
  running: "running",
  active: "running",
  inProgress: "running",
  in_progress: "running",
  started: "running",
  done: "done",
  completed: "done",
  complete: "done",
  finished: "done",
  ok: "done",
  success: "done",
  failed: "failed",
  error: "failed",
  errored: "failed",
  timeout: "timed out",
  timed_out: "timed out",
  killed: "stopped",
  aborted: "stopped",
  interrupted: "stopped",
  cancelled: "stopped",
  canceled: "stopped",
  stopped: "stopped",
};
export const stateOf = (word) => STATES[word] || null;

const KEPT_MS = 24 * 3600e3; // ones that ended show for a day
const SHOWN = 8;

// A thread's workers as its page shows them: those going, and those that ended in the last day, the newest first.
export function shown(list, now = Date.now()) {
  return (list || [])
    .filter((w) => going(w) || now - Date.parse(w.ended || w.started || 0) < KEPT_MS)
    .sort((a, b) => String(b.started || "").localeCompare(String(a.started || "")))
    .slice(0, SHOWN);
}

// Those still going, as what a thread has going between its turns ({ id, kind, title, started }).
export const goingOf = (list) => (list || []).filter(going).map((w) => ({ id: w.id, kind: "subagent", title: w.title, started: w.started }));

// Its runtime says how one is going now: its state changes, and its end with it. A worker that's going again (a
// subagent sent another message) hasn't ended.
export function settle(w, state, at, error = null) {
  if (!state) return w;
  w.state = state;
  if (going(w)) w.ended = null;
  else w.ended ||= at;
  if (error) w.error = error;
  else if (going(w) || state === "done") w.error = null;
  return w;
}
