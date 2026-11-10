#!/usr/bin/env node
// Claude Code hooks for agentbook. Usage: node hook.mjs <EventName>  (hook input JSON on stdin)
//
// Keeps each session's post current without Claude doing anything: registers it, mirrors the terminal
// conversation into its comments, marks where turns start and end, asks on agentbook when a background
// session needs permission, and hands Claude what the person did: at its next step (PostToolUse) when they sent
// it now, and, when live delivery is off, at the end of each turn.
//
// A hook must never break the session: every failure exits 0 quietly.

import fs from "node:fs";
import { api, appOf, channelMode, describe, headless, hello, identity, startCli, typedPart, BASE_URL, CLI_DOWN, NOT_AGENTBOOK, NOT_LOGGED_IN } from "../lib/common.mjs";

const event = process.argv[2];

async function readInput() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return {};
  }
}

const out = (obj) => process.stdout.write(typeof obj === "string" ? obj : JSON.stringify(obj));
const firstLine = (s, n = 80) => {
  const line = String(s || "").split("\n").find((l) => l.trim()) || "";
  return line.length > n ? line.slice(0, n - 1) + "…" : line;
};

// How long a background session waits for you on agentbook (Allow or Deny, or Claude's questions) before
// showing Claude Code's own prompt, which only `claude attach` reaches. A background session can't go on
// without the answer either way, so it waits a day (hooks.json gives the hook as long).
const PERMISSION_WAIT_MS = Number(process.env.AGENTBOOK_PERMISSION_WAIT_MS) || 23.9 * 3600e3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// How long a session in a terminal waits, idle, to be woken by what you send (the Wake hook). After that it
// gets it when someone types there; hooks.json gives the hook as long.
const WAKE_WAIT_MS = Number(process.env.AGENTBOOK_WAKE_WAIT_MS) || 23.9 * 3600e3;
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};
// 2 when the Wake hook wakes Claude with what it wrote on stderr.
let exitCode = 0;

// Wait for a question on agentbook to be answered: the question, or null if time ran out.
async function answerOf(id, until) {
  while (Date.now() < until) {
    const q = await api("GET", `/api/questions/${encodeURIComponent(id)}?wait=50`, null, { timeout: 60000 }).catch(() => null);
    if (!q) {
      await sleep(2000);
      continue;
    }
    if (q.answered) return q;
  }
  return null;
}

const NOT_THE_TASK = "This has nothing to do with the person's task, so bring it up only if they ask about agentbook.";
// What the sidebar says while Claude handles something sent from agentbook.
const FROM_DASH = { message: "Reading your message", answer: "Picking up your answer", file: "Reading the file you sent", run: "Reading how your run went" };

