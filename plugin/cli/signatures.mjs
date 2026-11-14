// A passkey's signature, checked on the machine. A passkey signs the WebAuthn way:
// over its authenticator data and the hash of its client data, whose challenge is the hash of what it signs and
// whose origin is the page it was made on. This checks all of it against the keys and the page the machine pinned,
// with node:crypto alone: ES256, Ed25519, or RS256 (Windows Hello's RSA keys). What a passkey signs: a command, a
// routine's OK, a change of keys (plugin/shared/signed.mjs).

import crypto from "node:crypto";
import { assertionRefusal, canonical, digestOf, envelope, fingerprint, isKey, routineRunnable } from "../shared/signed.mjs";
import { COMMANDS } from "../shared/protocol.mjs";

const b64 = (s) => Buffer.from(String(s || ""), "base64url");
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest();
// The challenge a command is signed with: the hash of what's signed of it, as WebAuthn's client data writes it.
export const challengeOf = (c) => digestOf(envelope(c));
const SKEW = 5 * 60e3;
const LONGEST = 7 * 86400e3;
// A page passkeys may sign on: https anywhere, or http on this machine (a server you run here, at localhost).
const pageOk = (o) => typeof o === "string" && /^(https:\/\/[^/\s]+|http:\/\/localhost(:\d+)?)$/.test(o);

// The longest a browser's key signs for its owner here, in hours, unless gate.json's `session_hours` says less (0:
// only the passkey itself, every time).
export const SESSION_HOURS = 24;
// Why a command a browser's key signed doesn't hold, or null when it does: one Face ID, then a while
// without another. The browser made the key and can't hand it out; its owner's passkey signed it once, as
// { v: 1, kind: "session", key: { alg: -7, spki }, at, expires }; and the key signs each command (ES256, over the
// command's canonical JSON) until then, by this machine's clock. Only a command: a routine's OK and a change of keys
// stay the passkey's own.
function sessionRefusal(c, { keys, origin, rpId, hours, now }) {
  if (!(hours > 0)) return "this machine takes only what its owner's passkey signs itself, not a browser's key it signed (its gate.json)";
  const s = c.sig.session;
  const e = s?.envelope;
  if (!e || typeof e !== "object" || e.v !== 1 || e.kind !== "session" || e.key?.alg !== -7 || typeof e.key.spki !== "string" || e.key.spki.length > 400 || typeof c.sig.signature !== "string") return "it's signed by a browser's key in a way this agentbook-cli doesn't know";
  if (s.sig?.key !== c.sig.key) return "its browser's key was signed by another passkey than it says";
  const from = Date.parse(e.at);
  const until = Date.parse(e.expires);
  if (!(from <= now + SKEW)) return "its browser's key is signed for a time that hasn't come yet";
  if (!(until > now)) return "its browser's key has expired: sign again with your passkey";
  if (!(until - from <= hours * 3600e3 + SKEW)) return `its browser's key is signed for longer than this machine takes (${hours} hours)`;
  const why = assertionRefusal(e, s.sig, { keys, origin, rpId });
  if (why) return why === "its signature is for something else" ? "its browser's key wasn't what its passkey signed" : why;
  let good = false;
  try {
    const pub = crypto.createPublicKey({ key: b64(e.key.spki), format: "der", type: "spki" });
    if (pub.asymmetricKeyType !== "ec" || pub.asymmetricKeyDetails?.namedCurve !== "prime256v1") return "its browser's key isn't a kind agentbook-cli checks";
    good = crypto.verify("sha256", Buffer.from(canonical(envelope(c))), { key: pub, dsaEncoding: "ieee-p1363" }, b64(c.sig.signature));
  } catch {
    good = false;
  }
  return good ? null : "its signature doesn't match";
}

// Why a command's own signature doesn't hold, or null when it does. `keys`: [{ id, alg, spki }], base64url, as the
// passkeys made them. `origin`: the page's address; `rpId`: the site the passkeys are for; `machine`: this
// machine's id for signed commands (gate.json's `machine`). `hours`: the longest a browser's key its passkey signed
// may sign for it here (sessionRefusal).
export function signatureRefusal(c, { keys = [], origin, rpId, machine, hours = SESSION_HOURS, now = Date.now() } = {}) {
  if (!c?.sig || typeof c.sig !== "object") return "it isn't signed by its owner's passkey";
  if (!keys.some((k) => k.id === c.sig.key)) return "it's signed with a key this machine doesn't keep";
  if (c.v !== 1) return "it's signed in a way this agentbook-cli doesn't know";
  if (!machine || c.machine !== machine) return "it's signed for another machine";
  const at = Date.parse(c.at);
  const expires = Date.parse(c.expires);
  if (!(expires > now)) return "its signature has expired";
  if (!(at <= now + SKEW)) return "it's signed for a time that hasn't come yet";
  // No longer than its kind may wait, so the machine still remembers having run it (the uplink keeps 8 days).
  if (!(expires - at <= (COMMANDS[c.kind]?.expires || LONGEST) + SKEW)) return "it's signed to last longer than its kind may";
  if (c.sig.session) return sessionRefusal(c, { keys, origin, rpId, hours, now });
  return assertionRefusal(envelope(c), c.sig, { keys, origin, rpId });
}

