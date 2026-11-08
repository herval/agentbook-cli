// A WebSocket server, enough for the terminals' lines (server/terminals.mjs) and DeepSeek Harness's plugin (dsh.mjs):
// text messages, ping and pong, close. Zero dependencies, like the rest of agentbook (plugin/cli/drivers/ws.mjs is
// its client half, for a unix socket).
//
// accept(req, socket, head) answers an HTTP upgrade and returns { send(text), close(code, reason), onMessage,
// onClose, bufferedAmount }; refuse(socket, status, message) turns one down.

import crypto from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE = 4 * 1024 * 1024;
const PING_MS = 25e3; // a ping this often, and one that goes this long twice without a word from the other end is gone

export function refuse(socket, status, message = "") {
  try {
    socket.end(`HTTP/1.1 ${status} ${message.replace(/[^\x20-\x7e]/g, "") || "No"}\r\nconnection: close\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(message)}\r\n\r\n${message}`);
  } catch {}
  setTimeout(() => socket.destroy(), 1000).unref?.();
}

export function accept(req, socket, head) {
  const key = req.headers["sec-websocket-key"];
  if (!key || String(req.headers.upgrade || "").toLowerCase() !== "websocket") return void refuse(socket, 400, "Not a WebSocket");
  const sum = crypto.createHash("sha1").update(key + GUID).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${sum}\r\n\r\n`);
  socket.setNoDelay(true);
  socket.setTimeout(0);

  let buf = head?.length ? Buffer.from(head) : Buffer.alloc(0);
  let parts = [];
  let closed = false;
  let heard = Date.now();
  const ws = {
    onMessage: () => {},
    onClose: () => {},
    send: (text) => !closed && write(0x1, Buffer.from(text)),
    close(code = 1000, reason = "") {
      if (closed) return;
      const r = Buffer.from(String(reason).slice(0, 120));
      const body = Buffer.alloc(2 + r.length);
      body.writeUInt16BE(code, 0);
      r.copy(body, 2);
      write(0x8, body);
      end();
    },
    get bufferedAmount() {
      return socket.writableLength;
    },
  };
  function write(op, body) {
    const n = body.length;
    const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.from([0x80 | op, 126, n >> 8, n & 255]) : Buffer.alloc(10);
    if (n >= 65536) {
      head[0] = 0x80 | op;
      head[1] = 127;
      head.writeBigUInt64BE(BigInt(n), 2);
    }
    try {
      socket.write(Buffer.concat([head, body]));
    } catch {}
  }
  function end() {
    if (closed) return;
    closed = true;
    clearInterval(beat);
    socket.end();
    setTimeout(() => socket.destroy(), 1000).unref?.();
    ws.onClose();
  }
  const beat = setInterval(() => {
    if (Date.now() - heard > 2 * PING_MS + 5000) return socket.destroy();
    write(0x9, Buffer.alloc(0));
  }, PING_MS);
  beat.unref?.();

  socket.on("data", (d) => {
    heard = Date.now();
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    for (;;) {
      if (buf.length < 2) return;
      const fin = buf[0] & 0x80;
      const op = buf[0] & 0x0f;
      const masked = buf[1] & 0x80;
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
      // What a browser sends is masked; anything else, or too much, isn't one.
      if (!masked || len > MAX_MESSAGE) return void ws.close(1002, "That's not a WebSocket frame this takes.");
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const body = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
      if (op === 0x8) return void ws.close(1000);
      if (op === 0x9) write(0xa, body);
      else if (op === 0x0 || op === 0x1 || op === 0x2) {
        parts.push(body);
        if (parts.reduce((n, p) => n + p.length, 0) > MAX_MESSAGE) return void ws.close(1009, "Too much at once.");
        if (fin) {
          const all = Buffer.concat(parts);
          parts = [];
          try {
            ws.onMessage(all.toString("utf8"));
          } catch {}
        }
      }
    }
  });
  socket.on("error", () => {});
  // A process that's killed sends no close frame, only the socket's end. An HTTP server's sockets stay half open after
  // that, so this is how it's known: nothing else says so until a ping goes unanswered, up to a minute later, and what's
  // sent meanwhile is lost with no error.
  socket.on("end", end);
  socket.on("close", end);
  return ws;
}
