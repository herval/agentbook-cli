// WebSocket clients, with zero dependencies like the rest of agentbook: connectWs, over a unix socket, enough for
// Codex's app-server daemon (text messages, ping/pong, close); and WebSocketClient, for a ws:// or wss:// address,
// shaped like Node's own WebSocket (onopen, onmessage, onerror, onclose, send, close), which OpenClaw's gateway
// connection uses instead of Node's: Node 22's always offers to compress, and drops the connection (1006) when a
// compressed message unpacks to more than 4 MB, a limit nothing changes; OpenClaw's gateway compresses everything
// it sends past 4 KB, and a history can be 6 MB. This one doesn't offer, so the gateway sends messages whole.

import crypto from "node:crypto";
import net from "node:net";
import tls from "node:tls";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE = 256 << 20; // past this, a message is refused (1009), as a guard

// A client frame (masked, as a client's must be): `op` 0x1 text, 0x8 close, 0x9 ping, 0xa pong.
function clientFrame(payload, op) {
  const mask = crypto.randomBytes(4);
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | op, 0x80 | n]) : n < 65536 ? Buffer.from([0x80 | op, 0x80 | 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x80 | op, 0x80 | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
  const body = Buffer.from(payload);
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, body]);
}

export class WebSocketClient {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(address, { headers = {}, handshakeMs = 20000 } = {}) {
    const url = new URL(address);
    if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new SyntaxError(`Not a WebSocket address: ${address}`);
    this.url = url.toString();
    this.readyState = WebSocketClient.CONNECTING;
    this.onopen = this.onmessage = this.onerror = this.onclose = null;
    this.#key = crypto.randomBytes(16).toString("base64");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const port = Number(url.port) || (url.protocol === "wss:" ? 443 : 80);
    const sock = url.protocol === "wss:" ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, ALPNProtocols: ["http/1.1"] }) : net.connect({ host, port });
    this.#sock = sock;
    sock.setNoDelay?.(true);
    const lines = [`GET ${url.pathname || "/"}${url.search} HTTP/1.1`, `Host: ${url.host}`, "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Key: ${this.#key}`, "Sec-WebSocket-Version: 13", ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
    sock.once(url.protocol === "wss:" ? "secureConnect" : "connect", () => sock.write(`${lines.join("\r\n")}\r\n\r\n`));
    this.#handshake = setTimeout(() => this.#fail(1006, "The WebSocket handshake took too long"), handshakeMs);
    this.#handshake.unref?.();
    sock.on("data", (d) => this.#data(d));
    sock.on("error", (e) => this.#fail(1006, e.message));
    sock.on("close", () => this.#ended(1006, ""));
  }

  #sock;
  #key;
  #handshake;
  #chunks = []; // what's come in and isn't read yet
  #size = 0;
  #parts = []; // a message's frames so far
  #partsSize = 0;
  #partsOp = 0;
  #errored = false;
  #closeCode = null;

  send(text) {
    if (this.readyState === WebSocketClient.CONNECTING) throw new Error("The WebSocket isn't open yet");
    if (this.readyState !== WebSocketClient.OPEN) return;
    this.#sock.write(clientFrame(Buffer.from(String(text)), 0x1));
  }

  close(code = 1000, reason = "") {
    if (this.readyState === WebSocketClient.CLOSED || this.readyState === WebSocketClient.CLOSING) return;
    if (this.readyState === WebSocketClient.CONNECTING) return this.#fail(1006, "Closed before it opened");
    this.readyState = WebSocketClient.CLOSING;
    this.#closeCode = code;
    const why = Buffer.from(String(reason)).subarray(0, 123);
    const body = Buffer.alloc(2 + why.length);
    body.writeUInt16BE(code, 0);
    why.copy(body, 2);
    try {
      this.#sock.write(clientFrame(body, 0x8));
    } catch {}
    // The gateway answers with a close of its own, and ends the connection; if it doesn't, end it anyway.
    setTimeout(() => this.#sock.destroy(), 2000).unref?.();
  }

  // The first `n` bytes in, without taking them.
  #peek(n) {
    if (this.#chunks[0]?.length >= n) return this.#chunks[0];
    const b = Buffer.concat(this.#chunks);
    this.#chunks = [b];
    return b;
  }
  #take(n) {
    const b = this.#peek(n);
    const out = b.subarray(0, n);
    const rest = b.subarray(n);
    this.#chunks = rest.length ? [rest] : [];
    this.#size -= n;
    return out;
  }

  #data(d) {
    this.#chunks.push(d);
    this.#size += d.length;
    if (this.readyState === WebSocketClient.CONNECTING) {
      const head = this.#peek(this.#size);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return this.#size > 65536 && this.#fail(1006, "The WebSocket handshake's answer is too long");
      const lines = head.subarray(0, end).toString("latin1").split("\r\n");
      this.#take(end + 4);
      const field = (name) => lines.find((l) => l.toLowerCase().startsWith(`${name}:`))?.slice(name.length + 1).trim() || "";
      const accept = crypto.createHash("sha1").update(this.#key + GUID).digest("base64");
      if (!/^HTTP\/1\.1 101\b/.test(lines[0])) return this.#fail(1006, `The WebSocket upgrade was refused: ${lines[0]}`);
      if (field("sec-websocket-accept") !== accept) return this.#fail(1006, "The WebSocket upgrade's answer doesn't match");
      if (field("sec-websocket-extensions")) return this.#fail(1006, "The server turned on an extension this client didn't offer");
      clearTimeout(this.#handshake);
      this.readyState = WebSocketClient.OPEN;
      this.onopen?.({ type: "open" });
    }
    while (this.readyState !== WebSocketClient.CLOSED && this.#size >= 2) {
      const h = this.#peek(Math.min(this.#size, 14));
      const fin = h[0] & 0x80;
      const op = h[0] & 0x0f;
      if (h[0] & 0x70) return this.#fail(1002, "A frame used an extension this client didn't offer");
      let len = h[1] & 0x7f;
      let at = 2;
      if (len === 126) {
        if (h.length < 4) return;
        len = h.readUInt16BE(2);
        at = 4;
      } else if (len === 127) {
        if (h.length < 10) return;
        len = Number(h.readBigUInt64BE(2));
        at = 10;
      }
      const masked = h[1] & 0x80; // a server's frames aren't, but be lenient
      if (masked) at += 4;
      if (len > MAX_MESSAGE || this.#partsSize + len > MAX_MESSAGE) return this.#fail(1009, "A message was too big");
      if (this.#size < at + len) return;
      const frame = this.#take(at + len);
      let payload = frame.subarray(at);
      if (masked) {
        const mask = frame.subarray(at - 4, at);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      }
      if (op === 0x9) {
        if (this.readyState === WebSocketClient.OPEN) this.#sock.write(clientFrame(payload, 0xa));
      } else if (op === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        if (this.readyState === WebSocketClient.OPEN) {
          this.readyState = WebSocketClient.CLOSING;
          try {
            this.#sock.write(clientFrame(payload.subarray(0, 2), 0x8));
          } catch {}
        }
        this.#closeCode = code;
        this.#sock.end();
        return;
      } else if (op === 0x1 || op === 0x2 || op === 0x0) {
        if (op !== 0x0) this.#partsOp = op;
        this.#parts.push(payload);
        this.#partsSize += payload.length;
        if (fin) {
          const whole = this.#parts.length === 1 ? this.#parts[0] : Buffer.concat(this.#parts);
          const binary = this.#partsOp === 0x2;
          this.#parts = [];
          this.#partsSize = 0;
          if (this.readyState === WebSocketClient.OPEN) this.onmessage?.({ type: "message", data: binary ? whole : whole.toString("utf8") });
        }
      }
    }
  }

  // It couldn't connect, or broke: an error, then the close, as Node's WebSocket does.
  #fail(code, message) {
    if (this.readyState === WebSocketClient.CLOSED || this.#errored) return;
    this.#errored = true;
    clearTimeout(this.#handshake);
    this.#closeCode = code;
    this.onerror?.({ type: "error", message });
    this.#sock.destroy();
    this.#ended(code, message);
  }

  #ended(code, reason) {
    if (this.readyState === WebSocketClient.CLOSED) return;
    clearTimeout(this.#handshake);
    const wasClean = this.readyState === WebSocketClient.CLOSING && !this.#errored;
    this.readyState = WebSocketClient.CLOSED;
    this.onclose?.({ type: "close", code: this.#closeCode ?? code, reason, wasClean });
  }
}

export function connectWs(socketPath, { onMessage, onClose = () => {} }) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    const key = crypto.randomBytes(16).toString("base64");
    let buf = Buffer.alloc(0);
    let open = false;
    let parts = [];
    let closed = false;

    const close = () => {
      if (closed) return;
      closed = true;
      sock.destroy();
      if (open) onClose();
    };

    function frame(payload, op) {
      const mask = crypto.randomBytes(4);
      const n = payload.length;
      const head = n < 126 ? Buffer.from([0x80 | op, 0x80 | n]) : n < 65536 ? Buffer.from([0x80 | op, 0x80 | 126, n >> 8, n & 255]) : Buffer.concat([Buffer.from([0x80 | op, 0x80 | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
      const body = Buffer.from(payload);
      for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
      sock.write(Buffer.concat([head, mask, body]));
    }

    sock.on("connect", () => sock.write(`GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    sock.on("error", (e) => (open ? close() : reject(e)));
    sock.on("close", close);
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (!open) {
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = buf.subarray(0, end).toString();
        if (!/^HTTP\/1\.1 101/.test(head)) {
          sock.destroy();
          return reject(new Error(`The Codex daemon refused the connection: ${head.split("\r\n")[0]}`));
        }
        buf = buf.subarray(end + 4);
        open = true;
        resolve({ send: (text) => !closed && frame(Buffer.from(text), 0x1), close });
      }
      for (;;) {
        if (buf.length < 2) return;
        const fin = buf[0] & 0x80;
        const op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          off = 10;
        }
        if (buf[1] & 0x80) off += 4; // servers don't mask, but be lenient
        if (buf.length < off + len) return;
        const payload = buf.subarray(off, off + len);
        buf = buf.subarray(off + len);
        if (op === 0x9) frame(payload, 0xa);
        else if (op === 0x8) return close();
        else if (op === 0x1 || op === 0x0) {
          parts.push(payload);
          if (fin) {
            const text = Buffer.concat(parts).toString("utf8");
            parts = [];
            try {
              onMessage(text);
            } catch {}
          }
        }
      }
    });
  });
}
