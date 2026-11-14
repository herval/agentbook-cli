// How agentbook-cli and agentbook-server talk:
// - ops: a machine's news, up. Numbered by the CLI, idempotent, acknowledged by the server. Most are its store's
//   own ops under the names below; the server applies them to what it keeps for that machine.
// - info: what a machine knows right now and the page shows (its folders, what each post is doing this moment,
//   each agent's models and routines). Sent when it changes; each one replaces the last.
// - commands: what someone did on the page, down. A closed list of kinds, each with a schema. The CLI refuses
//   anything else. Two run a shell: post.run, only a code block that's in the message it names, and term.open, its
//   owner's own shell, which they type into.
// - reads: what only the machine knows, fetched when someone looks, and kept by the server for a while.
// Every schema is checked on both sides: the server checks a machine's ops, the CLI the server's commands.

export const PROTOCOL = 1;
// The oldest agentbook-cli a server talks to: an older one is told to update, rather than half working.
export const MIN_PROTOCOL = 1;

/* ---------- schemas ---------- */

// A field: "string", "number", "boolean", "object", "array", "any", or { type, max, enum, items, fields, optional,
// nullable }. A name ending in "?" is optional. Strings and arrays have a size limit (`max`); objects and arrays
// of objects are limited as JSON (`bytes`).
const S = (max = 2000) => ({ type: "string", max });
const N = { type: "number" };
const B = { type: "boolean" };
const ANY = (bytes = 64 * 1024) => ({ type: "any", bytes });
const OBJ = (bytes = 64 * 1024) => ({ type: "object", bytes });
// A routine's OK, signed by its owner's passkey, that its runs carry.
const OK = OBJ(64 * 1024);
const ARR = (items, max = 100, bytes = 256 * 1024) => ({ type: "array", items, max, bytes });
const ID = S(300);
// A routine's run, on what it started (a launch, a message): the routine, by its id and name (routines.mjs).
const ROUTINE_REF = { type: "object", fields: { id: S(100), name: S(200), "why?": S(20) }, nullable: true };
// A code block run from a message (post.run): how much of it there may be, how much of what it printed is kept with
// the post, and how a run stands.
export const RUN_CODE_MAX = 20000;
export const RUN_OUT_MAX = 64 * 1024;
export const RUN_STATES = ["running", "done", "stopped", "failed"];

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
const size = (v) => {
  try {
    return Buffer.byteLength(JSON.stringify(v) || "");
  } catch {
    return Infinity;
  }
};

// Whether `value` matches `schema` (fields of an object): an error in words, or null. `extra`: what to do with a
// field the schema doesn't name: "refuse" (commands), or "drop" (ops, so a newer CLI can talk to an older server).
export function check(fields, value, { extra = "refuse", where = "" } = {}) {
  if (typeOf(value) !== "object") return `${where || "it"} isn't an object`;
  for (const key of Object.keys(value)) {
    if (fields[key] || fields[`${key}?`]) continue;
    if (extra === "drop") delete value[key];
    else return `${where}${key} isn't something it takes`;
  }
  for (const [name, spec0] of Object.entries(fields)) {
    const optional = name.endsWith("?");
    const key = optional ? name.slice(0, -1) : name;
    const spec = typeof spec0 === "string" ? { type: spec0 } : spec0;
    const v = value[key];
    if (v === undefined || (v === null && (optional || spec.nullable))) {
      if (!optional && v === undefined) return `${where}${key} is missing`;
      continue;
    }
    const err = checkValue(spec, v, `${where}${key}`);
    if (err) return err;
  }
  return null;
}

// A spec's `type` can be a list of them (any one of them will do); an object's `values` checks each of its values (a
// map, by id); and a record's `extra` is what its `fields` do with one they don't know, as check's.
function checkValue(spec, v, where) {
  const t = typeOf(v);
  if (spec.type === "any") return spec.bytes && size(v) > spec.bytes ? `${where} is too big` : null;
  if (Array.isArray(spec.type)) return spec.type.includes(t) ? checkValue({ ...spec, type: t }, v, where) : `${where} should be ${spec.type.map((x) => (x === "array" ? "a list" : `a ${x}`)).join(" or ")}`;
  if (spec.type !== t) return `${where} should be ${spec.type === "array" ? "a list" : `a ${spec.type}`}`;
  if (t === "string" && v.length > (spec.max ?? 2000)) return `${where} is too long`;
  if (t === "number" && !Number.isFinite(v)) return `${where} isn't a number`;
  if (spec.enum && !spec.enum.includes(v)) return `${where} isn't one of ${spec.enum.join(", ")}`;
  if (t === "array") {
    if (v.length > (spec.max ?? 100)) return `${where} has too many`;
    if (spec.bytes && size(v) > spec.bytes) return `${where} is too big`;
    if (spec.items) {
      for (let i = 0; i < v.length; i++) {
        const err = spec.items.fields ? check(spec.items.fields, v[i], { extra: spec.items.extra || "refuse", where: `${where}[${i}].` }) : checkValue(spec.items, v[i], `${where}[${i}]`);
        if (err) return err;
      }
    }
  }
  if (t === "object") {
    if (spec.bytes && size(v) > spec.bytes) return `${where} is too big`;
    if (spec.fields) return check(spec.fields, v, { extra: spec.extra || "refuse", where: `${where}.` });
    if (spec.values) {
      for (const [k, x] of Object.entries(v)) {
        const err = spec.values.fields ? check(spec.values.fields, x, { extra: spec.values.extra || "refuse", where: `${where}.${k}.` }) : checkValue(spec.values, x, `${where}.${k}`);
        if (err) return err;
      }
    }
  }
  return null;
}

