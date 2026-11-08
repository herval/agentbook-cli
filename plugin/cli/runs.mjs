// Code blocks run from a thread's messages (post.run): in the thread's terminal (terminals.mjs), the one shell its
// Open terminal shows, as pasted at its prompt, so what one block sets (a folder, a variable) the next one has, and
// what asks for input can have it. A thread whose terminal can't say when code ends (a shell other than zsh or bash,
// or a machine whose gate turned terminals off) runs each in a shell of its own instead. It runs only what really is
// a code block in that message, whatever the command says. What it prints goes up with the post's info while it runs
// (`live`); how it went, with the end of what it printed, is kept with the post as it starts and once it ends
// (session.run), so it's still there after the page reloads, or while the machine is off. Once it ends, the thread's
// agent hears how it went, as it hears your messages (a `run` event).

import { spawn } from "node:child_process";
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { RUN_OUT_MAX } from "../shared/protocol.mjs";
import { conversationOf } from "../shared/store.mjs";
import { codeBlocks, sameCode } from "../shared/text.mjs";
import { cleanEnv } from "./drivers/claude.mjs";

const LIVE_MAX = 32 * 1024; // what goes up while it runs: a post's info holds 256 KB, and AT_ONCE of these fit
const RAW_MAX = 2 * RUN_OUT_MAX; // what's held of what it printed, before it's cleaned
const AT_ONCE = 4; // runs going at once in one thread
const LIVE_MS = 400; // what it printed goes up at most this often
const KILL_MS = 3000; // after Stop, how long it has to end before it's killed
const TELL_OUT_MAX = 8 * 1024; // what its agent hears of what it printed: the end of it
const TELL_CODE_MAX = 4000; // and of the code, the start

