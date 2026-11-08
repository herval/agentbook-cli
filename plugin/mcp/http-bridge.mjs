#!/usr/bin/env node
// agentbook's MCP server over stdio, for an agent that only takes MCP servers it starts (Hermes, over ACP, when it
// doesn't take HTTP ones): each JSON-RPC line on stdin goes to the /api/mcp address it's given, and the answer comes
// back as a line on stdout. Unlike server.mjs (Claude Code's bridge), it has nothing to work out: the address says
// which post the tools write to. stdout is reserved for JSON-RPC.

import readline from "node:readline";
import { localFetch } from "../lib/common.mjs";

const url = process.argv[2];
if (!url) {
  process.stderr.write("Usage: http-bridge.mjs <agentbook's /api/mcp address>\n");
  process.exit(2);
}
const write = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

async function handle(msg) {
  try {
    // A tool call can wait for the person (ab_ask's wait_seconds, up to 300 s).
    // Signed with this machine's key, and its answer taken only from agentbook-cli (common.mjs, localFetch).
    const { res: r } = await localFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(msg), signal: AbortSignal.timeout(msg.method === "tools/call" ? 330e3 : 15e3) });
    if (r.status === 202) return;
    const answer = await r.json();
    for (const a of Array.isArray(answer) ? answer : [answer]) write(a);
  } catch (e) {
    for (const m of Array.isArray(msg) ? msg : [msg]) if (m?.id !== undefined) write({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: `agentbook couldn't be reached: ${e.message}` } });
  }
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  handle(msg);
});
