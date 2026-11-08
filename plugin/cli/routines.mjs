// Page routines, run: a routine's code is a child process on this machine, under Node's permission model, that
// reaches only the MCP tools and commands its reach names (plugin/shared/routines.mjs says what a routine is).

import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMcp } from "./mcp-client.mjs";
import { toolData } from "./toon.mjs";
import { reachFrom, reachText, TIMEOUT_MAX_MS, TIMEOUT_MS } from "../shared/routines.mjs";

export * from "../shared/routines.mjs";

const RUNNER = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "routine-runner.mjs"));
const str = (v, max) => (v == null ? "" : String(v).slice(0, max));

/* ---------- running them ---------- */

const hash = (s) => createHash("sha1").update(s).digest("hex").slice(0, 16);

// The runner: a routine's code, once, as a child process under Node's permission model, reaching only the MCP
// tools and commands its reach names. What it returned comes back as it is, with its log: the server checks it
// against the page (checkRun) and writes it.
export function createRoutineRunner({ home, log = () => {} }) {
  const mcp = createMcp();
  const dir = path.join(home, "cli", "routine-code");

  // A live run (its page is open) also gets what's picked on the page: { filters, ranges, params, live }.
  async function execute({ rid, code, reach, memo, last, timeout, widgets = {}, root = null, filters = null, ranges = null, params = null, live = false }) {
    const started = Date.now();
    fs.mkdirSync(path.join(dir, rid || "new"), { recursive: true });
    // Its real path: the permission model allows exactly the path it's given, and /tmp, /var… are symlinks.
    const file = path.join(fs.realpathSync(path.join(dir, rid || "new")), `${hash(code)}.mjs`);
    fs.writeFileSync(file, code);
    const allowed = reachFrom(reach);
    const result = await new Promise((resolve) => {
      const env = { PATH: process.env.PATH || "/usr/bin:/bin", HOME: process.env.HOME || "", LANG: process.env.LANG || "en_US.UTF-8", TZ: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone };
      const child = spawn(process.execPath, ["--permission", "--no-warnings", `--allow-fs-read=${RUNNER}`, `--allow-fs-read=${file}`, "--max-old-space-size=256", RUNNER], { stdio: ["ignore", "ignore", "pipe", "ipc"], env, cwd: path.dirname(file) });
      let stderr = "";
      let done = null;
      const end = (x) => {
        if (done) return;
        done = x;
        clearTimeout(timer);
        try {
          child.kill("SIGKILL");
        } catch {}
        resolve(x);
      };
      const ms = Math.min(TIMEOUT_MAX_MS, timeout || TIMEOUT_MS);
      const timer = setTimeout(() => end({ ok: false, error: `It took longer than ${Math.round(ms / 1000)} s, so it was stopped.` }), ms);
      child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-4000)));
      child.on("error", (e) => end({ ok: false, error: `It couldn't start: ${e.message}` }));
      // Its last message can come in just after it exits.
      child.on("exit", (code, signal) => setTimeout(() => end({ ok: false, error: `It stopped before it returned (${signal || `exit code ${code}`}).${stderr.trim() ? `\n${stderr.trim().split("\n").slice(-6).join("\n")}` : ""}` }), 100));
      child.on("message", async (m) => {
        if (m.type === "done") return end({ ok: true, out: m.out, memo: m.memo, log: m.log });
        if (m.type === "fail") return end({ ok: false, error: m.error, log: m.log });
        const reply = (value, error) => child.connected && child.send({ type: "reply", id: m.id, ...(error ? { error } : { value }) });
        try {
          if (m.type === "tool") {
            if (!allowed.tools.includes(`${m.server}/${m.tool}`)) throw new Error(`It may not call ${m.server}/${m.tool}: that's not in its reach (${reachText(allowed)}).`);
            const r = await mcp.call(m.server, m.tool, m.args, { root, timeout: Math.max(5e3, ms - (Date.now() - started)) });
            if (r.isError) throw new Error(`${m.tool}: ${r.text.slice(0, 500)}`);
            return reply({ text: r.text, data: r.structured ?? toolData(r.text) });
          }
          if (m.type === "sh") {
            const name = path.basename(m.command);
            if (!allowed.commands.includes(name) || name !== m.command) throw new Error(`It may not run ${m.command}: that's not in its reach (${reachText(allowed)}).`);
            // The same scrubbed env the routine's own child gets: a command it reaches never sees the daemon's
            // environment (AGENTBOOK_SECRET_KEY, cloud tokens, …).
            const out = await new Promise((res) => execFile(m.command, m.args || [], { cwd: root, env, timeout: Math.min(120e3, Number(m.timeout) * 1000 || 30e3), maxBuffer: 5 * 1024 * 1024 }, (e, stdout, stderr) => res({ stdout: String(stdout), stderr: String(stderr), code: e ? (typeof e.code === "number" ? e.code : 1) : 0 })));
            return reply(out);
          }
          throw new Error(`Unknown request ${m.type}.`);
        } catch (e) {
          reply(null, e.message);
        }
      });
      child.send({ type: "run", file, page: widgets, memo: memo || {}, last, now: Date.now(), tz: env.TZ, ...(live ? { filters: filters || {}, ranges: ranges || {}, params: params || {}, live: true } : {}) });
    });
    const ms = Date.now() - started;
    if (!result.ok) return { ok: false, ms, error: str(result.error, 2000), log: result.log || "" };
    return { ok: true, ms, log: result.log || "", out: result.out ?? null, memo: result.memo };
  }

  return { execute };
}