// The keys a machine is to keep, as its server hands them over when its person connects it or turns signing on for it:
// { keys, origin, rp_id }, checked for what they are, or throws why not. That moment trusts the server, as any first
// meeting does (like SSH's known hosts): what the keys sign after it, the server can't. To trust no server at all,
// copy them from a machine that has them (agentbook-cli keys export | import).
export function pinOf(pin) {
  const keys = Array.isArray(pin?.keys) ? pin.keys.filter(isKey) : [];
  if (!keys.length || keys.length !== pin.keys.length) throw new Error("those aren't passkeys agentbook-cli checks");
  const origin = pin.origin;
  if (!pageOk(origin)) throw new Error(`${String(origin).slice(0, 120)} isn't a page passkeys sign on (https, or http at localhost)`);
  const rpId = typeof pin.rp_id === "string" ? pin.rp_id : "";
  const host = new URL(origin).hostname;
  if (!rpId || (host !== rpId && !host.endsWith(`.${rpId}`))) throw new Error(`passkeys on ${origin} can't be for ${rpId || "no site"}`);
  return { origin, rp_id: rpId, keys: keys.map((k) => ({ id: k.id, alg: k.alg, spki: k.spki, ...(typeof k.name === "string" ? { name: k.name.slice(0, 80) } : {}) })) };
}

// Why a routine's OK doesn't let this run, or null when it does: signed by a key the machine keeps, for this
// routine, to use this version, and covering what the run is (its code and reach, or its prompt; its folder when
// the OK names one). `run`: { rid, code, reach } or { rid, prompt, root }. `use: false` only checks it's theirs (a
// notice that they answered).
export function okRefusal(ok, run, { keys = [], origin, rpId, use = true } = {}) {
  const e = ok?.envelope;
  if (!e || e.v !== 1 || e.kind !== "routine.ok") return "it's a routine's run without its owner's OK";
  if (e.rid !== run.rid) return "it carries another routine's OK";
  if (use) {
    if (e.use !== true) return "its owner didn't OK that version";
    if (e.hash !== digestOf(routineRunnable(run))) return "it isn't the version its owner OK'd";
    if (e.root != null && e.root !== run.root) return "it runs somewhere its owner didn't OK";
  }
  return assertionRefusal(e, ok.sig, { keys, origin, rpId });
}

// Why a change of keys doesn't hold, or null when it does: signed by a key the machine keeps already, newer than the
// last change it took (`since`), and adding only passkeys it checks.
export function changeRefusal(change, { keys = [], origin, rpId, since = null } = {}) {
  const e = change?.envelope;
  if (!e || e.v !== 1 || e.kind !== "keys.change") return "it isn't a change of keys";
  if (!(Date.parse(e.at) > (since ? Date.parse(since) : 0))) return "it's older than the last change of keys this machine took";
  if (!(Date.parse(e.at) <= Date.now() + SKEW)) return "it's dated in the future";
  if (!Array.isArray(e.add) || !Array.isArray(e.remove) || !e.add.every(isKey) || !e.remove.every((id) => typeof id === "string")) return "it's a change of keys this agentbook-cli doesn't take";
  return assertionRefusal(e, change.sig, { keys, origin, rpId });
}

// Why a change of who operates one of this machine's agents doesn't hold, or null when it does.
// Taking someone off needs no signature: it only takes away. Letting someone on is signed
// by one of the owner's keys this machine keeps (when it keeps any), for this machine, newer than the last change it
// took for that person and agent (`seen`, so one taken back can't be sent again), not dated in the future, with only
// passkeys it checks. `keys`: the owner's, as kept here; with none (a machine whose server is itself), it's unsigned.
export function operatorsRefusal(change, { keys = [], origin, rpId, machine, seen = {}, owner = null, now = Date.now() } = {}) {
  const e = change?.envelope;
  if (!e || e.v !== 1 || e.kind !== "operators.change") return "it isn't a change of who operates an agent here";
  if (typeof e.user !== "string" || !/^[\w.-]{1,80}$/.test(e.user) || typeof e.agent !== "string" || !e.agent || e.agent.length > 300) return "it doesn't say who, or which agent";
  if (owner && e.user === owner) return "this machine's owner steers it already";
  if (e.remove === true) return null;
  if (!Array.isArray(e.keys) || e.keys.length > 20 || !e.keys.every(isKey)) return "it's a change of who operates an agent this agentbook-cli doesn't take";
  const at = Date.parse(e.at);
  if (!Number.isFinite(at)) return "it isn't dated";
  if (!(at <= now + SKEW)) return "it's dated in the future";
  // A week at most: one the server held back that long is signed again.
  if (!(now - at <= LONGEST)) return "it's over a week old: its owner signs it again";
  const last = Date.parse(seen[`${e.user}|${e.agent}`] || "");
  if (Number.isFinite(last) && !(at > last)) return `it's older than the last change of who operates that agent here: @${e.user} was let on or taken off since`;
  if (!keys.length) return null;
  if (!machine || e.machine !== machine) return "it's signed for another machine";
  return assertionRefusal(e, change.sig, { keys, origin, rpId });
}

export { assertionRefusal, canonical, fingerprint, isKey };
