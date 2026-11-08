// Signed commands: what the page has the person's passkey sign, and what a machine
// checks. For every side but the page (which keeps its own copy of `canonical`): the server proposes what to sign
// and relays it as it is, and the CLI checks it (plugin/cli/signatures.mjs) before its gate does anything else.
//
// A passkey signs three kinds of things, each as canonical JSON whose SHA-256 is its challenge:
// - a command, for one machine: its ENVELOPE fields;
// - routine.ok, OK'ing a routine's version: { v: 1, kind: "routine.ok", rid, version, name, use, hash, root?, pages? },
//   which every run of it carries (`hash`: of routineRunnable);
// - keys.change, adding or taking off a key: { v: 1, kind: "keys.change", add, remove, at }, for every machine of theirs.
// - operators.change, letting someone else steer one agent of theirs on one machine:
//   { v: 1, kind: "operators.change", machine, user, agent, keys, at }; taking it back (`remove: true`) isn't signed.

import crypto from "node:crypto";

// The kinds a machine takes only when they're signed, once it keeps its owner's keys (gate.json can say otherwise):
// each can run something, lose work, or tell an agent something as its owner.
export const SIGNED_KINDS = ["post.start", "post.deliver", "post.answer", "post.notify", "folder.trust", "folder.restore", "workspace.clone", "wip.discard", "wip.clean", "cloud.pull", "post.apply", "post.run", "page_routine.run", "routine.do", "openclaw.pair", "remote.connect", "term.open", "term.lease", "claude.login"];

// What someone a machine's owner lets operate one of its agents may have it do: start a
// thread with that agent, and message, answer, stop and queue on that agent's threads. Nothing else, ever: not its
// folders, terminals, runs, branches, routines or settings.
export const OPERATOR_KINDS = ["post.start", "post.deliver", "post.answer", "post.stop", "post.queue", "post.resend", "post.discard", "post.pickup"];

// What's signed of a command: these fields and nothing else, so what a server adds to one can't change what's checked.
export const ENVELOPE = ["v", "machine", "cid", "kind", "args", "by", "at", "expires"];
export const envelope = (c) => Object.fromEntries(ENVELOPE.filter((k) => c?.[k] !== undefined).map((k) => [k, c[k]]));

// JSON with its keys sorted at every level and no spaces, so the page and the machine sign and check the same
// bytes (RFC 8785, for what JSON.stringify writes).
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : canonical(x))).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}
// The SHA-256 of a value's canonical JSON, base64url: a challenge, or a routine version's hash.
export const digestOf = (v) => crypto.createHash("sha256").update(canonical(v)).digest("base64url");
// A passkey as a machine keeps it: its id, its algorithm (ES256, Ed25519 or RS256) and its public key (SPKI), base64url.
export const isKey = (k) => !!k && typeof k.id === "string" && !!k.id && k.id.length <= 1400 && [-7, -8, -257].includes(k.alg) && typeof k.spki === "string" && !!k.spki && k.spki.length <= 2000;
// A key's short name, for people to compare across machines and the page: the start of its hash.
export const fingerprint = (spki) => crypto.createHash("sha256").update(Buffer.from(String(spki || ""), "base64url")).digest("base64url").slice(0, 12);

// What a routine version's OK covers of how it runs: a code routine's code and what it may reach; an agent
// routine's prompt. From the version (the server) or from a run's fields (the machine), alike.
export const routineRunnable = (x) => (x.code != null ? { code: String(x.code), reach: x.reach || { tools: [], commands: [] } } : { prompt: String(x.prompt || "") });
// A run that reaches nothing (no tools, no commands): a routine's test run, which needs no OK.
const reachesNothing = (reach) => !reach || ((!Array.isArray(reach.tools) || !reach.tools.length) && (!Array.isArray(reach.commands) || !reach.commands.length));

// Whether a command needs a signature (its own, or a routine OK it carries), given the kinds that do. Skipping a
// question, or closing it with its thread, approves nothing; nor does a routine's run that reaches nothing.
export function needsSignature(c, kinds = SIGNED_KINDS) {
  if (!kinds.includes(c?.kind)) return false;
  const a = c.args || {};
  if (c.kind === "post.answer" && (a.skip || a.archived) && a.value == null && !a.file) return false;
  if (c.kind === "page_routine.run" && reachesNothing(a.reach)) return false;
  return true;
}