async function main() {
  const input = await readInput();
  if (input.agent_id) return; // a subagent's hook; the main session speaks for itself
  if (headless()) return; // `claude -p` runs stay off agentbook
  const me = identity();
  const live = channelMode();
  const base = `/api/procs/${encodeURIComponent(me.proc)}`;

  // Call agentbook-cli as this session, registering first if it doesn't know us (a session in a terminal at its
  // first prompt, one that started before agentbook was installed, or before its data was reset).
  let registered = false;
  async function call(method, route, body, timeout = 1500) {
    try {
      return await api(method, base + route, body, { timeout });
    } catch (e) {
      if (!/isn't registered/.test(e.message)) throw e;
      await hello({ session_id: input.session_id, cwd: input.cwd, transcript: input.transcript_path });
      registered = true;
      return await api(method, base + route, body, { timeout });
    }
  }
  const status = (state, text, extra = {}) => call("POST", "/status", { state, text, ...extra });
  const mirror = (from, text) => text && call("POST", "/messages", { from, via: "terminal", text: String(text).slice(0, 12000) }).catch(() => {});
  // Events from agentbook, consumed now.
  // `news`: with what changed in its group since it last heard, even when nothing else waits (a prompt).
  const takeEvents = async (news = false) => {
    const { events } = await call("GET", `/events?ack=1${news ? "&news=1" : ""}`);
    return events.map((e) => e.event).filter((e) => e.type !== "permission");
  };

  // What agentbook says about this post: its task, branch, who else works there, who sees it. A background session
  // (CLAUDE_JOB_DIR) has no terminal anyone reads.
  const background = process.env.CLAUDE_JOB_DIR ? "1" : "0";
  const contextOf = () => call("GET", `/context?background=${background}`, null, 4000).then((c) => (typeof c === "string" ? c.trim() : "")).catch(() => "");

  switch (event) {
    case "SessionStart": {
      const cli = await startCli();
      if (cli.why) return out({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: CLI_DOWN(cli.why) } });
      if (!cli.up) return;
      // A session in a terminal that just started (`claude`, or /clear) gets its thread at its first prompt
      // (UserPromptSubmit registers it then): agentbook-cli says `deferred` and keeps none for it until then.
      // Claude Code saves its conversation from that prompt on, so one that has one already (a fork, a teleport)
      // has its thread now.
      const saved = (() => {
        try {
          return fs.statSync(input.transcript_path).size > 0;
        } catch {
          return false;
        }
      })();
      const fresh = (input.source === "startup" || input.source === "clear") && background === "0" && !saved;
      // A thread starting (not one that compacted) has agentbook-cli try its server again, if that stopped taking its login.
      const r = await hello({ session_id: input.session_id, cwd: input.cwd, transcript: input.transcript_path, ...(fresh ? { fresh: true } : {}), ...(input.source !== "compact" ? { starting: true } : {}) });
      // Not logged in: it isn't a thread, and this is what to say if the person asks.
      if (r.login) return out({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: `${NOT_LOGGED_IN}\n${NOT_THE_TASK}` } });
      // A newer agentbook-cli is out (its server says the number, and agentbook-cli says the rest): the person sees it
      // in their terminal as a session starts, not again after compacting, and the agent knows, should they ask.
      const nudge = r.update && input.source !== "compact" ? { systemMessage: r.update } : {};
      const aside = r.update ? `\n\n${r.update}\n${NOT_THE_TASK}` : "";
      // Kept off agentbook (Private terminals): it isn't a thread, so it's told nothing.
      if (r.deferred || r.private) return nudge.systemMessage && out(nudge);
      if (input.source !== "compact") await status("idle", input.source === "resume" ? "Resumed, waiting for a prompt" : "Started, waiting for a prompt", { turn: "end" });
      // Claude Code runs this hook again after compacting, so it's told again then.
      const context = await contextOf();
      if (context) return out({ ...nudge, hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context + aside } });
      out({
        ...nudge,
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext:
            `agentbook: this session is a thread on the person's agentbook (${BASE_URL}), a page where they follow all their agents' sessions. You appear as "${r.label}". ` +
            "Your steps show up there on their own. Keep the thread itself useful: ab_post when you know what this session is for, ab_update for results worth seeing, ab_ask instead of stopping to ask when they may be away. " +
            (live
              ? "Live delivery is on: their answers and comments arrive as agentbook channel events between your turns."
              : "Their answers and comments arrive at the end of your turns (a message they send now, at your next step), or via ab_inbox. When you're idle, a message from them starts your next turn.") +
            aside,
        },
      });
      return;
    }

    case "UserPromptSubmit": {
      // Claude Code submits prompts of its own too: agentbook events, subagent reports. Mirror only what the person typed.
      const typed = typedPart(input.prompt);
      await mirror("human", typed);
      const kind = /<channel\b[^>]*\bkind="(\w+)"/.exec(input.prompt || "")?.[1];
      // Visual mode's reminder to show how the turn went, from agentbook.
      const started = await status("working", firstLine(typed) || FROM_DASH[kind] || "Working", { turn: "start", settle_permissions: true, transcript: input.transcript_path, app: appOf() });
      const said = started?.remind ? [started.remind] : [];
      // Its first prompt registered it (a session in a terminal, see SessionStart): what SessionStart would have said.
      const context = registered ? await contextOf() : "";
      if (context) said.unshift(context);
      else if (started?.login_lost) said.unshift(started.login_lost);
      const events = live ? [] : await takeEvents(true);
      if (events.length) said.push(`From agentbook since your last turn:\n${events.map((e) => `- ${describe(e)}`).join("\n")}`);
      if (said.length) out(said.join("\n\n"));
      return;
    }

    case "PermissionRequest": {
      // A background session has no terminal to show Claude Code's prompt in, so it asks on agentbook and
      // waits. The server answers "don't wait" for sessions in a terminal: they get their usual prompt.
      const r = await call("POST", "/permission", { tool_name: input.tool_name, tool_input: input.tool_input, tool_use_id: input.tool_use_id }, 15000);
      if (!r?.wait) return;
      const until = Date.now() + PERMISSION_WAIT_MS;
      const ids = r.ask ? r.ids : [r.id];
      const answers = [];
      for (const id of ids) {
        const q = await answerOf(id, until);
        if (!q) {
          await call("POST", "/permission/expire", { ids }, 5000).catch(() => {});
          return;
        }
        if (q.by === "comment") {
          // The person wrote on the post instead of answering, which set the prompt aside (as Esc does in a
          // terminal): what they wrote goes to Claude now, as the reason.
          const events = await takeEvents().catch(() => []);
          await status("working", FROM_DASH.message).catch(() => {});
          const what = r.ask ? "answering your question" : `answering whether you may use ${input.tool_name}`;
          const said = events.length ? `:\n${events.map((e) => `- ${describe(e)}`).join("\n")}\nHandle what they wrote first. Reply to comments with ab_reply.` : ". It reaches you when this turn ends.";
          out({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: `The person wrote to you on agentbook instead of ${what}${said}` } } });
          return;
        }
        answers.push(q);
      }
      if (r.ask) {
        // Claude's questions (AskUserQuestion): its answers, keyed by each question's text.
        const questions = input.tool_input?.questions || [];
        const picked = {};
        answers.forEach((q, i) => {
          if (q.by !== "skipped" && q.value != null && questions[i]) picked[questions[i].question] = q.value;
        });
        const why = answers.some((q) => q.by === "archived") ? "archived this thread on agentbook, which closed your question unanswered" : "skipped your question on agentbook";
        if (!Object.keys(picked).length) out({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: `The person ${why}. Go on with your best judgment.` } } });
        else out({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: { questions, answers: picked } } } });
        return;
      }
      const [q] = answers;
      if (q.value === "allow") out({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
      else if (q.value === "deny") out({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "The person denied this on agentbook." } } });
      return;
    }

    case "PostToolUse": {
      // Send now, in the middle of a turn: what you sent reaches Claude at its next step, rather than as the turn
      // ends. hooks.json starts this only when agentbook-cli has left a file saying something waits for this session.
      const events = await takeEvents().catch(() => []);
      if (!events.length) return;
      await status("working", FROM_DASH[events[0].type] || "Handling what you sent from agentbook").catch(() => {});
      out({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: `New from agentbook while you were working:\n${events.map((e) => `- ${describe(e)}`).join("\n")}\nTake these into account now, before you go on. Reply to comments with ab_reply.` } });
      return;
    }

    case "Stop": {
      await mirror("agent", input.last_assistant_message);
      if (!live) {
        // A CLI too busy to say what waits costs this one look, never the turn's end, which only this hook reports:
        // without it the thread stays on working, and what you queue waits on it.
        const events = await takeEvents().catch(() => []);
        if (events.length) {
          await status("working", "Handling what you sent from agentbook", { settle_permissions: true });
          out({
            decision: "block",
            reason: `New from agentbook while you were working:\n${events.map((e) => `- ${describe(e)}`).join("\n")}\nHandle these now. Reply to comments with ab_reply.`,
          });
          return;
        }
      }
      // `replied`: a turn Claude answered, which says Claude Code is signed in.
      await status("idle", "Finished, waiting for your next prompt", { turn: "end", settle_permissions: true, replied: true });
      return;
    }

    // An API error ended the turn (Claude Code runs this instead of Stop): the network dropped, the computer slept
    // mid-reply, the API was overloaded, a usage limit, the login expired. The turn is over, and agentbook-cli picks
    // a background one up again once the API answers, when the error is one that passes, or once you've signed in.
    case "StopFailure": {
      const said = firstLine(String(input.last_assistant_message || "").replace(/^API Error:\s*/i, ""), 200);
      await status("idle", said || "An API error ended its turn", { turn: "end", settle_permissions: true, failed: String(input.error || "unknown") });
      return;
    }

    // Beside the Stop hook (and StopFailure's), in the background (asyncRewake in hooks.json): a session in a
    // terminal without the channel sits at its prompt until someone types there, so this waits while it's idle and
    // wakes it with what you send from agentbook (exit 2 starts a turn). It gives up once a turn starts, since that
    // turn's Stop or StopFailure hook starts the next one. The channel, and agentbook's supervisor for background
    // sessions, reach those already.
    case "Wake": {
      if (live || process.env.CLAUDE_JOB_DIR) return;
      const until = Date.now() + WAKE_WAIT_MS;
      // The Stop hook beside this one says first whether the turn ended or goes on with what it handed over.
      const settle = Date.now() + 10e3;
      let idle = false;
      while (Date.now() < until && alive(me.pid)) {
        // Straight to agentbook-cli, not `call`: a session that ended isn't registered, and mustn't be again.
        // Not registered yet (SessionStart beside it registers it) is a wait, like a turn still ending.
        const r = await api("GET", `${base}/events?idle=1&wait=50`, null, { timeout: 60e3 }).catch((e) => (/isn't registered/.test(e.message) ? { idle: false } : /Private terminals/.test(e.message) ? { kept_off: true } : { error: true }));
        if (r.kept_off) return; // nothing from agentbook reaches a session kept off it
        if (r.error) {
          await sleep(5000);
          continue;
        }
        if (r.idle === undefined) return; // an agentbook-cli from before this hook
        if (r.idle === false) {
          if (idle || r.left || Date.now() > settle) return;
          await sleep(1000);
          continue;
        }
        idle = true;
        if (!r.events.some((e) => e.event.type !== "permission")) continue;
        const events = await takeEvents().catch(() => []);
        if (!events.length) continue;
        await status("working", FROM_DASH[events[0].type] || "Handling what you sent from agentbook", { turn: "start" }).catch(() => {});
        await new Promise((done) => process.stderr.write(`New from agentbook while you were idle:\n${events.map((e) => `- ${describe(e)}`).join("\n")}\nHandle these now. Reply to comments with ab_reply.`, done));
        exitCode = 2;
        return;
      }
      return;
    }

    case "Notification": {
      // Straight to agentbook-cli, not `call`: a session in a terminal waiting for its first prompt has no thread,
      // and this mustn't make one.
      const note = (state, text, extra = {}) => api("POST", `${base}/status`, { state, text, ...extra }, { timeout: 1500 });
      if (input.notification_type === "permission_prompt") await note("waiting", firstLine(input.message) || `Waiting for permission in ${{ desktop: "Desktop", vscode: "VS Code" }[appOf()] || "the terminal"}`);
      // Also ends a turn the person interrupted, which never reaches the Stop hook.
      else if (input.notification_type === "idle_prompt") await note("idle", "Waiting for your input", { turn: "end" });
      return;
    }

    case "SessionEnd": {
      // After /clear the next SessionStart closes this post (and, in a terminal, the next prompt opens a new one).
      if (input.reason === "clear") return;
      await api("POST", `${base}/gone`, { reason: "Ended" }, { timeout: 1000 });
      return;
    }
  }
}

main()
  .catch((e) => {
    // Something other than agentbook-cli holds its port, so nothing it said was used (an Allow among it): a session
    // that starts hears why it isn't a thread.
    if (e?.code === NOT_AGENTBOOK && event === "SessionStart") out({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: `agentbook: ${e.message} Until then this session isn't a thread. This has nothing to do with the person's task, so bring it up only if they ask about agentbook.` } });
  })
  .finally(() => process.exit(exitCode));
