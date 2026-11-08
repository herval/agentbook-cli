// A client for OpenClaw's gateway (protocol 4), for agentbook to connect to one directly: a gateway on another
// machine, at an address you give, signed in with its token (or password), or with a setup code (which holds
// the address, and a bootstrap token good for one device, for 10 minutes).
//
// agentbook is a device of its own there. It makes an Ed25519 key once, and signs each connection's challenge
// with it; the gateway asks for the device to be approved once (`openclaw devices approve <request>` on the
// gateway, or in the OpenClaw app), then hands it a device token, which it uses from then on when no shared
// token is set. A setup code's bootstrap token only gets it that far: OpenClaw lets its own phone apps in
// without approving them, but not other clients. It connects as an operator ("gateway-client", backend mode) that can read, write, and answer
// approvals and questions.
//
// Frames are JSON over a WebSocket: {type:"req",id,method,params}, {type:"res",id,ok,payload|error},
// {type:"event",event,payload}. agentbook's own WebSocket (ws.mjs), not Node's: the gateway compresses what it
// sends, and Node 22's WebSocket drops the connection when a message unpacks to more than 4 MB (a history can be 6).

import crypto from "node:crypto";
import { WebSocketClient } from "./ws.mjs";

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex"); // an Ed25519 public key's DER, before its 32 bytes
export const SCOPES = ["operator.read", "operator.write", "operator.approvals", "operator.questions"];
const CLIENT = { id: "gateway-client", mode: "backend", displayName: "agentbook", version: "2.0" };
const PLATFORM = { darwin: "macos", linux: "linux", win32: "windows" }[process.platform] || process.platform;

// A device identity: its key, and its id (the SHA-256 of the raw public key, as OpenClaw derives it).
export function makeIdentity() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(SPKI_PREFIX.length);
  return { deviceId: crypto.createHash("sha256").update(raw).digest("hex"), publicKey: raw.toString("base64url"), privateKey: privateKey.export({ type: "pkcs8", format: "pem" }) };
}

