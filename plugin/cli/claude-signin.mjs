// Claude Code signed in again from agentbook, on a machine nobody's at, so nobody has to ssh into it to log in
// again: `claude auth login` runs here with no
// terminal and no browser, its link goes to the thread's Login expired card, you sign in to claude.ai wherever you
// are, and the code claude.ai shows you then comes back here to it (the claude.login command).
//
// Claude Code (2.1.319) prints "If the browser didn't open, visit: <link>" and reads one `code#state` line from its
// input: a code it takes signs it in and it exits 0; anything else ends it ("Login failed: That code wasn't
// accepted…"), so a link takes one code. BROWSER set to `true` keeps it from opening a browser on this machine. The
// secret that turns a code into a login (PKCE's verifier) never leaves its process, so the link and the code can go
// through the server; neither is logged here.

import { spawn } from "node:child_process";

const LINK_MS = Number(process.env.AGENTBOOK_SIGNIN_LINK_MS) || 20e3; // for its link to show
const CODE_MS = Number(process.env.AGENTBOOK_SIGNIN_CODE_MS) || 40e3; // for a code to be taken or not
const KEEP_MS = Number(process.env.AGENTBOOK_SIGNIN_KEEP_MS) || 10 * 60e3; // a link nobody used, after which it's ended

// Terminal escapes out of what it printed: colors, and a link wrapped as a terminal hyperlink.
const plain = (s) => String(s).replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");

// `bin()`: the claude command. `env(extra)`: the environment its sessions run in, so it signs in the login they use.
// `signedIn()`: called once it has.
export function createSignin({ bin, env, log = () => {}, signedIn = () => {} }) {
  let cur = null; // { child, url, at, err, exit, sent, timer, onExit }

  function end(c) {
    if (!c) return;
    clearTimeout(c.timer);
    if (c.exit == null) c.child.kill();
    if (cur === c) cur = null;
  }
  // What it said last when it failed, without its "Login failed: ".
  const said = (c) =>
    plain(c.err)
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .pop()
      ?.replace(/^Login failed:\s*/i, "")
      .slice(0, 400) || "";

  // Its link: { url }, the one already going while it's fresh (two cards, or a reload, get the same link), or
  // { error, status }.
  function start() {
    if (cur && cur.exit == null && cur.sent) return Promise.resolve({ error: "It's signing in with the code you sent. Give it a moment.", status: 409 });
    if (cur && cur.exit == null && cur.url && Date.now() - cur.at < KEEP_MS - 60e3) return Promise.resolve({ url: cur.url });
    end(cur);
    let child;
    try {
      child = spawn(bin(), ["auth", "login"], { env: env({ BROWSER: "true" }), stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return Promise.resolve({ error: `Claude Code couldn't start signing in: ${e.message}`, status: 500 });
    }
    const c = { child, url: null, at: Date.now(), out: "", err: "", exit: null, sent: false, timer: null, onExit: null };
    cur = c;
    c.timer = setTimeout(() => {
      log("Claude Code: a sign-in from agentbook went unused, so it's ended");
      end(c);
    }, KEEP_MS);
    c.timer.unref?.();
    child.stdin.on("error", () => {});
    child.stderr.on("data", (d) => (c.err = (c.err + d).slice(-4000)));
    return new Promise((resolve) => {
      let answered = false;
      const answer = (r) => {
        if (answered) return;
        answered = true;
        clearTimeout(wait);
        resolve(r);
      };
      const wait = setTimeout(() => {
        end(c);
        answer({ error: "Claude Code didn't give a link to sign in with.", status: 504 });
      }, LINK_MS);
      child.stdout.on("data", (d) => {
        c.out = (c.out + d).slice(-8000);
        const m = !c.url && /visit:\s*(https:\/\/[^\s<>"']+)/.exec(plain(c.out));
        if (!m) return;
        c.url = m[1];
        log("Claude Code: signing in from agentbook, its link sent to the page");
        answer({ url: c.url });
      });
      child.on("error", (e) => {
        c.exit = -1;
        if (cur === c) cur = null;
        answer({ error: `Claude Code couldn't start signing in: ${e.message}`, status: 500 });
      });
      child.on("exit", (code) => {
        c.exit = code ?? -1;
        clearTimeout(c.timer);
        if (cur === c) cur = null;
        c.onExit?.(c.exit);
        answer({ error: `Claude Code couldn't start signing in${said(c) ? `: ${said(c)}` : "."}`, status: 502 });
      });
    });
  }

  // The code claude.ai showed you, given to it: {} once it's signed in, or { error, status, ended }, `ended` when that
  // link is used up (Sign in again gets a new one).
  async function code(text) {
    const c = cur;
    if (!c || c.exit != null || !c.url || c.sent) return { error: "That sign-in has ended. Press Sign in again for a new link.", status: 409, ended: true };
    const line = String(text || "").trim();
    if (!line || /\s/.test(line) || line.length > 2000) return { error: "Paste the code claude.ai showed you, as it is.", status: 400 };
    c.sent = true;
    const exit = await new Promise((resolve) => {
      c.onExit = resolve;
      const t = setTimeout(() => resolve(null), CODE_MS);
      t.unref?.();
      c.child.stdin.write(`${line}\n`);
    });
    if (exit === 0) {
      log("Claude Code signed in again from agentbook");
      try {
        signedIn();
      } catch {}
      return {};
    }
    end(c);
    if (exit == null) return { error: "Claude Code didn't say whether it took the code. Press Sign in again for a new link.", status: 504, ended: true };
    log(`Claude Code didn't take the code from agentbook (it ended, ${exit})`);
    return { error: `Claude Code didn't take it: ${said(c) || "that code wasn't accepted."}`, status: 400, ended: true };
  }

  return { start, code, close: () => end(cur) };
}
