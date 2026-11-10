// Claude Desktop's Code tab: which of its sessions another one started. A Desktop session can start another (its
// start_session tool: a task the person starts from a card, or one that starts on its own), and that one is a Claude
// Code session like any other, whose transcript names the one that started it only by Desktop's own ids (`local_…`).
// Desktop keeps a record of each session it runs, in its profile's folder:
//   <profile>/claude-code-sessions/<account>/<organization>/local_<uuid>.json
// with `sessionId` (its local_ id), `cliSessionId` (the Claude Code session it runs; `lastAssistantCliSessionId` once
// a resume went on in another one), and, in one another session started, `spawnedFrom: { sessionId, taskId, title }`.
// <profile> is ~/Library/Application Support/Claude, and each folder in "…/Claude Profiles" (a profile of its own,
// signed in to another account); on Windows the same under %APPDATA%. AGENTBOOK_DESKTOP_DIRS names them instead
// (tests and demos: never the real ones).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Desktop's profile folders on this machine.
export function desktopRoots(env = process.env) {
  if (env.AGENTBOOK_DESKTOP_DIRS != null) return env.AGENTBOOK_DESKTOP_DIRS.split(path.delimiter).filter(Boolean);
  const base = process.platform === "darwin" ? path.join(os.homedir(), "Library", "Application Support") : process.platform === "win32" ? env.APPDATA : null;
  if (!base) return [];
  return [path.join(base, "Claude"), ...subdirs(path.join(base, "Claude Profiles"))];
}

const subdirs = (dir) => {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
};

const ID = /^[\w.-]{1,120}$/; // a Claude Code session id (a UUID), or a test's

// The Claude Code sessions another Desktop session started: session id -> { from: the session ids of the one that
// started it (its first, then where a resume took it), task, title }. A record half written, or not one, is passed by.
export async function desktopStarts(roots = desktopRoots()) {
  const out = new Map();
  for (const root of roots) {
    for (const account of subdirs(path.join(root, "claude-code-sessions"))) {
      for (const org of subdirs(account)) {
        const recs = new Map(); // Desktop's id -> its record, in this account and organization
        let names = [];
        try {
          names = (await fs.promises.readdir(org)).filter((n) => /^local_[0-9a-f-]+\.json$/i.test(n));
        } catch {}
        for (const n of names) {
          try {
            const r = JSON.parse(await fs.promises.readFile(path.join(org, n), "utf8"));
            if (r && typeof r.sessionId === "string") recs.set(r.sessionId, r);
          } catch {}
        }
        for (const r of recs.values()) {
          const parent = r.spawnedFrom?.sessionId && recs.get(r.spawnedFrom.sessionId);
          const from = sessionsOf(parent);
          if (!from.length) continue;
          for (const sid of sessionsOf(r)) if (!from.includes(sid)) out.set(sid, { from, task: str(r.spawnedFrom.taskId), title: str(r.spawnedFrom.title) });
        }
      }
    }
  }
  return out;
}

const sessionsOf = (r) => [...new Set([r?.cliSessionId, r?.lastAssistantCliSessionId].filter((x) => typeof x === "string" && ID.test(x)))];
const str = (x) => (typeof x === "string" ? x.slice(0, 200) : null);