/* ---------- ops: a machine's news ---------- */

// Each op kind: the store op it is (`t`), and its fields. A machine's ids are its own: the server keeps each
// machine's things apart, and gives the page an id for each one it makes (`makes`): the same, unless another
// machine has it already, when it gets the machine's name in front (server/relay.mjs).
const POST_FIELDS = {
  "proc?": S(120),
  "agent?": S(120),
  "agent_name?": S(80),
  "kind?": S(40),
  "label?": S(40),
  "named?": B,
  "session_id?": { type: "string", max: 200, nullable: true },
  "transcript?": { type: "string", max: 2000, nullable: true },
  "cwd?": { type: "string", max: 2000, nullable: true },
  "root?": { type: "string", max: 2000, nullable: true },
  "repo?": { type: "string", max: 300, nullable: true },
  "branch?": { type: "string", max: 300, nullable: true },
  "pid?": { type: "any", bytes: 40 },
  "host?": { type: "string", max: 200, nullable: true },
  "channel?": B,
  "launch?": { type: "string", max: 300, nullable: true },
  "cloud?": { type: "string", max: 40, nullable: true },
  // Claude Desktop ("desktop") or VS Code ("vscode"), where what's typed into it is typed.
  "app?": { type: "string", enum: ["desktop", "vscode"], nullable: true },
  "url?": { type: "string", max: 2000, nullable: true },
  "prompt?": { type: "string", max: 12000, nullable: true },
  "started?": S(40),
  "updated?": S(40),
};