// What it printed as a page shows it: without the escapes that color it or move the cursor, other control
// characters, or what a line wrote over itself (a progress bar's \r).
export function plainOutput(s) {
  return String(s || "")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => (l.includes("\r") ? l.split("\r").filter(Boolean).pop() || "" : l))
    .join("\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}
// What zsh shows after a command's output and before its prompt (PROMPT_SP: a mark where output didn't end its line,
// spaces to the edge, then back), which a terminal's run sees before it hears the command ended.
const PROMPT_SP = /(?:\x1b\[[\d;]*m)*[^\x1b\n]?(?:\x1b\[[\d;]*m)* +\r \r$/;
// The end of it, at most `max` long, starting on a line where it can: { out, cut }.
function tail(text, max, cut) {
  if (text.length <= max) return { out: text, cut };
  const end = text.slice(-max);
  const nl = end.indexOf("\n");
  return { out: nl >= 0 && nl < 400 ? end.slice(nl + 1) : end, cut: true };
}
const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
// The person's shell, as a terminal would start it.
const shellOf = () => [process.env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"].find((s) => s && s.startsWith("/") && fs.existsSync(s));

// `state`, `commit`: the CLI's store. `changed()`: what the page shows of the machine changed (its info). `machine`:
// this machine's name, for what it says. `refused(dir, post)`: why its gate won't have anything run in a folder (one
// this machine keeps out), or null. `terminals()`: the threads' terminals, or null while the gate has them off.
// `opens()`: whether a run may open its thread's terminal (not on a machine that takes a terminal only signed for
// one: a run's signature is for its block, not a shell).
export function createRuns({ state, commit, changed = () => {}, machine = "this machine", refused = async () => null, terminals = () => null, opens = () => true, log = () => {} }) {
  const going = new Map(); // "post\0mid:block" -> { post, mid, block, by, started, raw, cut, child or term, stopping }
  const keyOf = (post, mid, block) => `${post}\0${mid}:${block}`;
  const no = (status, error) => ({ error, status });
  let soon = null;
  const say = () => {
    soon ||= setTimeout(() => {
      soon = null;
      changed();
    }, LIVE_MS);
  };

  // Where a thread's code runs: the folder its session works in, else its checkout.
  const folderOf = (s) => [s.cwd, s.root].find((d) => d && isDir(d)) || null;

  async function start({ post, mid, block, code }, by = null) {
    const s = state.sessions[post];
    if (!s) return no(404, "No such thread");
    const m = conversationOf(state, post).find((x) => x.id === mid);
    if (!m) return no(404, "No such message");
    // What runs is the message's own block, the one you saw.
    const found = codeBlocks(m.text).find((b) => sameCode(b.code, code));
    if (!found || !found.code.trim()) return no(409, "That code isn't in the message. Load the thread again.");
    const cwd = folderOf(s);
    if (!cwd) return no(409, s.cwd || s.root ? `Its folder isn't on ${machine} any more.` : `This thread has no folder on ${machine} to run it in.`);
    const why = await refused(cwd, post);
    if (why) return no(why.status || 403, `agentbook-cli refused it: ${why.error || why}`);
    const k = keyOf(post, mid, block);
    if (going.has(k)) return no(409, "It's running already.");
    const terms = terminals();
    if (terms) {
      const r = { post, mid, block, by, code: found.code, from: m.from, started: new Date().toISOString(), raw: "", cut: false, term: null, stopping: false, done: false };
      going.set(k, r);
      const text = new StringDecoder("utf8");
      let R;
      try {
        R = await terms.run(post, cwd, found.code, { output: (b) => add(r, text.write(b)), end: (how) => finish(r, { ...how, exit: how.exit ?? null }) }, { open: opens() });
      } catch (e) {
        going.delete(k);
        return no(e.status || 500, e.message);
      }
      if (R) {
        r.term = R;
        if (!r.done) commit({ t: "session.run", post, mid, block, state: "running", by, started: r.started, out: "" });
        log(`ran a code block of ${s.label || post}'s in its terminal${by ? ` for @${by}` : ""}`);
        return { running: true, terminal: true };
      }
      going.delete(k);
    }
    if ([...going.values()].filter((r) => r.post === post).length >= AT_ONCE) return no(429, `${AT_ONCE} are running in this thread already. Stop one first.`);
    const shell = shellOf();
    if (!shell) return no(500, `There's no shell on ${machine} to run it in.`);
    const r = { post, mid, block, by, code: found.code, from: m.from, started: new Date().toISOString(), raw: "", cut: false, child: null, stopping: false, done: false };
    going.set(k, r);
    commit({ t: "session.run", post, mid, block, state: "running", by, started: r.started, out: "" });
    // A process group of its own, so Stop ends what it started too (a dev server under make). Nothing to type into:
    // what asks for input gets none. No colors to strip.
    let child;
    try {
      child = r.child = spawn(shell, ["-l", "-c", found.code], { cwd, env: cleanEnv({ TERM: "dumb", NO_COLOR: "1" }), stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (e) {
      finish(r, { error: e.message });
      return { running: false };
    }
    for (const stream of [child.stdout, child.stderr]) {
      const text = new StringDecoder("utf8");
      stream.on("data", (b) => add(r, text.write(b)));
      stream.on("end", () => add(r, text.end()));
    }
    child.on("error", (e) => finish(r, { error: e.message }));
    child.on("close", (exit, signal) => finish(r, { exit, signal }));
    log(`ran a code block of ${s.label || post}'s in ${cwd}${by ? ` for @${by}` : ""}`);
    return { running: true };
  }

  function add(r, chunk) {
    if (!chunk || r.done) return;
    r.raw += chunk;
    if (r.raw.length > RAW_MAX) {
      r.raw = r.raw.slice(-RAW_MAX);
      r.cut = true;
    }
    say();
  }

  // `note`: what to say of how it went that isn't a failure.
  function finish(r, { exit = null, signal = null, error = null, note = null }) {
    if (r.done) return;
    r.done = true;
    going.delete(keyOf(r.post, r.mid, r.block));
    clearTimeout(r.kill);
    const { out, cut } = tail(plainOutput(shown(r)), RUN_OUT_MAX, r.cut);
    const how = r.stopping ? "stopped" : error ? "failed" : "done";
    const run = { state: how, by: r.by, started: r.started, ended: new Date().toISOString(), exit: exit ?? null, signal: signal ?? null, out, cut, error: error || note ? String(error || note).slice(0, 600) : null };
    commit({ t: "session.run", post: r.post, mid: r.mid, block: r.block, ...run });
    tell(r, run);
    changed();
  }

  // Its agent hears how it went once it's done, as it hears your messages: the code, how it ended, and the end of
  // what it printed. A busy one hears it at its next step, an idle one is woken with it, an ended one has it with its
  // next turn.
  function tell(r, run) {
    const code = r.code ?? codeOf(r.post, r.mid, r.block);
    const { out, cut } = tail(run.out || "", TELL_OUT_MAX, run.cut);
    const from = r.from ?? conversationOf(state, r.post).find((x) => x.id === r.mid)?.from ?? null;
    commit({ t: "event.deliver", post: r.post, event: { type: "run", ...run, from, code: code.length > TELL_CODE_MAX ? `${code.slice(0, TELL_CODE_MAX)}\n…` : code, terminal: !!r.term, out, cut } });
  }
  // A block of a message, as it shows now: for a run heard again after agentbook-cli restarted, which kept no code.
  function codeOf(post, mid, block) {
    const m = conversationOf(state, post).find((x) => x.id === mid);
    return (m && codeBlocks(m.text)[block]?.code) || "";
  }

  // What it printed, as kept: in a terminal, without what zsh shows before its prompt.
  const shown = (r) => (r.term ? r.raw.replace(PROMPT_SP, "") : r.raw);

  function stop({ post, mid, block }) {
    const r = going.get(keyOf(post, mid, block));
    if (!r) return no(404, "It isn't running.");
    r.stopping = true;
    if (r.term) {
      r.term.stop();
      return { stopping: true };
    }
    signal(r, "SIGTERM");
    r.kill = setTimeout(() => signal(r, "SIGKILL"), KILL_MS);
    r.kill.unref?.();
    return { stopping: true };
  }
  function signal(r, sig) {
    if (!r.child?.pid || r.done) return;
    try {
      process.kill(-r.child.pid, sig);
    } catch {
      try {
        r.child.kill(sig);
      } catch {}
    }
  }

  // What's running in a post, with what it printed so far, for its info: { "mid:block": run }, or null.
  function live(post) {
    let out = null;
    for (const r of going.values()) {
      if (r.post !== post) continue;
      const t = tail(plainOutput(shown(r).slice(-2 * LIVE_MAX)), LIVE_MAX, r.cut || r.raw.length > 2 * LIVE_MAX);
      (out ||= {})[`${r.mid}:${r.block}`] = { mid: r.mid, block: r.block, state: "running", by: r.by, started: r.started, out: t.out, cut: t.cut };
    }
    return out;
  }

  // Runs it was holding when it last stopped (agentbook-cli restarted, or the machine did): one still running in its
  // thread's terminal is heard again (call this once the terminals are found again); the others can't say how they
  // ended.
  function begin() {
    for (const s of Object.values(state.sessions))
      for (const r of Object.values(s.runs || {})) {
        if (r.state !== "running" || going.has(keyOf(s.id, r.mid, r.block))) continue;
        const again = { post: s.id, mid: r.mid, block: r.block, by: r.by, started: r.started, raw: "", cut: false, term: null, stopping: false, done: false };
        const text = new StringDecoder("utf8");
        const R = terminals()?.resume(s.id, { output: (b) => add(again, text.write(b)), end: (how) => finish(again, { ...how, exit: how.exit ?? null }) });
        if (R && !again.done) {
          again.term = R;
          going.set(keyOf(s.id, r.mid, r.block), again);
          continue;
        }
        const run = { state: "stopped", by: r.by, started: r.started, ended: new Date().toISOString(), exit: null, signal: null, out: r.out, cut: r.cut, error: `agentbook-cli stopped while it ran, so how it ended isn't known` };
        commit({ t: "session.run", post: s.id, mid: r.mid, block: r.block, ...run });
        tell({ post: s.id, mid: r.mid, block: r.block, term: null }, run);
      }
  }
  // As agentbook-cli exits, what it started ends with it, rather than running on with nobody to stop it.
  process.once("exit", () => {
    for (const r of going.values()) signal(r, "SIGTERM");
  });

  return { start, stop, live, begin };
}
