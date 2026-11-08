// The process a code routine runs in (routines.mjs starts it, one per run). It runs under Node's
// permission model, allowed to read only this file and the routine's own code: it can't run commands, write
// files, or read Claude Code's config. What it needs from outside, it asks agentbook for over IPC, and agentbook
// checks each call against what the routine may reach: ctx.tool (an MCP tool) and ctx.sh (a command).
//
// It gets { file, page, memo, last, now, tz }, and a live run (its page is open) also { filters, ranges, params,
// live }; it imports the code, calls its default export with ctx, and sends back what it returned, its memo, and
// what it logged.

import { pathToFileURL } from "node:url";

const LOG_MAX = 8 * 1024;
const pending = new Map();
let n = 0;
let logged = "";

const text = (x) => {
  if (typeof x === "string") return x;
  if (x instanceof Error) return x.stack || x.message;
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
};
function log(...args) {
  if (logged.length >= LOG_MAX) return;
  logged = (logged + args.map(text).join(" ") + "\n").slice(0, LOG_MAX);
}
console.log = console.info = console.warn = console.error = console.debug = log;

const ask = (type, body) =>
  new Promise((resolve, reject) => {
    const id = ++n;
    pending.set(id, { resolve, reject });
    process.send({ type, id, ...body });
  });

const finish = (msg) => process.send(msg, () => process.disconnect());

process.on("message", async (m) => {
  if (m?.type === "reply") {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (p) m.error ? p.reject(new Error(m.error)) : p.resolve(m.value);
    return;
  }
  if (m?.type !== "run") return;
  const ctx = {
    page: m.page || {},
    memo: m.memo && typeof m.memo === "object" ? m.memo : {},
    last: m.last || null,
    now: new Date(m.now),
    tz: m.tz,
    // A live run's inputs: the filters picked on its page ({ service: "erp-sync", when: "7d" }), a time filter's
    // period as dates ({ when: { from, to } }), and what a widget of its own asked with (agentbook.query).
    live: !!m.live,
    filters: m.filters || {},
    ranges: m.ranges || {},
    params: m.params || {},
    log,
    // An MCP tool on a server from Claude Code's config: { text, data } (data: the answer read as JSON or TOON).
    tool: (server, tool, args = {}) => ask("tool", { server: String(server), tool: String(tool), args }),
    // A command, with no shell: { stdout, stderr, code }.
    sh: (command, args = [], opts = {}) => ask("sh", { command: String(command), args: (Array.isArray(args) ? args : [args]).map(String), timeout: opts.timeout }),
  };
  try {
    const mod = await import(pathToFileURL(m.file).href);
    if (typeof mod.default !== "function") throw new Error("The code has no default export. It should be: export default async function (ctx) { … return { widgets: [...] } }");
    const out = await mod.default(ctx);
    finish({ type: "done", out: out ?? null, memo: ctx.memo, log: logged });
  } catch (e) {
    // The message is what failed; where it failed goes in its log.
    if (e?.stack) log(e.stack);
    finish({ type: "fail", error: e?.message || String(e), log: logged });
  }
});
