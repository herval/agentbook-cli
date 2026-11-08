// Calling MCP tools from agentbook itself, for routines (routines.mjs): a routine's code calls the same
// tools its agent used, on the same servers, with the same credentials, without a model in between.
//
// The servers are the ones Claude Code is set up with on this machine, read from its config as it reads them:
// ~/.claude.json's own (user scope), the page's folder's there (local scope), and that folder's .mcp.json
// (project scope), the nearer one winning. `${VAR}` and `${VAR:-default}` in them are filled from the
// environment. With CLAUDE_CONFIG_DIR set (tests, demos), its .claude.json is read instead of ~/.claude.json.
//
// Streamable HTTP servers only for now: each request is a POST, and the answer comes back as JSON or as an SSE
// stream. A server's session (mcp-session-id) is kept between calls and started again when it lapses.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PROTOCOL = "2025-06-18";
const CALL_MS = 60e3;

const configFile = () => path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), ".claude.json");
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
const expand = (v) =>
  typeof v === "string"
    ? v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, dflt) => process.env[name] ?? dflt ?? "")
    : Array.isArray(v)
      ? v.map(expand)
      : v && typeof v === "object"
        ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expand(x)]))
        : v;

// The MCP servers a routine on a page in `root` can reach, by name: { type, url, headers } or { command, ... }.
export function mcpServers(root) {
  const cfg = readJson(configFile()) || {};
  const local = (root && cfg.projects?.[root]?.mcpServers) || {};
  const project = (root && readJson(path.join(root, ".mcp.json"))?.mcpServers) || {};
  return expand({ ...(cfg.mcpServers || {}), ...project, ...local });
}

// What a server is, in words, for an error that says why it can't be reached.
const transport = (s) => s.type || (s.url ? "http" : s.command ? "stdio" : "unknown");

export function createMcp() {
  const clients = new Map(); // name -> { key, client }

  function clientFor(name, root) {
    const s = mcpServers(root)[name];
    if (!s) throw new Error(`There's no MCP server "${name}" in Claude Code's config on this machine.`);
    if (transport(s) !== "http") throw new Error(`"${name}" is a ${transport(s)} MCP server. Routines reach HTTP ones for now.`);
    const key = JSON.stringify(s);
    const had = clients.get(name);
    if (had?.key === key) return had.client;
    const client = httpClient(name, s);
    clients.set(name, { key, client });
    return client;
  }

  return {
    // A tool's answer: { text, isError, structured }.
    async call(server, tool, args, { root, timeout = CALL_MS } = {}) {
      return clientFor(server, root).call(tool, args, timeout);
    },
    async tools(server, { root } = {}) {
      return clientFor(server, root).tools();
    },
  };
}

function httpClient(name, s) {
  let session = null;
  let ready = null;
  let n = 0;

  async function rpc(method, params, timeout, notify = false) {
    const id = notify ? undefined : ++n;
    const r = await fetch(s.url, {
      method: "POST",
      headers: { ...(s.headers || {}), "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": PROTOCOL, ...(session ? { "mcp-session-id": session } : {}) },
      body: JSON.stringify(notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(timeout),
    });
    session = r.headers.get("mcp-session-id") || session;
    const body = await r.text();
    if (notify) return null;
    if (r.status === 404 && session) throw Object.assign(new Error("session lapsed"), { lapsed: true });
    if (!r.ok) throw new Error(`${name} answered ${r.status}${body ? `: ${body.trim().slice(0, 200)}` : ""}`);
    const msg = (r.headers.get("content-type") || "").includes("event-stream") ? fromStream(body, id) : JSON.parse(body);
    if (!msg) throw new Error(`${name} didn't answer.`);
    if (msg.error) throw new Error(`${name}: ${msg.error.message || JSON.stringify(msg.error)}`);
    return msg.result;
  }

  function start(timeout) {
    ready ||= (async () => {
      session = null;
      await rpc("initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "agentbook-routines", version: "0.1.0" } }, timeout);
      await rpc("notifications/initialized", {}, timeout, true);
    })().catch((e) => {
      ready = null;
      throw e;
    });
    return ready;
  }

  async function withSession(fn, timeout) {
    await start(timeout);
    try {
      return await fn();
    } catch (e) {
      if (!e.lapsed) throw e;
      ready = null;
      await start(timeout);
      return fn();
    }
  }

  return {
    async call(tool, args, timeout) {
      const res = await withSession(() => rpc("tools/call", { name: tool, arguments: args || {} }, timeout), timeout);
      const text = (res?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
      return { text, isError: !!res?.isError, structured: res?.structuredContent ?? null };
    },
    async tools() {
      const res = await withSession(() => rpc("tools/list", {}, CALL_MS), CALL_MS);
      return (res?.tools || []).map((t) => ({ name: t.name, description: t.description || "", readOnly: !!t.annotations?.readOnlyHint }));
    },
  };
}

// The JSON-RPC answer with this id in an SSE stream.
function fromStream(body, id) {
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data) continue;
    try {
      const msg = JSON.parse(data);
      if (msg.id === id && (msg.result !== undefined || msg.error)) return msg;
    } catch {}
  }
  return null;
}