export const OPS = {
  "post.hello": { t: "session.hello", fields: POST_FIELDS, makes: (op) => [["post", op.session_id || op.proc], ["agent", op.agent]] },
  "post.status": { t: "session.status", fields: { post: ID, "state?": S(40), "text?": S(400), "turn?": S(10), "transcript?": S(2000), "failed?": { type: "string", max: 40, nullable: true }, "app?": { type: "string", enum: ["desktop", "vscode"] } } },
  "post.gone": { t: "session.gone", fields: { post: ID, "reason?": S(200), "ended?": S(40) } },
  "post.sleep": { t: "session.sleep", fields: { post: ID, "reason?": S(200) } },
  "post.post": { t: "session.post", fields: { post: ID, "title?": S(200), "text?": { type: "string", max: 8000, nullable: true } } },
  "post.update": { t: "session.update", fields: { post: ID, text: S(600), "link?": { type: "string", max: 2000, nullable: true }, "changes?": OBJ(16 * 1024), "pr?": OBJ(4096), "notify?": B } },
  "post.pr": { t: "session.pr", fields: { post: ID, url: S(500), "number?": N, "repo?": S(300), "how?": S(20), "at?": S(40), "off?": B, "gh?": { type: "object", bytes: 32 * 1024, nullable: true } } },
  "post.attach": { t: "session.attach", fields: { post: ID, key: S(60), "type?": S(20), "title?": S(200), "data?": OBJ(512 * 1024), "remove?": B } },
  // How its turn went, to show on the reply that ends it: its verdict, what it didn't check, the
  // replies it suggests. Each part replaces what the turn had of it; the reply takes them all (message.add).
  "post.shape": { t: "session.shape", fields: { post: ID, shape: OBJ(96 * 1024) } },
  "post.where": { t: "session.where", fields: { post: ID, "cwd?": S(2000), "root?": S(2000), "repo?": S(300), "branch?": { type: "string", max: 300, nullable: true } } },
  "post.landed": { t: "session.landed", fields: { post: ID, branch: S(300) } },
  "post.skills": { t: "session.skills", fields: { post: ID, skills: ARR(OBJ(8192), 400, 512 * 1024) } },
  "post.model": { t: "session.model", fields: { post: ID, model: { type: "string", max: 80, nullable: true } } },
  // The thread it was started from: a Claude Desktop session another one started (cli/desktop.mjs).
  "post.from": { t: "session.from", fields: { post: ID, started_from: ID } },
  // A copy of its conversation Claude Code started on a resume (`copy`, its session id or the start of it): it's this
  // post, and with `follow` the post goes on in it.
  "post.fold": { t: "session.fold", fields: { post: ID, copy: ID, "follow?": B, "session_id?": S(200) } },
  // Its queue held: "stopped" (you stopped it), "ended" (its session ended), "you" (you paused it), or null.
  "post.paused": { t: "session.paused", fields: { post: ID, paused: { type: "string", max: 20, nullable: true } } },
  "post.snapshot": { t: "session.snapshot", fields: { post: ID, "ai_title?": { type: "string", max: 400, nullable: true }, "model?": { type: "string", max: 120, nullable: true }, "plan?": ANY(128 * 1024), "stats?": ANY(16 * 1024), "context?": ANY(16 * 1024), "skill_uses?": ANY(64 * 1024), "started?": S(40), "prs?": OBJ(64 * 1024), "loops?": ARR(OBJ(64 * 1024), 100, 512 * 1024) } },
  "agent.hello": { t: "agent.hello", fields: { agent: ID, "agent_name?": S(80), "kind?": S(40), "host?": { type: "string", max: 200, nullable: true }, "version?": S(40) }, makes: (op) => [["agent", op.agent]] },
  "agent.avatar": { t: "agent.avatar", fields: { agent: ID, avatar: { type: "object", bytes: 4096, nullable: true }, "default?": B } },
  "launch.add": { t: "launch.add", fields: { lid: ID, agent: ID, "root?": { type: "string", max: 2000, nullable: true }, "branch?": { type: "string", max: 300, nullable: true }, "prompt?": S(12000), "files?": ARR(ID, 50), "post?": { type: "string", max: 300, nullable: true }, "resume?": B, "named?": B, "teleport?": { type: "string", max: 200, nullable: true }, "visibility?": { type: "string", max: 20, nullable: true }, "cloning?": { type: "string", max: 300, nullable: true }, "step?": { type: "string", max: 200, nullable: true }, "task?": { type: "string", max: 600, nullable: true }, "page?": { type: "string", max: 120, nullable: true }, "cwd?": { type: "string", max: 2000, nullable: true }, "model?": { type: "string", max: 80, nullable: true }, "effort?": { type: "string", max: 20, nullable: true }, "group?": { type: "string", max: 120, nullable: true }, "routine?": ROUTINE_REF, "noted?": B, "user?": { type: "string", max: 80, nullable: true }, "side_of?": ID }, makes: (op) => [["launch", op.lid]] },
  "launch.cloned": { t: "launch.cloned", fields: { lid: ID } },
  // What a start is doing before its session is up ("Making its worktree"), and how far it got: `done` of `total`
  // files. A null step: it's starting its session.
  "launch.step": { t: "launch.step", fields: { lid: ID, step: { type: "string", max: 200, nullable: true }, "done?": N, "total?": N } },
  "launch.started": { t: "launch.started", fields: { lid: ID, session: S(200) } },
  "launch.retry": { t: "launch.retry", fields: { lid: ID } },
  "launch.failed": { t: "launch.fail", fields: { lid: ID, error: S(2000) } },
  "question.ask": { t: "question.ask", fields: { post: ID, qid: ID, "kind?": S(20), title: S(600), "detail?": S(2000), "preview?": S(8000), "options?": ARR(OBJ(1024), 8), "default?": { type: "string", max: 400, nullable: true }, "until?": { type: "string", max: 40, nullable: true }, "key?": { type: "string", max: 120, nullable: true }, "request_id?": { type: "string", max: 40, nullable: true }, "tool_name?": { type: "string", max: 120, nullable: true }, "hook?": B, "blocks?": B, "other?": B }, makes: (op) => [["question", op.qid]] },
  "question.answer": { t: "question.answer", fields: { qid: ID, value: { type: "any", bytes: 8192 }, "by?": S(20), "user?": { type: "string", max: 80, nullable: true }, "file_id?": { type: "string", max: 300, nullable: true }, "file?": { type: "object", bytes: 4096, nullable: true } } },
  "file.add": { t: "file.add", fields: { fid: ID, "post?": { type: "string", max: 300, nullable: true }, from: S(20), name: S(300), "title?": S(300), "size?": N, "stored?": { type: "string", max: 400, nullable: true }, "blob?": { type: "string", max: 80, nullable: true }, "type?": { type: "string", max: 120, nullable: true }, "draft?": B, "embedded?": B, "pending?": B, "silent?": B, "remote?": ANY(4096), "artifact?": { type: "string", max: 300, nullable: true } }, makes: (op) => [["file", op.fid]] },
  "file.size": { t: "file.size", fields: { fid: ID, size: N } },
  "message.add": { t: "message.add", fields: { post: ID, mid: ID, from: S(20), "via?": S(20), "text?": S(16000), "file_id?": { type: "string", max: 300, nullable: true }, "files?": ARR(ID, 50), "when?": S(40), "ext?": { type: "string", max: 300, nullable: true }, "resume?": { type: "string", max: 300, nullable: true }, "routine?": ROUTINE_REF, "queue?": B, "command?": S(100), "user?": { type: "string", max: 80, nullable: true }, "launch?": ID }, makes: (op) => [["message", op.mid]] },
  "message.files": { t: "message.files", fields: { post: ID, ext: S(300), files: ARR(ID, 50) } },
  "message.text": { t: "message.text", fields: { post: ID, ext: S(300), text: S(16000) } },
  "message.drop": { t: "message.drop", fields: { post: ID, mids: ARR(ID, 2000, 128 * 1024) } },
  "message.fail": { t: "message.fail", fields: { post: ID, mids: ARR(ID, 200), error: S(2000) } },
  "message.retry": { t: "message.retry", fields: { post: ID, mid: ID } },
  // A queued message going in: it leaves the queue and moves to now.
  "message.release": { t: "message.release", fields: { post: ID, mid: ID } },
  "file.blob": { t: "file.blob", fields: { fid: ID, blob: S(80), "size?": N } },
  // A post's work (step 2): what the server keeps so a post shows whole while its machine is off. Kept apart
  // from the machine's store (server/work.mjs).
  "post.steps": { t: "post.steps", work: true, fields: { post: ID, from: N, steps: ARR(OBJ(256 * 1024), 20000, 32 * 1024 * 1024), total: N, "plan?": { type: "any", bytes: 128 * 1024 }, "turn?": N } },
  "post.images": { t: "post.images", work: true, fields: { post: ID, step: S(200), images: ARR({ type: "object", fields: { sha: S(80), type: S(80), "size?": N } }, 50) } },
  "post.changes": { t: "post.changes", work: true, fields: { post: ID, scope: S(240), data: { type: "any", bytes: 32 * 1024 * 1024 } } },
  // A picture its agent named by its path on the machine (`url`, as written): its bytes (a blob), or why not.
  "post.picture": { t: "post.picture", work: true, fields: { post: ID, url: S(2000), "sha?": S(80), "type?": S(80), "size?": N, "status?": N, "error?": S(600) } },
  // A code block of one of its messages, run (post.run): how its latest run went, as it starts and as it ends, with
  // the end of what it printed. What it prints meanwhile goes up with the post's info (`runs`).
  "post.run": { t: "session.run", fields: { post: ID, mid: ID, block: N, state: { type: "string", enum: RUN_STATES }, "by?": { type: "string", max: 80, nullable: true }, "started?": S(40), "ended?": { type: "string", max: 40, nullable: true }, "exit?": { type: "number", nullable: true }, "signal?": { type: "string", max: 20, nullable: true }, "out?": S(RUN_OUT_MAX + 100), "cut?": B, "error?": { type: "string", max: 600, nullable: true } } },
  // What the machine's gate did with a command (step 3): ran it, refused it and why, asked here first. Its own log
  // is on the machine (cli/audit.jsonl); the server keeps the latest for the machine's page, apart from its store.
  "machine.audit": { t: "machine.audit", audit: true, fields: { "cid?": { type: "string", max: 40, nullable: true }, kind: S(80), "by?": { type: "string", max: 80, nullable: true }, outcome: { type: "string", enum: ["ran", "refused", "asked", "approved"] }, "reason?": S(600), "post?": ID, "root?": S(2000), "path?": S(2000) } },
};