// A setup code, as `openclaw qr --setup-code-only` prints it (or its oc-pair:// link): base64url JSON with the
// gateway's address, a bootstrap token, and when the token expires. Throws when it isn't one.
export function decodeSetupCode(input) {
  const code = String(input || "").trim().replace(/^oc-pair:\/\//i, "");
  let p = null;
  try {
    if (/^[A-Za-z0-9_-]+$/.test(code)) p = JSON.parse(Buffer.from(code, "base64url").toString("utf8"));
  } catch {}
  let url = null;
  try {
    url = new URL(p?.url);
  } catch {}
  if (!url || !["ws:", "wss:"].includes(url.protocol) || typeof p.bootstrapToken !== "string" || !p.bootstrapToken.trim()) throw new Error("That isn't an OpenClaw setup code.");
  if (Number.isFinite(p.expiresAtMs) && p.expiresAtMs <= Date.now()) throw new Error("That setup code has expired. Make a new one.");
  return { url: url.toString().replace(/\/$/, ""), bootstrapToken: p.bootstrapToken.trim(), expiresAt: Number.isFinite(p.expiresAtMs) ? p.expiresAtMs : null };
}

// The line a device signs to connect (OpenClaw's "v3" payload).
export const authPayload = ({ deviceId, scopes, signedAt, token, nonce }) => ["v3", deviceId, CLIENT.id, CLIENT.mode, "operator", scopes.join(","), String(signedAt), token || "", nonce, PLATFORM, ""].join("|");

// Connect, and stay connected: `rpc(method, params)` waits for the connection. `identity` is saved through
// `save` when the gateway hands it a device token. `onState` hears { state: "connecting" | "pairing" |
// "connected" | "failed", error, requestId }; `onEvent` the gateway's events.
export function connectGateway({ url, token, password, bootstrapToken, identity, save = () => {}, onState = () => {}, onEvent = () => {}, log = () => {} }) {
  let ws = null;
  let closed = false;
  let connected = false;
  let nextId = 1;
  let retry = 1000;
  let away = 60000; // turned away (rate limited): wait a minute, then longer each time, up to 15
  let timer = null;
  let watch = null; // looks every second for a connection that's gone quiet
  let heard = 0; // when the gateway last sent anything
  let tick = 30000; // how often the gateway says it's still there (its hello says; 30s is OpenClaw's own)
  const pending = new Map(); // id -> { resolve, reject, timer }
  let waiters = []; // rpc calls waiting for the connection
  let state = { state: "connecting" };
  const setState = (s) => {
    state = s;
    onState(s);
  };

  function send(frame) {
    ws?.send(JSON.stringify(frame));
  }
  function request(method, params, timeout = 30000) {
    const id = `ab${nextId++}`;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`OpenClaw didn't answer ${method}`));
      }, timeout);
      pending.set(id, { resolve, reject, timer: t, method });
      send({ type: "req", id, method, params });
    });
  }

  function open() {
    if (closed) return;
    timer = null;
    connected = false;
    let sock;
    try {
      sock = ws = new WebSocketClient(url);
    } catch (e) {
      return fail(e.message, 30000);
    }
    heard = Date.now();
    sock.onmessage = (m) => {
      if (sock !== ws) return;
      heard = Date.now();
      onFrame(String(m.data));
    };
    sock.onclose = () => lost(sock);
    // When it can't connect at all (refused, no network, a name that doesn't resolve), it fires `error` (Node's
    // WebSocket, which this was, never fired `close` then): that connection is lost too, or agentbook would never
    // try again.
    sock.onerror = () => lost(sock);
    // A connection that hears nothing is gone even when its socket doesn't say so (a laptop that slept, a gateway
    // that never answers): signed in, the gateway ticks every `tick` ms; before, it challenges at once.
    clearInterval(watch);
    watch = setInterval(() => Date.now() - heard > (connected ? 2 * tick : 20000) && lost(sock), 1000);
    watch.unref?.();
  }
  // The connection is gone, or never came: what waits on it fails, and agentbook tries again.
  function lost(sock) {
    if (sock !== ws) return; // given up on already
    ws = null;
    clearInterval(watch);
    try {
      sock.close();
    } catch {}
    const was = connected;
    connected = false;
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error("The connection to OpenClaw closed"));
    }
    pending.clear();
    if (closed) return;
    if (was || state.state === "connecting") setState({ state: "connecting", error: was ? "The connection to its gateway dropped" : `Its gateway at ${where()} doesn't answer` });
    if (!timer) schedule(); // unless the handshake already said when to try again
  }
  const where = () => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  };
  function schedule(ms = retry) {
    clearTimeout(timer);
    timer = setTimeout(open, ms);
    timer.unref?.();
    retry = Math.min(30000, retry * 2);
  }
  function fail(error, ms) {
    setState({ state: "failed", error });
    schedule(ms);
  }

  async function onFrame(text) {
    let f;
    try {
      f = JSON.parse(text);
    } catch {
      return;
    }
    if (f.type === "event" && f.event === "connect.challenge") return hello(f.payload || {});
    if (f.type === "res" && pending.has(f.id)) {
      const p = pending.get(f.id);
      pending.delete(f.id);
      clearTimeout(p.timer);
      return f.ok ? p.resolve(f.payload) : p.reject(Object.assign(new Error(f.error?.message || `OpenClaw refused ${p.method}`), { details: f.error?.details || {}, code: f.error?.code }));
    }
    if (f.type === "event") onEvent(f.event, f.payload);
  }

  // Answer the gateway's challenge: sign it, and sign in.
  async function hello({ nonce, ts }) {
    const authToken = token || (password ? undefined : identity.deviceToken);
    // A setup code's bootstrap token, until the gateway hands agentbook a device token of its own.
    const bootstrap = authToken || password ? undefined : bootstrapToken;
    if (!authToken && !password && !bootstrap) {
      fail("The gateway no longer knows agentbook. Connect again, with a new setup code or its token.", 60000);
      return ws?.close();
    }
    const signedAt = Number.isInteger(ts) ? ts : Date.now();
    const signature = crypto.sign(null, Buffer.from(authPayload({ deviceId: identity.deviceId, scopes: SCOPES, signedAt, token: authToken || bootstrap, nonce }), "utf8"), crypto.createPrivateKey(identity.privateKey)).toString("base64url");
    try {
      const ok = await request("connect", {
        minProtocol: 4,
        maxProtocol: 4,
        client: { ...CLIENT, platform: PLATFORM },
        role: "operator",
        scopes: SCOPES,
        caps: [],
        auth: { ...(authToken ? { token: authToken } : {}), ...(bootstrap ? { bootstrapToken: bootstrap } : {}), ...(password ? { password } : {}) },
        userAgent: "agentbook/2.0",
        device: { id: identity.deviceId, publicKey: identity.publicKey, signature, signedAt, nonce },
      });
      connected = true;
      retry = 1000;
      away = 60000;
      tick = Number(ok?.policy?.tickIntervalMs) || 30000;
      if (ok?.auth?.deviceToken && ok.auth.deviceToken !== identity.deviceToken) {
        identity.deviceToken = ok.auth.deviceToken;
        identity.scopes = ok.auth.scopes || SCOPES;
        save(identity);
      }
      setState({ state: "connected", server: ok?.server?.version || null, scopes: ok?.auth?.scopes || [] });
      for (const w of waiters) w.resolve();
      waiters = [];
      request("sessions.subscribe", {}).catch(() => {}); // sessions.changed events, so posts update at once
    } catch (e) {
      const code = e.details?.code || e.code || "";
      if (/PAIRING_REQUIRED/i.test(code) || /pairing required|not paired/i.test(e.message)) {
        // Waiting for someone to approve this device on the gateway. The request lasts 5 minutes; asking again
        // keeps it fresh.
        setState({ state: "pairing", requestId: e.details?.requestId || null, deviceId: identity.deviceId, error: null });
        ws?.close();
        return schedule(5000);
      }
      // Turned away for a while (AUTH_RATE_LIMITED: too many failed sign-ins from this address, agentbook's or
      // anything else's): the device token is fine, so keep it, and try again later, less often each time.
      const limited = /RATE_LIMIT/i.test(code) || /too many|retry later/i.test(e.message);
      if (!limited && identity.deviceToken && !token && !password && /TOKEN|AUTH/i.test(code)) {
        // The device token stopped working (revoked, rotated): forget it, and pair again.
        delete identity.deviceToken;
        save(identity);
      }
      log(`openclaw gateway: ${e.message}`);
      const spent = bootstrap && /BOOTSTRAP/i.test(code);
      setState({ state: "failed", error: spent ? "The setup code has expired, or was already used. Make a new one." : limited ? "The gateway is turning this machine away for a while, after too many failed sign-ins from it. agentbook tries again in a while." : e.message, code });
      ws?.close();
      schedule(limited ? away : 30000);
      if (limited) away = Math.min(15 * 60e3, away * 2);
    }
  }

  async function rpc(method, params = {}, timeout = 30000) {
    if (!connected) {
      if (state.state === "pairing") throw new Error(`Approve agentbook on the OpenClaw gateway first${state.requestId ? `: openclaw devices approve ${state.requestId}` : ""}`);
      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(state.error || "Not connected to OpenClaw")), 15000);
        waiters.push({ resolve: () => (clearTimeout(t), resolve()) });
      });
    }
    return request(method, params, timeout);
  }

  open();
  return {
    rpc,
    state: () => state,
    close() {
      closed = true;
      clearTimeout(timer);
      clearInterval(watch);
      ws?.close();
    },
  };
}
