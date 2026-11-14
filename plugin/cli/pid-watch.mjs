// Whether a Claude Code session's process went without saying so: killed, or its machine restarted under it (a
// stopped cloud sandbox), so no SessionEnd came. A session's pid counts as its own once this machine saw that process
// run, with when it started: kept in cli/pids.json, so that holds across a restart of agentbook-cli. It's gone once
// that pid isn't running, or a process that started at another time has it. For a session from before anything was
// kept, only what can't be otherwise counts: this machine started after it last said anything, or it ran on a
// machine of another name and its pid doesn't run here. A pid that never ran (a test's) is never taken for gone.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function createPidWatch({ home, hostname = () => os.hostname().split(".")[0], bootedAt = () => Date.now() - os.uptime() * 1000 }) {
  const file = path.join(home, "cli", "pids.json");
  let seen = {};
  try {
    seen = JSON.parse(fs.readFileSync(file, "utf8")) || {};
  } catch {}
  const save = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(seen));
      fs.renameSync(`${file}.tmp`, file);
    } catch {}
  };
  const running = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return e.code === "EPERM";
    }
  };
  // When a process started, to the second, as ps says; null when it doesn't run.
  const startOf = (pid) => new Promise((resolve) => execFile("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 3000 }, (e, out) => resolve(e ? null : Date.parse(String(out).trim()) || null)));

  return {
    // A session said hello from its process (`post`: its thread): kept as its own, if it runs here.
    async saw(post, pid) {
      pid = Number(pid);
      if (!post || !pid || !running(pid)) return;
      const start = await startOf(pid);
      if (!start || (seen[post]?.pid === pid && seen[post]?.start === start)) return;
      seen[post] = { pid, start };
      save();
    },
    // Whether the process of `s` (its session record) is gone.
    async gone(s) {
      const pid = Number(s?.pid);
      if (!pid) return false;
      const kept = seen[s.id];
      if (kept?.pid === pid) {
        if (!running(pid)) return true;
        const start = await startOf(pid);
        return !!start && start !== kept.start;
      }
      if (bootedAt() > Date.parse(s.updated || s.started)) return true;
      return !!s.host && s.host !== hostname() && !running(pid);
    },
    // What's kept of the threads that aren't open any more goes (`open`: ids of those that are).
    keepOnly(open) {
      const ids = new Set(open);
      const gone = Object.keys(seen).filter((id) => !ids.has(id));
      for (const id of gone) delete seen[id];
      if (gone.length) save();
    },
  };
}
