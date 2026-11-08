#!/usr/bin/env node
// agentbook's own WebSocket client (WebSocketClient in plugin/cli/drivers/ws.mjs), which OpenClaw's gateway
// connection uses, against a server written here by hand: over ws:// and wss:// (a certificate made with openssl,
// trusted through NODE_EXTRA_CA_CERTS in a child process, and refused without it), a message in pieces with a ping
// between them, one of 8 MB, the server closing, a refused connection. And that it never offers to compress.
// Run: node test/ws-client.mjs

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { execFileSync, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const WS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "plugin", "cli", "drivers", "ws.mjs");
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// The child: connects to the address it's given, says each line of `SAY` once open, and prints what happened as
// JSON lines (open, message, error, close), then exits once closed.
if (process.argv[2] === "child") {
  const { WebSocketClient } = await import(WS);
  const ws = new WebSocketClient(process.argv[3]);
  const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
  ws.onopen = () => {
    out({ open: true });
    for (const l of JSON.parse(process.env.SAY || "[]")) ws.send(l);
  };
  ws.onmessage = (m) => {
    out({ message: m.data.length > 200 ? { length: m.data.length, head: m.data.slice(0, 20), tail: m.data.slice(-5) } : m.data });
    if (m.data === "bye?") ws.close(1000, "done");
  };
  ws.onerror = (e) => out({ error: e.message });
  ws.onclose = (e) => {
    out({ close: { code: e.code, wasClean: e.wasClean } });
    process.exit(0);
  };
  setTimeout(() => process.exit(3), 20000);
} else {
  let failures = 0;
  const check = (cond, label, extra = "") => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${label}${!cond && extra ? `  [${extra}]` : ""}`);
    if (!cond) failures++;
  };

  // ---------- the server ----------
  const serverFrame = (op, data, fin = true) => {
    const n = data.length;
    const b0 = (fin ? 0x80 : 0) | op;
    const head = n < 126 ? Buffer.from([b0, n]) : n < 65536 ? Buffer.from([b0, 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([b0, 127]), (() => {
      const b = Buffer.alloc(8);
      b.writeBigUInt64BE(BigInt(n));
      return b;
    })()]);
    return Buffer.concat([head, data]);
  };
  const seen = { headers: [], unmasked: 0, closes: [] };
  function serve(sock) {
    let buf = Buffer.alloc(0);
    let open = false;
    sock.on("error", () => {});
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (!open) {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        const lines = buf.subarray(0, end).toString("latin1").split("\r\n");
        buf = buf.subarray(end + 4);
        const headers = Object.fromEntries(lines.slice(1).map((l) => [l.slice(0, l.indexOf(":")).toLowerCase(), l.slice(l.indexOf(":") + 1).trim()]));
        seen.headers.push(headers);
        const accept = crypto.createHash("sha1").update(headers["sec-websocket-key"] + GUID).digest("base64");
        sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        open = true;
      }
      while (buf.length >= 6) {
        const op = buf[0] & 0x0f;
        if (!(buf[1] & 0x80)) seen.unmasked++;
        let len = buf[1] & 0x7f;
        let at = 2;
        if (len === 126) (len = buf.readUInt16BE(2)), (at = 4);
        else if (len === 127) (len = Number(buf.readBigUInt64BE(2))), (at = 10);
        if (buf.length < at + 4 + len) return;
        const mask = buf.subarray(at, at + 4);
        const data = Buffer.from(buf.subarray(at + 4, at + 4 + len));
        for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
        buf = buf.subarray(at + 4 + len);
        if (op === 0x8) {
          seen.closes.push(data.length >= 2 ? data.readUInt16BE(0) : 1005);
          sock.end(serverFrame(0x8, data.subarray(0, 2)));
          return;
        }
        // The ping's answer: said back, and then the server closes, with a code of its own.
        if (op === 0xa) {
          sock.write(serverFrame(0x1, Buffer.from(`pong ${data}`)));
          sock.end(serverFrame(0x8, Buffer.from([0x0f, 0xa1, ...Buffer.from("bye")])));
          return;
        }
        const text = data.toString();
        if (text.startsWith("echo:")) sock.write(serverFrame(0x1, Buffer.from(text.slice(5))));
        // In three pieces, a ping between the first two, all in one write: the client takes them apart.
        else if (text === "pieces") sock.write(Buffer.concat([serverFrame(0x1, Buffer.from("hel"), false), serverFrame(0x9, Buffer.from("p1")), serverFrame(0x0, Buffer.from("lo wor"), false), serverFrame(0x0, Buffer.from("ld"))]));
        // 8 MB, written a little at a time.
        else if (text === "big") {
          const all = serverFrame(0x1, Buffer.from(`start${"b".repeat(8 << 20)}end!!`));
          for (let i = 0; i < all.length; i += 1 << 16) sock.write(all.subarray(i, i + (1 << 16)));
        } else if (text === "ask") sock.write(serverFrame(0x1, Buffer.from("bye?")));
      }
    });
  }
  const listen = (server) => new Promise((r) => server.listen(0, "127.0.0.1", () => r(server.address().port)));
  const plain = net.createServer(serve);
  const PORT = await listen(plain);

  const run = (address, say, env = {}) =>
    new Promise((resolve) => {
      execFile(process.execPath, [fileURLToPath(import.meta.url), "child", address], { env: { ...process.env, ...env, SAY: JSON.stringify(say) }, timeout: 30000, maxBuffer: 16 << 20 }, (err, stdout) => {
        resolve({ err, events: stdout.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) });
      });
    });
  const messages = (r) => r.events.filter((e) => "message" in e).map((e) => e.message);
  const closed = (r) => r.events.find((e) => e.close)?.close;

  // ---------- ws:// ----------
  let r = await run(`ws://127.0.0.1:${PORT}/some/path?x=1`, ["echo:hi there", "pieces"]);
  check(r.events[0]?.open, "it opens");
  check(messages(r)[0] === "hi there", "a message comes back", JSON.stringify(r.events));
  check(messages(r)[1] === "hello world", "one sent in pieces comes whole, a ping between them notwithstanding");
  check(messages(r)[2] === "pong p1", "and the ping between them was answered");
  check(closed(r)?.code === 4001 && closed(r)?.wasClean, "then the server's close comes, with its code", JSON.stringify(closed(r)));
  const h = seen.headers[0] || {};
  check(h.upgrade === "websocket" && h["sec-websocket-version"] === "13" && h.host === `127.0.0.1:${PORT}`, "the upgrade is asked for as it should be", JSON.stringify(h));
  check(!("sec-websocket-extensions" in h), "and it doesn't offer to compress");
  check(seen.unmasked === 0, "what it sends is masked, as a client's must be");

  r = await run(`ws://127.0.0.1:${PORT}`, ["big"]);
  const big = messages(r)[0];
  check(big?.length === (8 << 20) + 10 && big.head.startsWith("startbbb") && big.tail === "end!!", "a message of 8 MB comes whole", JSON.stringify(r.events).slice(0, 300));

  r = await run(`ws://127.0.0.1:${PORT}`, ["ask"]);
  check(messages(r)[0] === "bye?" && closed(r)?.code === 1000 && closed(r)?.wasClean && seen.closes.at(-1) === 1000, "it closes when asked to, and the server hears its code", JSON.stringify(r.events));

  const gone = await new Promise((res) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
  r = await run(`ws://127.0.0.1:${gone}`, []);
  check(r.events[0]?.error && closed(r)?.code === 1006 && !closed(r)?.wasClean && !r.events.some((e) => e.open), "a refused connection is an error, then a close", JSON.stringify(r.events));

  // ---------- wss:// ----------
  let haveOpenssl = true;
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
  } catch {
    haveOpenssl = false;
  }
  if (!haveOpenssl) console.log("SKIP  wss://: no openssl here to make a certificate");
  else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-wsclient-"));
    const key = path.join(dir, "key.pem");
    const cert = path.join(dir, "cert.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" });
    const secure = tls.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert), ALPNProtocols: ["http/1.1"] }, serve);
    const SPORT = await listen(secure);
    r = await run(`wss://localhost:${SPORT}`, ["echo:over tls", "pieces"], { NODE_EXTRA_CA_CERTS: cert });
    check(messages(r)[0] === "over tls" && messages(r)[1] === "hello world" && closed(r)?.code === 4001, "over wss:// too, by name", JSON.stringify(r.events));
    r = await run(`wss://127.0.0.1:${SPORT}`, ["echo:by ip"], { NODE_EXTRA_CA_CERTS: cert });
    check(messages(r)[0] === "by ip", "and by address", JSON.stringify(r.events));
    r = await run(`wss://localhost:${SPORT}`, ["echo:should not"], {});
    check(r.events[0]?.error && !r.events.some((e) => e.open) && closed(r)?.code === 1006, "a certificate nothing vouches for is refused", JSON.stringify(r.events));
    secure.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  plain.close();
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
}