// The store's op names, back to the protocol's.
export const OP_OF = Object.fromEntries(Object.entries(OPS).map(([kind, o]) => [o.t, kind]));

// A machine's op, checked: { kind, seq, at, args } -> the store op it is ({ t, ...args }), or { error }.
export function opFrom(raw) {
  if (typeOf(raw) !== "object") return { error: "an op isn't an object" };
  const { kind, seq, at } = raw;
  const fields = typeOf(raw.args) === "object" ? { ...raw.args } : {};
  const spec = OPS[kind];
  if (!spec) return { error: `${kind} isn't an op agentbook-server takes` };
  if (!Number.isSafeInteger(seq) || seq < 1) return { error: `${kind} has no number` };
  if (typeof at !== "string" || Number.isNaN(Date.parse(at))) return { error: `${kind} doesn't say when` };
  const err = check(spec.fields, fields, { extra: "drop", where: `${kind}: ` });
  if (err) return { error: err };
  return { op: { t: spec.t, ...fields }, seq, at, kind };
}

// A store op, as a machine sends it: { kind, seq, at, args }, or null when it's the machine's own business (what it
// delivered to its sessions, which process is which post).
export function opTo(op) {
  const kind = OP_OF[op.t];
  if (!kind) return null;
  const { t, seq, at, ...args } = op;
  return { kind, seq, at, args: fit(OPS[kind].fields, args) };
}

// An op's fields cut to what the server takes, so a long reply or a long command shows cut short rather than not
// at all: text past its length ends in "…", a list past its count loses its tail, and an optional field too big to
// send is left out. What can't be fitted is sent as it is, and refused.
function fit(fields, args) {
  const out = { ...args };
  for (const [name, spec0] of Object.entries(fields)) {
    const optional = name.endsWith("?");
    const key = optional ? name.slice(0, -1) : name;
    const spec = typeof spec0 === "string" ? { type: spec0 } : spec0;
    const v = out[key];
    if (v == null) continue;
    if (spec.type === "string" && typeof v === "string" && v.length > (spec.max ?? 2000)) out[key] = `${v.slice(0, (spec.max ?? 2000) - 1)}…`;
    else if (spec.type === "array" && Array.isArray(v) && v.length > (spec.max ?? 100)) out[key] = v.slice(0, spec.max ?? 100);
    if (optional && spec.bytes && (spec.type === "any" || typeOf(out[key]) === spec.type) && size(out[key]) > spec.bytes) delete out[key];
  }
  return out;
}

/* ---------- state: all a machine has, the first time ---------- */

