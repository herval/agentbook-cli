// agentbook's plugin for OpenClaw: agentbook's tools (ab_post, ab_update, ab_ask…) for the agents on this gateway,
// answered by the agentbook connected to it as an operator (plugin/cli/drivers/openclaw.mjs). An MCP server set in
// OpenClaw's config can't do this: a call to one doesn't say which session made it, and agentbook answers only on
// its own machine. A plugin's tool knows its session (ctx.sessionKey), and the call goes to agentbook over the
// connection agentbook already keeps to the gateway:
//
// - agentbook says hello (agentbook.hello) each time it connects: the tools it has for the agents it follows, and
//   what to tell them about agentbook. Until one has, and once the last one's connection ends, there are no tools.
// - An agent calls one: the plugin rings agentbook (the event plugin.agentbook.call, with only the call's id, since
//   an event holds 256 KB at most), agentbook takes the call (agentbook.take: which session, which tool, what with),
//   reads the files it names (agentbook.read, a piece at a time: they're on this machine, not agentbook's), and
//   answers (agentbook.done). When more than one agentbook is connected, the first to take a call answers it.
// - Each session's agent is told it's a thread on agentbook (before_prompt_build), as agentbook tells the agents it
//   starts. Not cron runs or subagents, which get no tools either: a job's run has nobody there to answer it, and
//   what it reports reaches its thread without them. A subagent's isn't a thread.
//
// Install it on the gateway's machine with `openclaw plugins install <this folder> --force`, let it tell agents about
// agentbook (`openclaw config set plugins.entries.agentbook.hooks.allowConversationAccess true`: OpenClaw keeps a
// plugin's hooks out of conversations until you do; the tools work without it), then `openclaw gateway restart`.
// It needs nothing from OpenClaw's SDK, and no packages.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";