// The one thing a machine sends that no op covers: everything its store has, once, when this server has nothing of it
// (relay.mjs takeState). Every record in it is checked field by field, as the ops that make it are: a field its
// store writes as text is text, a list a list of what goes in it, and what an op hands over as it is (a widget's
// data, a PR's GitHub record, a reply's shape) no more than an object here either. A field it doesn't know isn't
// taken, so what the page reads is only these. And what this server says of a thread (its group, its WIP, the page
// it's on) is its own to say again, not the machine's to send. Text isn't held to an op's length: a thread's
// history holds more than one op carries.
const T = { type: "string", max: 1e7, nullable: true };
const TB = { type: "boolean", nullable: true };
const TN = { type: "number", nullable: true };
const TO = { type: "object", nullable: true };
const TA = { type: "any" };
const KEY = { type: "string", max: 1000 };
const list = (items) => ({ type: "array", items, max: 1e6 });
const record = (fields) => ({ type: "object", fields, extra: "drop" });
export const STATE = {
  sessions: {
    id: KEY,
    updated: KEY,
    ...Object.fromEntries(
      ["agent", "label", "proc", "session_id", "title", "text", "prompt", "ai_title", "doing", "state", "failed", "started", "ended", "end_reason", "turn_started", "turn_ended", "slept", "sleep_reason", "cwd", "root", "repo", "branch", "host", "transcript", "launch", "cloud", "app", "started_from", "url", "model", "model_pick", "archived_at", "hidden_at", "pinned_at", "landed", "queue_paused", "visibility"].map((k) => [`${k}?`, T]),
    ),
    ...Object.fromEntries(["archived", "hidden", "pinned", "asleep", "busy", "channel", "show_work"].map((k) => [`${k}?`, TB])),
    "rev?": TN,
    // What post.snapshot and post.hello take as they are.
    ...Object.fromEntries(["pid", "context", "plan", "stats", "skill_uses"].map((k) => [`${k}?`, TA])),
    "shape?": TO,
    "updates?": list(record({ "at?": T, "text?": T, "link?": T, "changes?": TO, "pr?": TO })),
    "prs?": { type: "object", values: record({ "url?": T, "number?": TN, "repo?": T, "at?": T, "how?": T, "off?": TB, "gh?": TO }) },
    "attachments?": { type: "object", values: record({ "key?": T, "type?": T, "title?": T, "data?": TO, "created?": T, "updated?": T }) },
    "runs?": { type: "object", values: record({ "mid?": T, "block?": TN, "state?": T, "by?": T, "started?": T, "ended?": T, "exit?": TN, "signal?": T, "out?": T, "cut?": TB, "error?": T }) },
    "skills?": list({ type: "object" }),
    "loops?": list({ type: "object" }),
    "copies?": list({ type: "string", max: 1000 }),
  },
  agents: { id: KEY, name: KEY, "glyph?": T, "kind?": T, "host?": T, "version?": T, "created?": T, "hidden?": TB, "bio?": S(500), "avatar?": TO, "avatar_default?": TO },
  launches: {
    id: KEY,
    ...Object.fromEntries(["agent", "root", "cwd", "branch", "prompt", "at", "post", "teleport", "visibility", "step", "task", "page", "group", "model", "effort", "error", "session", "archived"].map((k) => [`${k}?`, T])),
    ...Object.fromEntries(["resume", "named", "mirrored", "arrived", "noted"].map((k) => [`${k}?`, TB])),
    "files?": list({ type: "string", max: 1000 }),
    "routine?": TO,
    "cloning?": TA,
    "progress?": TA,
  },
  questions: {
    id: KEY,
    post: KEY,
    ...Object.fromEntries(["kind", "title", "detail", "preview", "default", "until", "key", "request_id", "tool_name", "asked", "answered", "by", "file_id"].map((k) => [`${k}?`, T])),
    ...Object.fromEntries(["hook", "blocks", "other"].map((k) => [`${k}?`, TB])),
    "options?": list({ type: "object" }),
    "value?": TA,
    "file?": TO,
    "routine?": TO,
  },
  files: {
    id: KEY,
    "post?": T,
    ...Object.fromEntries(["from", "name", "title", "stored", "blob", "type", "at", "ref"].map((k) => [`${k}?`, T])),
    ...Object.fromEntries(["draft", "embedded", "pending"].map((k) => [`${k}?`, TB])),
    "size?": TN,
    "remote?": TA,
  },
  messages: {
    id: KEY,
    post: KEY,
    ...Object.fromEntries(["from", "via", "text", "at", "ext", "file_id", "command", "resume", "when"].map((k) => [`${k}?`, T])),
    ...Object.fromEntries(["queued", "waited", "held"].map((k) => [`${k}?`, TB])),
    // A message's files, each { id, name, size } (an id alone, from before).
    "files?": list({ type: ["object", "string"] }),
    "shape?": TO,
    "failed?": TO,
    "routine?": TO,
  },
};
const MAPS = ["agents", "sessions", "launches", "procs"];
const LISTS = ["questions", "files", "messages"];

// A machine's state, checked: { state } (a copy, with only what's checked in it), or { error } and none of it.
export function stateFrom(raw) {
  if (typeOf(raw) !== "object" || typeof raw.seq !== "number") return { error: "that isn't a machine's state" };
  const state = { seq: raw.seq };
  for (const part of [...MAPS, ...LISTS]) {
    const v = raw[part];
    if (v === undefined) continue;
    if (typeOf(v) !== (MAPS.includes(part) ? "object" : "array")) return { error: `that machine's ${part} isn't a machine's state` };
    state[part] = structuredClone(v);
  }
  // A process names its post (a checkpoint can't write one that doesn't).
  for (const x of Object.values(state.procs || {})) if (typeof x !== "string") return { error: "that machine's procs aren't a machine's state" };
  for (const part of Object.keys(STATE)) {
    const records = MAPS.includes(part) ? Object.entries(state[part] || {}) : (state[part] || []).map((x) => [null, x]);
    for (const [key, x] of records) {
      const err = check(STATE[part], x, { extra: "drop", where: `${part}: ` }) || (key !== null && x.id !== key ? `${part}: ${key} has another id` : null);
      if (err) return { error: `that machine's ${part} aren't a machine's state (${err})` };
    }
  }
  return { state };
}

/* ---------- info: what a machine knows right now ---------- */

// Keys of a machine's info, each replaced whole when it changes: the machine itself, its folders, an agent's
// extras ("agent:<id>"), a post's runtime and what it's doing this moment ("post:<id>").
export const INFO = {
  machine: OBJ(64 * 1024),
  folders: OBJ(2 * 1024 * 1024),
  agent: OBJ(256 * 1024),
  post: OBJ(256 * 1024),
  // A machine in a cloud sandbox: whether stopping it now would cut something off (`busy`), and when its
  // agentbook-cli started (`started`). Its server moves the sandbox's auto-stop by it (cloud.mjs, "Sleeping").
  pace: OBJ(1024),
};
export const infoKind = (key) => (key === "machine" || key === "folders" || key === "pace" ? key : key.startsWith("agent:") ? "agent" : key.startsWith("post:") ? "post" : null);

/* ---------- commands: what someone did on the page ---------- */

// `steer`: it acts on the machine's agents or folders, so it must be its owner's doing (the gate checks `by`).
// `expires`: how long it waits for a machine that's off before it's dropped. A message's or a start's `note`: what
// the pages and widgets it names showed when it was written (mentions.mjs), handed to its agent with it, not shown.
// `secret`: it carries a secret (a gateway's setup code or token), so the server holds it in memory only, never
// in its database, and doesn't list it as waiting. `now`: it's only of use to someone waiting on it this moment (a
// terminal opening), so it's held the same way.
const FILE_REF = { type: "object", fields: { id: ID, name: S(300), "size?": N, "sha?": S(80), "type?": S(120) } };
export const COMMANDS = {
  "post.start": { steer: true, expires: 3600e3, fields: { lid: ID, agent: ID, prompt: S(12000), "root?": S(2000), "branch?": S(200), "base?": S(200), "worktree?": B, "fresh?": B, "clone?": S(1000), "repo?": S(1000), "files?": ARR(FILE_REF, 20), "model?": S(80), "effort?": S(20), "task?": S(600), "page?": S(120), "page_root?": S(2000), "for_note?": S(120), "for_talk?": S(120), "visibility?": S(20), "note?": S(16000), "routine?": ROUTINE_REF, "group?": S(120), "ok?": OK } },
  // `queue`: while its turn runs, it waits for the turn to end.
  "post.deliver": { steer: true, expires: 7 * 86400e3, fields: { post: ID, "text?": S(12000), "files?": ARR(FILE_REF, 20), "bare?": B, "note?": S(16000), "routine?": ROUTINE_REF, "queue?": B, "command?": S(100), "ok?": OK } },
  "post.answer": { steer: true, expires: 60e3, fields: { post: ID, qid: ID, "value?": { type: "string", max: 2000, nullable: true }, "skip?": B, "archived?": B, "user?": { type: "string", max: 80, nullable: true }, "file?": FILE_REF } },
  "post.notify": { steer: true, expires: 7 * 86400e3, fields: { post: ID, event: OBJ(16 * 1024), "ok?": OK } },
  // A side thread: what you wrote, to a new session that goes on from the thread's conversation so far, in its folder.
  "post.side": { steer: true, expires: 3600e3, fields: { post: ID, text: S(12000), "files?": ARR(FILE_REF, 20), "note?": S(16000) } },
  "post.stop": { steer: true, expires: 60e3, fields: { post: ID, "force?": B } },
  "post.model": { steer: true, expires: 3600e3, fields: { post: ID, model: { type: "string", max: 80, nullable: true } } },
  "post.sleep": { steer: true, expires: 3600e3, fields: { post: ID, reason: S(200) } },
  "post.apply": { steer: true, expires: 60e3, fields: { post: ID, "root?": S(2000) } },
  // A code block in one of a post's messages, run in the post's folder in a shell of its own (`block`: which of the
  // message's, as the page numbers them; `code`: its lines as you saw them, which the machine finds in that message
  // before it runs anything); and one that's running, stopped.
  "post.run": { steer: true, expires: 60e3, fields: { post: ID, mid: ID, block: N, code: S(RUN_CODE_MAX) } },
  "post.run_stop": { steer: true, expires: 60e3, fields: { post: ID, mid: ID, block: N } },
  // A message of yours that couldn't be delivered: sent again as it was kept (so unsigned: it can't say anything new),
  // or deleted.
  "post.resend": { steer: true, expires: 3600e3, fields: { post: ID, mid: ID } },
  "post.discard": { steer: true, expires: 3600e3, fields: { post: ID, mid: ID } },
  // A turn an API error cut off, picked up now (Retry): its agent is told to carry on, in words of agentbook's own,
  // so unsigned, like the tries its machine makes by itself.
  "post.pickup": { steer: true, expires: 60e3, fields: { post: ID } },
  // Its queue: one sent now or dropped (`mid`), or all of it paused, resumed (its next one going in if it's done),
  // or cleared. Unsigned: it can only send what you signed as you queued it, or nothing.
  "post.queue": { steer: true, expires: 3600e3, fields: { post: ID, op: { type: "string", enum: ["now", "drop", "pause", "resume", "clear"] }, "mid?": ID } },
  "cloud.pull": { steer: true, expires: 600e3, fields: { ref: S(1000), "root?": S(2000), "visibility?": S(20), "lid?": ID } },
  "routine.do": { steer: true, expires: 600e3, fields: { agent: ID, job: S(500), action: { type: "string", enum: ["run", "pause", "resume", "stop"] } } },
  "page_routine.run": { steer: true, expires: 600e3, fields: { rid: S(100), "page?": { type: "string", max: 120, nullable: true }, code: S(110 * 1024), reach: OBJ(16 * 1024), keeps: ARR(S(60), 60), "memo?": OBJ(70 * 1024), "last?": { type: "object", bytes: 1024, nullable: true }, "timeout?": N, widgets: OBJ(4 * 1024 * 1024), "root?": S(2000), "filters?": OBJ(4096), "ranges?": OBJ(4096), "params?": OBJ(8192), "live?": B, "ok?": OK } },
  "wip.clean": { steer: true, expires: 600e3, fields: { root: S(2000), branch: S(300) } },
  "wip.discard": { steer: true, expires: 600e3, fields: { root: S(2000), branch: S(300), "sha?": S(64) } },
  "workspace.clone": { steer: true, expires: 3600e3, fields: { url: S(1000) } },
  // A cloud machine runs its image's script on its own disk (an Update to a newer version): what agentbook-server
  // wrote for that version, which its owner signed. Not kept waiting long: an update is for a machine that's on.
  "cloud.setup": { steer: true, expires: 600e3, fields: { script: S(70000), v: N } },
  // A shared machine's owner adds someone to it, or takes them off: { envelope: { v: 1, kind: "members.change",
  // machine, user, at, remove? }, sig }. The machine's root helper checks an add is signed by its owner's passkey
  // (plugin/cli/seat-helper.mjs); taking someone off isn't signed.
  "members.change": { steer: true, expires: 24 * 3600e3, fields: { change: OBJ(64 * 1024) } },
  // A login agentbook-server made for a member's seat there, for the helper to put in their home. It holds what picks
  // their machine's token up, so it's kept in memory only, and not for long.
  // A person's own secret on their seat of a shared machine: set, or with no value, taken away. Its value is kept
  // in their home there and nowhere else, so this is held in memory only on its way.
  "seat.secret": { steer: true, secret: true, expires: 600e3, fields: { name: S(128), "value?": S(20000) } },
  "members.enroll": { steer: true, secret: true, expires: 600e3, fields: { user: S(40), enroll: OBJ(4096) } },
  // Claude Code told to trust a folder, as its trust prompt there would; with `lid`, a start that failed for want
  // of that trust, started again there.
  "folder.trust": { steer: true, expires: 3600e3, fields: { path: S(2000), "lid?": ID } },
  // A thread's folder that's gone, put back one of the ways read.folder says (its branch checked out there again, a
  // copy of it, its repo's default branch, or an empty folder): never over a folder that's there.
  "folder.restore": { steer: true, expires: 600e3, fields: { post: ID, way: { type: "string", enum: ["checkout", "copy", "base", "empty"] } } },
  // A group's files as they stand (each path's latest version: its sha256, or that it was deleted), for the
  // machine's copy of its folder (group-files.mjs); and the group a post is in now.
  "group.sync": { steer: true, expires: 7 * 86400e3, fields: { gid: S(80), files: ARR({ type: "object", fields: { path: S(300), v: N, "sha?": { type: "string", max: 64, nullable: true }, "size?": N, "deleted?": B } }, 5000, 2 * 1024 * 1024), "archived?": B } },
  "post.group": { steer: true, expires: 7 * 86400e3, fields: { post: ID, gid: { type: "string", max: 80, nullable: true } } },
  // The task a post is on now that ships more than it does (null: none): it hears that task's news with its next
  // message (task-ship.mjs). Its name is from when that was a WIP's.
  "post.wip": { steer: true, expires: 7 * 86400e3, fields: { post: ID, sid: { type: "string", max: 20, nullable: true } } },
  // The page a post's person put it on by hand (null: took it off one): it hears so with its next message.
  "post.page": { steer: true, expires: 7 * 86400e3, fields: { post: ID, pid: { type: "string", max: 120, nullable: true } } },
  // The passkeys a machine that keeps none is to take signed commands from, as its person turns signing on for it;
  // and a change of them, signed by one it keeps.
  "keys.pin": { steer: true, expires: 3600e3, fields: { pin: OBJ(64 * 1024) } },
  "keys.change": { steer: true, expires: 7 * 86400e3, fields: { change: OBJ(64 * 1024) } },
  // Who else may steer one of its agents: its owner's passkey signs giving it; taking it
  // back needs no signature.
  "operators.change": { steer: true, expires: 7 * 86400e3, fields: { change: OBJ(64 * 1024) } },
  "openclaw.pair": { steer: true, secret: true, expires: 600e3, fields: { "disconnect?": B, "admin?": B, "setup_code?": S(8000), "url?": S(500), "token?": S(500), "password?": S(500) } },
  // An agent that runs on its vendor's computers (Claude Agent, Devin), connected on this machine: its key and what
  // goes with it stay here and never come back out.
  "remote.connect": { steer: true, secret: true, expires: 600e3, fields: { vendor: S(20), "disconnect?": B, "key?": S(500), "org?": S(200), "github_token?": S(500), "budget?": S(20) } },
  // A terminal for its owner: a shell in the post's folder, as the machine has it (never one the server names), at
  // `cols` by `rows`. What's typed in it and what it shows go on the terminal's own line (`tid`), not as commands
  // (server/terminals.mjs, cli/terminals.mjs). It doesn't wait for a machine that's off.
  "term.open": { steer: true, now: true, expires: 30e3, fields: { tid: S(60), post: ID, cols: N, rows: N } },
  // Claude Code signed in again on the machine, from a thread its expired login cut off (cli/claude-signin.mjs):
  // `claude auth login` started there, its link to sign in to claude.ai with as the answer ("start"); then the code
  // claude.ai showed (`code`), for it to finish with. The code is held in memory only, and neither waits for a
  // machine that's off.
  "claude.login": { steer: true, secret: true, now: true, expires: 60e3, fields: { step: { type: "string", enum: ["start", "code"] }, "code?": S(2000) } },
  // More time to type in an open terminal, signed as opening one is (plugin/cli/terminals.mjs).
  "term.lease": { steer: true, now: true, expires: 30e3, fields: { tid: S(60) } },
};