const MANIFEST = JSON.parse(fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"));
const VERSION = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
// The tools it can have: OpenClaw wants each one named in the manifest. One agentbook adds later waits for the next
// version of the plugin; agentbook's hello hears which these are.
const NAMES = MANIFEST.contracts.tools;
const TAKE_MS = 15000; // how long agentbook has to take a call
const DONE_MS = 360e3; // and to answer it, once taken (ab_ask can wait 5 minutes for the person)
const PIECE = 2 << 20; // the most of a file one agentbook.read hands over: Node 22, which agentbook runs on, drops a
// WebSocket whose message unpacks to 4 MB or more (base64 makes 2 MB 2.7)
const SCOPE = "operator.write";
// Sessions that aren't told about agentbook.
const offThread = (key) => !key || /:(cron|subagent):/.test(key);
const label = (name) => `agentbook: ${name.replace(/^ab_/, "").replace(/_/g, " ")}`;

export default {
  id: MANIFEST.id,
  name: MANIFEST.name,
  description: MANIFEST.description,
  version: VERSION,
  register(api) {
    const log = api.logger || console;
    // OpenClaw loads a plugin more than once in a gateway, each a register() of its own: in full (its service and
    // methods, which hear agentbook), for discovery (whose hooks are the ones an agent's turn runs, on 2026.9.4),
    // and to list and run tools ("tool-discovery"). So what agentbook said and the calls it's answering are kept for
    // the whole process, as OpenClaw keeps its plugins' runtimes, and the tools and the hook are in every load.
    const shared = (globalThis[Symbol.for("agentbook.openclaw-plugin")] ??= { events: null, links: new Map(), calls: new Map() });
    const { links, calls } = shared; // links: connection id -> { tools: Map(name -> tool), instructions, at }, each agentbook connected; calls: call id -> { sessionKey, agentId, tool, args, cwd, by, timer, resolve, reject }
    const full = !api.registrationMode || api.registrationMode === "full";

    // What the agentbook that said hello last has.
    const current = () => [...links.values()].sort((a, b) => b.at - a.at)[0] || null;
    const refuse = (respond, message) => respond(false, undefined, { code: "INVALID_REQUEST", message });
    function end(id, error, result) {
      const c = calls.get(id);
      if (!c) return;
      calls.delete(id);
      clearTimeout(c.timer);
      if (error) c.reject(new Error(error));
      else c.resolve(result);
    }

    // The tools, for a session agentbook shows as a thread, as the agentbook connected last has them.
    api.registerTool(
      (ctx) => {
        const link = current();
        if (!link || offThread(ctx?.sessionKey)) return null;
        return NAMES.filter((name) => link.tools.has(name)).map((name) => {
          const t = link.tools.get(name);
          return {
            name,
            label: label(name),
            description: String(t.description || ""),
            parameters: t.inputSchema || { type: "object", properties: {} },
            execute: (_id, params, signal) => relay({ sessionKey: ctx.sessionKey, agentId: ctx.agentId || null, cwd: ctx.workspaceDir || null, tool: name, args: params || {}, signal }),
          };
        });
      },
      { names: NAMES },
    );

    api.on?.("before_prompt_build", (_event, ctx) => {
      const link = current();
      if (!link?.instructions || offThread(ctx?.sessionKey)) return;
      return { appendSystemContext: link.instructions };
    });
    if (!full) return; // the rest is the full load's

    let mine = null; // the events this load's service was given
    api.registerService({
      id: "agentbook",
      start(ctx) {
        mine = shared.events = ctx.gatewayEvents || null;
        if (!mine) log.warn?.("agentbook: this gateway gives plugins no events, so agentbook can't hear its tools being called");
      },
      stop() {
        if (!mine || shared.events !== mine) return;
        shared.events = mine = null;
        for (const id of [...calls.keys()]) end(id, "The gateway is stopping.");
      },
    });

    // agentbook, connected: its tools ({ name, description, inputSchema }, as its MCP server lists them) and what to
    // tell agents about it. Said again on each connection, which counts until it ends.
    api.registerGatewayMethod(
      "agentbook.hello",
      ({ params, client, respond }) => {
        const conn = client?.connId || `conn-${crypto.randomUUID()}`;
        const tools = new Map((Array.isArray(params.tools) ? params.tools : []).filter((t) => NAMES.includes(t?.name)).map((t) => [t.name, t]));
        const known = links.has(conn);
        links.set(conn, { tools, instructions: typeof params.instructions === "string" ? params.instructions : "", at: Date.now() });
        if (!known)
          client?.connectionSignal?.addEventListener?.("abort", () => {
            links.delete(conn);
            for (const [id, c] of calls) if (c.by === conn || (!c.by && !links.size)) end(id, "agentbook disconnected before it answered.");
          });
        respond(true, { plugin: VERSION, tools: NAMES });
      },
      { scope: SCOPE },
    );

    // A call agentbook was rung about: what it is. Only one agentbook gets it.
    api.registerGatewayMethod(
      "agentbook.take",
      ({ params, client, respond }) => {
        const c = calls.get(String(params.id));
        if (!c || c.by) return refuse(respond, "No such call: it ended, or another agentbook took it.");
        c.by = client?.connId || "agentbook";
        clearTimeout(c.timer);
        c.timer = setTimeout(() => end(String(params.id), "agentbook took too long to answer."), DONE_MS);
        respond(true, { sessionKey: c.sessionKey, agentId: c.agentId, tool: c.tool, args: c.args, cwd: c.cwd, home: os.homedir() });
      },
      { scope: SCOPE },
    );

    // A piece of a file on this machine that a call names (ab_file's path, a picture in a note), for the agentbook
    // that took the call, while it's answering it: { size, file, data } (base64, from `offset`, `length` bytes at
    // most). Anything else isn't the plugin's to hand over.
    api.registerGatewayMethod(
      "agentbook.read",
      ({ params, client, respond }) => {
        const c = calls.get(String(params.id));
        if (!c || c.by !== (client?.connId || "agentbook")) return refuse(respond, "That call isn't yours to answer.");
        const where = String(params.path || "");
        if (!where.startsWith("/")) return refuse(respond, "Give the file's full path.");
        let st = null;
        try {
          st = fs.statSync(where);
        } catch {}
        if (!st?.isFile()) return respond(true, { size: 0, file: false });
        const offset = Math.max(0, Math.floor(Number(params.offset) || 0));
        const length = Math.min(PIECE, Math.max(0, Math.floor(Number(params.length ?? PIECE) || 0)), Math.max(0, st.size - offset));
        let data = "";
        if (length) {
          const buf = Buffer.alloc(length);
          const fd = fs.openSync(where, "r");
          try {
            data = buf.subarray(0, fs.readSync(fd, buf, 0, length, offset)).toString("base64");
          } finally {
            fs.closeSync(fd);
          }
        }
        respond(true, { size: st.size, file: true, data });
      },
      { scope: SCOPE },
    );

    // agentbook's answer: what its MCP server's tools/call says ({ content, isError }).
    api.registerGatewayMethod(
      "agentbook.done",
      ({ params, client, respond }) => {
        const id = String(params.id);
        const c = calls.get(id);
        if (!c || c.by !== (client?.connId || "agentbook")) return refuse(respond, "That call isn't yours to answer.");
        const r = params.result || {};
        const content = (Array.isArray(r.content) ? r.content : []).filter((x) => x?.type === "text" || x?.type === "image");
        if (r.isError) end(id, content.map((x) => x.text || "").join("\n").trim() || "agentbook couldn't do it.");
        else end(id, null, { content: content.length ? content : [{ type: "text", text: "Done." }], details: {} });
        respond(true, {});
      },
      { scope: SCOPE },
    );

    function relay({ sessionKey, agentId, cwd, tool, args, signal }) {
      const events = shared.events;
      if (!events) return Promise.reject(new Error("agentbook's plugin isn't running on this gateway: restart the gateway."));
      if (!links.size) return Promise.reject(new Error("agentbook isn't connected to this gateway."));
      const id = crypto.randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => end(id, "agentbook didn't pick up the call: is it running, and connected to this gateway?"), TAKE_MS);
        calls.set(id, { sessionKey, agentId, tool, args, cwd, by: null, timer, resolve, reject });
        signal?.addEventListener?.("abort", () => end(id, "Stopped."), { once: true });
        try {
          events.emit("call", { id, tool }, { scope: SCOPE });
        } catch (e) {
          end(id, `agentbook's plugin couldn't ring agentbook: ${e.message}`);
        }
      });
    }
  },
};