/* ---------- reads: what only the machine knows ---------- */

// `keep`: what the server keeps of an answer. "last": the latest, shown with when it was read while the machine is
// off (it's asked again whenever it's on). "forever": it never changes (a commit, a picture), so it's asked once.
// Nothing: not kept. `owner`: only the machine's owner may ask (the rest the server decides who sees).
export const READS = {
  "read.folders": { keep: "last", owner: true, fields: { "path?": S(2000) } },
  "read.branches": { keep: "last", owner: true, fields: { root: S(2000) } },
  "read.runtimes": { keep: "last", owner: true, fields: {} },
  "read.openclaw": { keep: "last", owner: true, fields: {} },
  "read.remote": { keep: "last", owner: true, fields: {} },
  "read.wip": { keep: "last", owner: true, fields: { root: S(2000), branch: S(300) } },
  "read.wip_diff": { keep: "last", owner: true, fields: { root: S(2000), branch: S(300), "path?": S(2000), "scope?": S(20) } },
  "read.agent_routines": { keep: "last", owner: true, fields: { agent: ID } },
  "read.agent_limits": { keep: "last", owner: true, fields: { agent: ID } },
  "read.agent_routine": { keep: "last", owner: true, fields: { agent: ID, job: S(500), "offset?": N } },
  "read.agent_routine_run": { keep: "last", owner: true, fields: { agent: ID, job: S(500), session: S(500) } },
  "read.agent_files": { keep: "last", owner: true, fields: { agent: ID, "dir?": S(2000) } },
  "read.agent_file": { keep: "last", owner: true, fields: { agent: ID, path: S(2000) } },
  "read.file": { keep: "last", owner: true, fields: { post: ID, path: S(2000) } },
  "read.peek": { owner: false, fields: { root: S(2000), path: S(2000), "via?": S(300), "range?": S(100), "stream?": B } },
  "read.skill": { keep: "last", owner: false, fields: { agent: ID, name: S(300), "roots?": ARR(S(2000), 50) } },
  "read.commands": { keep: "last", owner: true, fields: { post: ID } },
  // Whether a thread's folder is gone, and what can put it back. Not kept: it's only of use as it is now.
  "read.folder": { owner: true, fields: { post: ID } },
  "read.steps": { keep: "last", owner: false, fields: { post: ID } },
  "read.worker": { keep: "last", owner: false, fields: { post: ID, worker: S(300) } },
  "read.changes": { keep: "last", owner: false, fields: { post: ID, "scope?": S(40) } },
  "read.change_file": { keep: "last", owner: false, fields: { post: ID, path: S(2000), "scope?": S(40) } },
  "read.step_diff": { keep: "last", owner: false, fields: { post: ID, step: S(200) } },
  "read.commit": { keep: "forever", owner: false, fields: { post: ID, sha: S(64) } },
  "read.image": { keep: "forever", owner: false, fields: { post: ID, step: S(200), i: N } },
  "read.media": { owner: false, fields: { post: ID, file: ID, "range?": S(100), "stream?": B } },
  "read.cloud_diff": { keep: "last", owner: false, fields: { post: ID } },
};

// A command or a read, checked as the CLI receives it: null when it's fine, else why not.
// What this side takes of each command, by field: a machine says it at hello, so its server can fit what it sends
// to what it knows, before anyone signs it (signed args can't be trimmed later).
export const takenFields = () => Object.fromEntries(Object.entries({ ...COMMANDS, ...READS }).map(([k, s]) => [k, Object.keys(s.fields).map((f) => f.replace(/\?$/, ""))]));

export function checkCommand(c) {
  if (typeOf(c) !== "object") return "a command isn't an object";
  const spec = COMMANDS[c.kind] || READS[c.kind];
  if (!spec) return `${c.kind} isn't a command agentbook-cli takes`;
  return check(spec.fields, c.args ?? {}, { extra: "refuse", where: `${c.kind}: ` });
}
