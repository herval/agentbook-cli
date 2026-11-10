// OpenClaw agents and their sessions, through OpenClaw's gateway. agentbook reaches it one of two ways:
//
// - Directly, when it's given a setup code, or the gateway's address and token (on Add agents, or
//   AGENTBOOK_OPENCLAW_URL and AGENTBOOK_OPENCLAW_TOKEN): a WebSocket connection of its own
//   (openclaw-gateway.mjs), approved once on the gateway as a device, whose events update posts right away.
//   Kept in ~/.agentbook/openclaw.json.
// - Otherwise through this machine's `openclaw` command (`openclaw gateway call <method> --params <json>
//   --json`), which knows where its gateway is and how to sign in to it.
//
// - Each OpenClaw agent is a profile ("openclaw-main", named after its identity, with its identity's avatar),
//   and each of its sessions (a session key) a post. Subagents stay off. So do cron runs, as sessions of their own:
//   a cron job is one post, each run adding to it (see threadJob).
// - agentbook lists sessions every few seconds and reads the history of the ones that changed: their messages
//   are the post's conversation, their tool calls its steps. Connected to its gateway, what's added to a
//   session's history comes as it's written too (session.message). An agent on the claude-cli runtime keeps only its
//   replies in OpenClaw; its steps stay in Claude Code's transcript on the gateway's machine.
// - Exec approvals are Allow/Deny on the post, and the agent's questions (its ask_user tool) are polls.
// - Posting on an agent's wall creates a session, which works in the agent's own workspace; writing on a post
//   sends it a message (steering the turn that's running); Stop aborts the turn.
// - An agent's routines are its cron jobs, on its profile, with their runs. OpenClaw keeps one session per job, each
//   run taking it over, so a job's post is what agentbook saw of them: a run that reported something is what the job
//   told its agent and what it answered, and moves the post up the feed. One with nothing to report (NO_REPLY) doesn't
//   show. OpenClaw refuses messages in a job's session, so its post takes none.
// - An agent's skills are the ones its gateway says it can use (skills.status), on its profile, with how often
//   its sessions read each.
// - Its usage limits (limits.mjs) are its gateway's: how much of each provider's limits the accounts the gateway
//   signs in to have used (usage.status, operator.read), the same on each of its agents, when a profile asks.
// - Its agents have agentbook's tools (ab_post, ab_ask…) when its gateway has agentbook's plugin for OpenClaw
//   (plugin/openclaw/): each call comes here over agentbook's connection to it, and is answered as its session's
//   post. Not through the openclaw command, which hears none of the gateway's events.

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ANSWER_WORDS, HOME } from "../../lib/common.mjs";
import { emojiOf, fetchPicture, fromDataUrl, pictureOf } from "../../shared/pictures.mjs";
import { failedRoutines } from "../../shared/cron.mjs";
import { conversationOf, outOfMemory } from "../../shared/store.mjs";
import { ADMIN, ADMIN_SCOPES, connectGateway, hasAdmin, makeIdentity } from "./openclaw-gateway.mjs";
import { addSay, addTool, blank, deliverer, iso, liveOf, short, skillUses, summaryOf, toolDone, toolTitle } from "./steps.mjs";
import { going as workerGoing, shown as shownWorkers, stateOf } from "../workers.mjs";
import { limitsReader, openclawLimitsOf } from "../limits.mjs";

const DAYS = Number(process.env.AGENTBOOK_OPENCLAW_DAYS || 0); // only sessions active in the last DAYS days (0: all of them)
const PAGE = Number(process.env.AGENTBOOK_OPENCLAW_PAGE || 200); // sessions listed per call
const READERS = 4; // histories read at once while catching up with sessions agentbook hasn't read yet
// What OpenClaw keeps in place of a message too big for its history: nothing anyone said.
const OMITTED = /^\[Claude CLI history record omitted/;
const QUIET_MS = 60 * 60e3; // a session idle this long is over, until it's active again
// A cron job's own session, which each run of it takes over, and the job's id. The key a run has of its own
// (":run:<id>") is only in cron.runs, and a webhook's run has a key like this with no job behind it.
const JOB_KEY = /^agent:[^:]+:cron:([^:]+)$/;
const AGENT = "openclaw-"; // agentbook's id for OpenClaw's agent "main" is "openclaw-main"
const CONFIG = () => path.join(HOME, "cli", "openclaw.json"); // { url, token | password | bootstrapToken (and expiresAt), device: { deviceId, publicKey, privateKey, deviceToken } }
// The gateway's events that mean a post may have changed: look again at once.
const EVENTS = new Set(["sessions.changed", "session.message", "session.tool", "chat", "exec.approval.requested", "exec.approval.resolved", "question.requested", "question.resolved", "cron", "skills.changed"]);
const CRON_MS = Number(process.env.AGENTBOOK_OPENCLAW_CRON_MS || 30000); // how often its routines are listed
const SKILLS_MS = Number(process.env.AGENTBOOK_OPENCLAW_SKILLS_MS || 30 * 60e3); // how often its agents' skills are listed
// agentbook's plugin for OpenClaw, which gives its agents agentbook's tools: installed on the gateway's machine.
export const PLUGIN_DIR = fileURLToPath(new URL("../../openclaw/", import.meta.url)).replace(/\/$/, "");

const textOf = (content) =>
  typeof content === "string"
    ? content
    : (content || [])
        .filter((c) => c?.type === "text")
        .map((c) => c.text)
        .join("\n");
const keyAgent = (key) => String(key).split(":")[1] || "main"; // "agent:<agent id>:…"

// What a reply says, and the files its MEDIA: lines send (`sent`). An agent sends a file by naming it on a
// line of its own, outside code: `MEDIA:<where it is>`, a path on the gateway's machine, a link or a file's
// name. OpenClaw sends the file and leaves the line out; so does agentbook, which shows the file with the
// reply instead (see sentOf), and leaves out the blank line around it too. A link stays, as a picture or a
// link. "Media: three clips" is just words.
const MEDIA_LINE = /^\s*MEDIA:\s*[`"'([{]*(?:[\w+.-]+:\/\/|(?:file|data):|[~/\\.]|[a-z]:[\\/]|[^\s:]*[\\/]|\S+\.\w{1,10}\W*$)/i;
const FENCE = /^\s*(`{3,}|~{3,})/;
const PICTURE = /\.(png|jpe?g|gif|webp)([?#]|$)/i;
export function mediaLines(text) {
  const sent = [];
  if (!/MEDIA:/i.test(text || "")) return { text: text || "", sent };
  const out = [];
  let fence = null;
  let cut = false;
  for (const line of text.split("\n")) {
    const f = FENCE.exec(line)?.[1];
    if (f && !fence) fence = f;
    else if (f && f[0] === fence[0] && f.length >= fence.length) fence = null;
    else if (!fence && MEDIA_LINE.test(line)) {
      const where = line.replace(/^\s*MEDIA:\s*/i, "").trim().replace(/^[`"'[{(]+/, "").replace(/[`"'\\})\],]+$/, "");
      if (/^https?:\/\//i.test(where)) out.push(PICTURE.test(where) ? `![](${where})` : where);
      else if (where && !/^data:/i.test(where)) sent.push(where);
      cut = !/^https?:\/\//i.test(where);
      continue;
    }
    if (cut && !line.trim() && !out.at(-1)?.trim()) continue;
    cut = false;
    out.push(line);
  }
  return { text: out.join("\n").trim(), sent };
}
export const withoutMedia = (text) => mediaLines(text).text;

// What you wrote, of a message OpenClaw keeps as yours: without what it put before it (what happened since,
// as "System: …" lines; that it resumed a claude-cli session; the skills you named; where the files you
// sent are and what's in them) or after it (where it saved the files agentbook sent with it; the pictures it
// hands a claude-cli agent, as `@<path>` lines; yours come as the message's media). null when OpenClaw wrote
// all of it: another session's or a tool's result handed to the agent ("[Inter-session message]"), a
// reminder, a command that finished, a turn a restart cut short. OpenClaw says whose a message is (`provenance`), except in a claude-cli agent's
// history, which it reads back from Claude Code's transcript; there its words tell.
const RESUMED = /^OpenClaw resumed this CLI session after prompt content changed\.[^\n]*\n*/;
const NOTES = /^(System:[^\n]*(\n|$))+\s*/;
const SKILLS = /^Use the following explicitly referenced skills for this request\.[^\n]*\n(?:[^\n]*\n)*?\nUser request:\n/;
const CLI_IMAGES = /(\s*@\S*[\\/]\.?openclaw-cli-images[\\/]\S+)+\s*$/;
const CUT = /^[\w:]{0,7}\n?\.\.\.\(truncated\)\.\.\.$/; // all that's left of notes OpenClaw's history cut short
const OPENCLAWS = [/^\[System\] /, /^A scheduled (reminder has been|cron event was) triggered\./, /^An async command (you ran earlier|the user already approved|completion event was triggered|did not run)/];
// A message with files: where each is ("[media attached: …]"), then what OpenClaw saw in them ("[Video]",
// "Description: …"), with what you wrote as "User text:".
const ATTACHED = /^(\[media attached[^\]\n]*\]\s*)+/;
const TYPED = /(?:^|\n)User text:\n([\s\S]*?)(?=\n\[media attached|\n(?:Description|Transcript):\n|\n\n\[(?:Image|Video|Audio)[ \]]|$)/;
const SEEN = /^\[(Image|Video|Audio)( \d+\/\d+)?\]\n/;
const SAVED = /(\s*\[media attached[^\]\n]*\])+\s*$/;
function withoutAttached(t) {
  if (!ATTACHED.test(t)) return t.replace(SAVED, "");
  const typed = TYPED.exec(t);
  if (typed) return typed[1];
  const rest = t.replace(ATTACHED, "");
  return SEEN.test(rest) ? "" : rest;
}
export function yoursOf(text, provenance) {
  if (provenance?.kind && provenance.kind !== "external_user") return null;
  if (String(text || "").includes("[Inter-session message]")) return null;
  const t = withoutAttached(String(text || "").replace(RESUMED, "").replace(NOTES, "").replace(SKILLS, "")).replace(CLI_IMAGES, "").trim();
  return OPENCLAWS.some((re) => re.test(t)) ? null : CUT.test(t) ? "" : t;
}
// What a cron job tells its agent, in a session of the job's own or one it names (`--session session:<name>`):
// "[cron:<job> <name>] <its prompt>", then the time and what OpenClaw tells a run nobody's watching. It comes with no
// `provenance` (OpenClaw 2026.9.4), so only its words say it isn't yours. { job, name, text }, or null.
const CRON_PROMPT = /^\[cron:(\S{1,100}) (.*?)\]\s*([\s\S]*)$/;
export function cronPrompt(text) {
  const m = CRON_PROMPT.exec(String(text || ""));
  if (!m) return null;
  const tail = m[3].lastIndexOf("\nCurrent time: ");
  return { job: m[1], name: m[2].trim(), text: (tail < 0 ? m[3] : m[3].slice(0, tail)).trim() };
}

// What a history entry is, past its role. A message from elsewhere (a cron job, another session) came in as a user
// message, but the gateway shows it as "Forwarded from …", with role assistant: it starts a turn, and it's nobody's
// reply. A claude-cli agent's history is read back from Claude Code's transcript, where a tool's result is a message
// from the user: it starts nothing. And after that transcript comes OpenClaw's own record of the run: all it said in
// the turn joined into one, which the last of what it said has already answered. (Read from a real claude-cli
// job's history, 2026-11-07.)
const forwarded = (m) => m?.role === "assistant" && !!(m.senderSession || m.provenance?.kind);
const toolResults = (m) => m?.role === "user" && Array.isArray(m.content) && m.content.length > 0 && m.content.every((c) => /^tool_?result$/i.test(c?.type || ""));
const startsTurn = (m) => (m?.role === "user" && !toolResults(m)) || forwarded(m);
const midTurn = (m) => m?.role === "toolResult" || toolResults(m) || /^tool_?use$/i.test(m?.stopReason || "");
const joined = (m) => m?.role === "assistant" && String(m.idempotencyKey || m.__openclaw?.idempotencyKey || "").startsWith("cli-assistant:");

// The pictures, sound, video and files in a message. OpenClaw keeps each as a piece of the message's content
// (an image, audio or video piece, or an attachment's), and its history leaves their bytes out. A file
// agentbook makes of one keeps how to ask OpenClaw for it (see media): its artifact id when it has one (what
// the agent made), or else where it is (a picture you sent): its message's place in the transcript (`seq`),
// and which of that message's media it is.
const KINDS = { image: "image", input_image: "image", image_url: "image", audio: "audio", input_audio: "audio", video: "video", input_video: "video", file: "file", input_file: "file", attachment: "file" };
const EXT = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/svg+xml": "svg", "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/wav": "wav", "audio/x-wav": "wav", "audio/ogg": "ogg", "application/pdf": "pdf", "text/plain": "txt", "text/markdown": "md", "text/csv": "csv", "application/json": "json" };
const NAMED = { image: "picture", audio: "sound", video: "video", file: "file" };
const MIME = { ...Object.fromEntries(Object.entries(EXT).map(([mime, ext]) => [ext, mime])), jpeg: "image/jpeg", wav: "audio/wav", heic: "image/heic" };
function mediaOf(m, seq) {
  const out = [];
  for (const c of Array.isArray(m?.content) ? m.content : []) {
    const kind = KINDS[String(c?.type || "").toLowerCase()];
    if (!kind) continue;
    const a = c.attachment && typeof c.attachment === "object" ? c.attachment : c;
    const mime = String(a.mimeType || a.media_type || a.source?.media_type || a.source?.mimeType || "").toLowerCase().split(";")[0].trim();
    const title = [c.fileName, c.filename, a.label, c.title, c.alt].find((v) => typeof v === "string" && v.trim())?.trim() || null;
    out.push({ name: nameOf(title, mime, kind), size: Number(a.sizeBytes ?? a.source?.sizeBytes ?? c.bytes) || 0, ref: { artifact: c.artifactId || a.artifactId || null, seq: Number.isInteger(seq) ? seq : null, n: out.length, type: kind, title } });
  }
  return out;
}
// Its name, with the extension its kind of file has, so it shows (and plays) as what it is: a picture named
// .png that OpenClaw keeps as a JPEG is a .jpg.
const MEDIA_EXT = /\.(png|jpe?g|gif|webp|svg|mp4|mov|m4v|webm|mp3|m4a|wav|ogg)$/i;
function nameOf(title, mime, kind) {
  const base = path.posix.basename(String(title || NAMED[kind]).replace(/\\/g, "/")).replace(/[^\w.\- ]+/g, "_").slice(0, 80).trim() || NAMED[kind];
  const ext = EXT[mime] || "";
  if (!ext || new RegExp(`\\.${ext === "jpg" ? "jpe?g" : ext}$`, "i").test(base)) return base;
  return `${MEDIA_EXT.test(base) && !mime.startsWith("text/") ? base.replace(MEDIA_EXT, "") : base}.${ext}`;
}
// The files a reply's MEDIA: lines send, as files that say where each is on the gateway's machine (`source`),
// named as OpenClaw names them: one it keeps as "<name>---<uuid>.<ext>" is <name>.<ext>. Their size is known
// once one is fetched.
const MIMES = { ...Object.fromEntries(Object.entries(EXT).map(([mime, ext]) => [ext, mime])), jpeg: "image/jpeg", m4v: "video/mp4", wav: "audio/wav" };
const KEPT_AS = /---[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?=\.\w+$|$)/i;
export function sentOf(sources, seq = null) {
  return sources.map((source) => {
    const base = path.posix.basename(source.replace(/\\/g, "/"));
    const mime = MIMES[(/\.(\w{1,10})$/.exec(base)?.[1] || "").toLowerCase()] || "";
    const kind = /^(image|video|audio)\//.exec(mime)?.[1] || "file";
    const title = base.replace(KEPT_AS, "");
    return { name: nameOf(title, mime, kind), size: 0, ref: { source, seq: Number.isInteger(seq) ? seq : null, type: kind, title } };
  });
}
const sentIn = (m) => (Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }]).filter((c) => String(c?.type || "").toLowerCase() === "text").flatMap((c) => mediaLines(c.text).sent);
// The files an agent sent with OpenClaw's message tool while it worked (a claude-cli agent's is
// mcp__openclaw__message): Discord shows each with what it sent, the agent's reply says it "posted it above",
// and here they're that reply's files, as a MEDIA: line's are. Only what it sent where you talk to it: a send
// naming no other route (OpenClaw sends it to this conversation), or one naming this conversation (the session
// key's last part, its channel's id). A link, or bytes in the call itself (`buffer`), isn't a file on the
// gateway's machine.
const MESSAGE_TOOL = /^(?:\w+__)?message$/i;
const SENDS = new Set(["send", "sendwitheffect", "sendattachment", "reply", "thread-reply", "upload-file"]);
const ROUTES = ["target", "targets", "to", "recipient", "recipients", "chatId", "chat_id", "channelId", "channel_id", "conversationId", "conversation_id", "threadId", "thread_id", "roomId", "room_id", "groupId", "group_id"];
const MEDIA_ARGS = ["media", "mediaUrl", "path", "filePath", "fileUrl", "url"];
const firstOf = (a, keys) => keys.map((k) => a?.[k]).find((v) => typeof v === "string" && v.trim())?.trim();
function toolSent(m, key) {
  const out = [];
  const here = String(key).split(":").at(-1);
  for (const c of Array.isArray(m?.content) ? m.content : []) {
    const type = String(c?.type || "").toLowerCase();
    if ((type !== "toolcall" && type !== "tool_use") || !MESSAGE_TOOL.test(String(c.name || ""))) continue;
    let a = c.arguments ?? c.input;
    if (typeof a === "string") {
      try {
        a = JSON.parse(a);
      } catch {
        a = null;
      }
    }
    if (!a || typeof a !== "object" || !SENDS.has(String(a.action || "").toLowerCase()) || a.dryRun === true || a.dry_run === true) continue;
    const routes = ROUTES.flatMap((f) => [a[f]].flat()).filter((v) => (typeof v === "string" && v.trim()) || typeof v === "number").map(String);
    if (routes.length && !routes.some((v) => v.includes(here))) continue;
    const one = firstOf(a, MEDIA_ARGS.slice(0, -1));
    if (one) out.push(one);
    for (const u of Array.isArray(a.mediaUrls) ? a.mediaUrls : []) if (typeof u === "string" && u.trim()) out.push(u.trim());
    for (const x of Array.isArray(a.attachments) ? a.attachments : []) {
      const v = firstOf(x, MEDIA_ARGS);
      if (v) out.push(v);
    }
  }
  return [...new Set(out)].filter((s) => !/^(?:https?|data):/i.test(s));
}
// A file a turn sent twice (with a MEDIA: line, and as the media OpenClaw made of it; or in two lines) is on
// its reply once.
const once = (media) => media.filter((x, i) => !x.ref?.source || !media.some((y, j) => y.name.toLowerCase() === x.name.toLowerCase() && (!y.ref?.source || j < i)));

// fn on each of items, n at a time; what it gives, in their order.
async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  const one = async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, one));
  return out;
}

// host: { state, commit, pending, label, describe, attached, changed, fetchFile, refetch, log }
export function createOpenclaw(host) {
  const log = host.log || (() => {});
  const bin = () => process.env.AGENTBOOK_OPENCLAW_BIN || "openclaw";
  let enabled = process.env.AGENTBOOK_OPENCLAW !== "0";
  let connected = false;
  let lastError = null;
  let downSince = null; // since when agentbook can't reach OpenClaw (null while it can, and before it first tried)
  const agents = new Map(); // OpenClaw agent id -> { id, name, workspace, model }
  const sessions = new Map(); // session key -> { updated, active, running, cursor, seen: Set, posted: Set, sent: [], legacy, digest, say, loaded }
  const asked = new Map(); // question request key -> { kind: "approval"|"question", id, asks: Map(question id -> OpenClaw's), answers }
  let workers = new Map(); // post key -> the subagents it started, newest first (see noteWorkers)
  const workerSteps = new Map(); // a subagent's session key -> { title, at }: the tool it last started
  const workerN = new Map(); // a subagent's session key -> how many tools it started: its history's, and those heard since
  let agentsAt = 0;
  let defaultAgent = "main"; // the agent a routine without one runs as
  let jobs = null; // its agents' routines (see routineOf), null until listed or when the gateway has none to list
  let jobsAt = 0;
  let skillsAt = 0;
  let retryAt = 0; // after a failure, wait before asking again: 10s, doubling to 5 minutes
  let backoff = 0;
  let gw = null; // the direct connection to a gateway, when one is set
  let gwState = null;
  // The owner's connection, with admin (openclaw-gateway.mjs's ADMIN_SCOPES): open while agentbook's device token has
  // it, for what this machine's owner does (their own messages, the threads they start, Run now and Pause), never
  // anyone else's. `gwId`: the device both sign in as, one object, so a token either is handed reaches the other.
  let gwAdmin = null;
  let adminState = null;
  let gwId = null;
  // Admin asked for (askAdmin), until the gateway approves it or it lapses: { requestId, at, status, error }, `status`
  // once it's over without admin ("rejected", "expired", "failed", "lost": the gateway took it back).
  let upgrade = null;
  // Whether that gateway has agentbook's plugin, which gives its agents agentbook's tools (see helloTools): {
  // installed, version, missing: tools agentbook has that this version of it doesn't }, or why agentbook couldn't
  // tell; null until it asked, on this connection.
  let tools = null;
  let soonTimer = null;
  const soon = () => {
    clearTimeout(soonTimer);
    soonTimer = setTimeout(() => sync(), 250);
  };

  /* ---------- a gateway of its own ---------- */

  function readConfig() {
    try {
      return JSON.parse(fs.readFileSync(CONFIG(), "utf8"));
    } catch {
      return {};
    }
  }
  function writeConfig(c) {
    fs.mkdirSync(HOME, { recursive: true });
    fs.writeFileSync(CONFIG(), JSON.stringify(c, null, 1) + "\n", { mode: 0o600 });
    fs.chmodSync(CONFIG(), 0o600); // the token and the device's key are in it
  }
  function settings() {
    const c = readConfig();
    const env = process.env.AGENTBOOK_OPENCLAW_URL;
    return { url: env || c.url || null, token: (env ? process.env.AGENTBOOK_OPENCLAW_TOKEN : c.token) || undefined, password: (env ? process.env.AGENTBOOK_OPENCLAW_PASSWORD : c.password) || undefined, bootstrapToken: (!env && c.bootstrapToken) || undefined, expiresAt: (!env && c.expiresAt) || null, fromEnv: !!env };
  }

  function saveIdentity(id) {
    // Once the gateway hands agentbook a device token, the setup code's token is spent.
    const { bootstrapToken, expiresAt, ...c } = readConfig();
    writeConfig({ ...(id.deviceToken ? c : { ...c, bootstrapToken, expiresAt }), device: id });
    if (gwAdmin && !hasAdmin(id)) linkAdmin(); // a token without admin: the owner's connection goes
  }

  // Connect to the gateway set, if there is one (and drop the one before).
  function linkGateway() {
    gw?.close();
    gw = null;
    gwState = null;
    gwAdmin?.close();
    gwAdmin = null;
    adminState = null;
    gwId = null;
    upgrade = null;
    commandLists.clear();
    tools = null;
    const s = settings();
    if (!s.url || !enabled) return;
    let identity = readConfig().device;
    if (!identity?.privateKey) {
      identity = makeIdentity();
      writeConfig({ ...readConfig(), device: identity });
    }
    gwId = identity;
    gw = connectGateway({
      url: s.url,
      token: s.token,
      password: s.password,
      bootstrapToken: s.bootstrapToken,
      identity,
      save: saveIdentity,
      onState: (st) => {
        gwState = st;
        if (st.state !== "connected") tools = null;
        if (st.state === "connected") {
          retryAt = 0;
          backoff = 0;
          lastError = null;
          soon();
          host.refetch?.(); // the files that stopped coming while it was away
          helloTools();
          if (!gwAdmin && hasAdmin(gwId)) linkAdmin(); // and the owner's again, after one that gave up
        }
        reached(st.state === "connected");
      },
      onEvent: (event, payload) => {
        if (event === "cron") jobsAt = 0; // a routine changed, started or finished
        if (event === "skills.changed") skillsAt = 0;
        if (event === "session.message" && heard(payload)) return;
        if (event === "session.tool") workerStep(payload);
        if (event === "plugin.agentbook.call") answerCall(payload);
        if (EVENTS.has(event)) soon();
      },
      log,
    });
  }

  // The owner's connection, while the device token has admin: no events (the everyday one hears them), and given up
  // on, rather than tried again, when the gateway turns it down. Turned down for its scopes (the token was rotated
  // with less on the gateway, or it wants admin approved again), agentbook stops counting on admin.
  function linkAdmin() {
    gwAdmin?.close();
    gwAdmin = null;
    adminState = null;
    const s = settings();
    // Only as its own device: a gateway's token or password signs in with what that gives.
    if (!gw || !gwId || s.token || s.password || !hasAdmin(gwId)) return;
    const conn = connectGateway({
      url: s.url,
      identity: gwId,
      scopes: ADMIN_SCOPES,
      subscribe: false,
      owners: true,
      save: saveIdentity,
      log,
      onState: (st) => {
        if (gwAdmin !== conn) return;
        adminState = st;
        if (st.state === "failed") {
          gwAdmin = null;
          if (/SCOPE|PAIRING_REQUIRED|NO_TOKEN/i.test(st.code || "")) {
            gwId.scopes = (gwId.scopes || []).filter((x) => x !== ADMIN);
            saveIdentity(gwId);
            upgrade = { requestId: null, at: Date.now(), status: "lost", error: st.error || null };
            log(`openclaw: the gateway no longer takes agentbook as an admin (${st.error || st.code}), so it goes on without`);
          }
        }
        commandLists.clear();
        host.changed?.();
      },
    });
    gwAdmin = conn;
  }
  const adminOn = () => !!gwAdmin && adminState?.state === "connected";
  // What its owner does goes over the owner's connection while it's up; everyone else's, and all of it while it isn't
  // (no admin, or reconnecting), over the everyday one, as it did before admin.
  const ownerCall = (method, params, timeout) => (adminOn() ? gwAdmin.rpc(method, params, timeout) : call(method, params, timeout));

  // Ask the gateway for admin, over the everyday connection (device.scopes.requestUpgrade: OpenClaw 2026.8 and
  // later). Its owner approves it there (`openclaw devices approve <requestId>`, or in OpenClaw's app); the approval
  // doesn't close agentbook's connection, and hands it the new device token on it (waitAdmin).
  async function askAdmin() {
    const s = settings();
    if (!gw) throw Object.assign(new Error("agentbook isn't connected to a gateway of its own: connect it with a setup code first."), { status: 409 });
    if (s.token || s.password) throw Object.assign(new Error("agentbook signs in to this gateway with its token, not as a device of its own: connect it with a setup code to give it admin."), { status: 409 });
    if (hasAdmin(gwId) || (upgrade && !upgrade.status)) return connection(); // has it, or asked and waiting
    let r;
    try {
      r = await call("device.scopes.requestUpgrade", { scopes: ADMIN_SCOPES }, 20000);
    } catch (e) {
      if (/unknown method/i.test(e.message)) throw Object.assign(new Error("This gateway's OpenClaw is older than 2026.8, which can't give a device admin while it's connected: update it first."), { status: 409 });
      throw e;
    }
    if (!r?.requestId) throw new Error("OpenClaw didn't say which request to approve");
    upgrade = { requestId: String(r.requestId), at: Date.now() };
    log(`openclaw: asked the gateway for admin (approve it there: openclaw devices approve ${upgrade.requestId})`);
    waitAdmin(gw, upgrade.requestId);
    host.changed?.();
    return connection();
  }
  // Until it's approved, turned down or lapses (the gateway keeps a request 5 minutes). The gateway keeps the request,
  // not the call: one that drops with the connection is made again once it's back.
  async function waitAdmin(conn, requestId) {
    const until = Date.now() + 6 * 60e3;
    const current = () => gw === conn && upgrade?.requestId === requestId && !upgrade.status;
    while (current() && Date.now() < until) {
      let r;
      try {
        r = await conn.rpc("device.scopes.waitUpgrade", { requestId }, Math.max(5000, until - Date.now()));
      } catch (e) {
        if (/closed|not connected|doesn't answer|dropped|didn't answer/i.test(e.message)) {
          await new Promise((ok) => setTimeout(ok, 2000).unref?.());
          continue;
        }
        if (current()) upgrade = { ...upgrade, status: "failed", error: e.message };
        break;
      }
      if (!current()) return;
      if (r?.status === "approved" && r.deviceToken) {
        gwId.deviceToken = r.deviceToken;
        gwId.scopes = Array.isArray(r.scopes) && r.scopes.length ? r.scopes : ADMIN_SCOPES;
        upgrade = null;
        saveIdentity(gwId);
        commandLists.clear();
        log("openclaw: the gateway gave agentbook admin");
        linkAdmin();
      } else upgrade = { ...upgrade, status: r?.status === "expired" ? "expired" : "rejected" };
      break;
    }
    if (current()) upgrade = { ...upgrade, status: "expired" };
    host.changed?.();
  }
  // Admin, for the Add agents page: "off", "asked" (with the request to approve), "on", "connecting", or how it ended
  // without ("rejected", "expired", "failed", "lost").
  function adminOf() {
    if (!gw) return null;
    if (hasAdmin(gwId)) return { state: adminOn() ? "on" : adminState?.state === "failed" ? "failed" : "connecting", error: adminState?.state === "failed" ? adminState.error || null : null };
    if (upgrade) return { state: upgrade.status || "asked", requestId: upgrade.requestId, at: new Date(upgrade.at).toISOString(), error: upgrade.error || null };
    return { state: "off" };
  }

  // Set the gateway to connect to (an address, and its token or password, or a setup code's bootstrap token),
  // or none (null).
  function configure(next) {
    const c = readConfig();
    if (!next) {
      writeConfig({ device: c.device }); // keeps the device's key, so approving it again isn't needed for the same gateway
    } else {
      // A new setup code signs in afresh: a device the gateway still knows gets a new device token at once.
      const device = c.device && c.url === next.url && !next.bootstrapToken ? c.device : c.device && { ...c.device, deviceToken: undefined };
      const auth = next.token ? { token: next.token } : next.password ? { password: next.password } : { bootstrapToken: next.bootstrapToken, expiresAt: next.expiresAt || undefined };
      writeConfig({ url: next.url, ...auth, device });
    }
    linkGateway();
    return connection();
  }

  // Whether agentbook can reach OpenClaw: its agents' rows show it as it changes.
  function reached(ok) {
    downSince = ok ? null : downSince || new Date().toISOString();
    host.changed?.();
  }
  // And for those rows: { state: "connected" | "connecting" | "pairing" | "failed" | "off", error, since }.
  function link() {
    if (!enabled) return { state: "off", error: null, since: null };
    const c = connection();
    const state = c.state === "idle" ? "connecting" : c.state;
    return state === "connected" ? { state, error: null, since: null } : { state, error: c.error || null, since: downSince };
  }

  // How agentbook reaches OpenClaw, for the Add agents page. Never the token.
  function connection() {
    const s = settings();
    if (!gw) return { mode: "command", connected, error: lastError, state: connected ? "connected" : lastError ? "failed" : "idle" };
    const st = gwState || { state: "connecting" };
    const auth = s.token ? "token" : s.password ? "password" : s.bootstrapToken ? "setup-code" : "device";
    return { mode: "gateway", url: s.url, fromEnv: s.fromEnv, auth, ...(auth === "setup-code" && s.expiresAt ? { expiresAt: s.expiresAt } : {}), state: st.state, error: st.error || null, requestId: st.requestId || null, deviceId: readConfig().device?.deviceId || null, server: st.server || null, tools: st.state === "connected" ? tools : null, plugin: PLUGIN_DIR.replace(os.homedir(), "~"), admin: adminOf() };
  }

  /* ---------- agentbook's tools, for its agents ---------- */

  // agentbook's plugin on the gateway (plugin/openclaw/) hands each call one of its agents makes to agentbook over
  // this connection. Once connected, agentbook says hello to it with the tools it has for the agents it runs, and
  // what to tell them about agentbook: the plugin offers them only while an agentbook that said so is connected.
  async function helloTools() {
    const ask = async (method) => (await host.mcpCall?.({ jsonrpc: "2.0", id: 1, method, params: {} }, { proc: "openclaw:hello" }))?.result;
    try {
      const [init, list] = await Promise.all([ask("initialize"), ask("tools/list")]);
      const offered = (list?.tools || []).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
      const r = await call("agentbook.hello", { tools: offered, instructions: init?.instructions || "" }, 15000);
      const has = new Set(r?.tools || []);
      tools = { installed: true, version: r?.plugin || null, missing: offered.map((t) => t.name).filter((n) => !has.has(n)) };
      if (tools.missing.length) log(`openclaw: agentbook's plugin on the gateway is ${tools.version}, without ${tools.missing.join(", ")}: install it again from ${PLUGIN_DIR}`);
    } catch (e) {
      tools = /unknown method/i.test(e.message) ? { installed: false } : { installed: null, error: e.message };
    }
    host.changed?.();
  }

  // A call one of its agents made, which the plugin rang about: take it (unless another agentbook did), answer it as
  // its session's post, and hand the answer back.
  async function answerCall(p) {
    const id = p?.id && String(p.id);
    if (!id || !gw) return;
    let c;
    try {
      c = await call("agentbook.take", { id }, 15000);
    } catch {
      return;
    }
    const result = await toolCall(id, c).catch((e) => ({ content: [{ type: "text", text: e.message }], isError: true }));
    await call("agentbook.done", { id, result }, 30000).catch((e) => log(`openclaw: couldn't answer ${c.tool}: ${e.message}`));
  }
  async function toolCall(id, c) {
    const key = String(c.sessionKey || "");
    // A session agentbook hasn't listed yet (one just started on Telegram) is a post once it has.
    if (key && !post(key)) await sync().catch(() => {});
    if (!post(key)) return { content: [{ type: "text", text: "This session isn't a thread on agentbook, so agentbook's tools have nowhere to write." }], isError: true };
    const r = await host.mcpCall({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: c.tool, arguments: c.args || {} } }, { proc: `openclaw:${key}`, cwd: c.cwd || null, disk: gatewayDisk(id, c.home) });
    if (r?.error) return { content: [{ type: "text", text: r.error.message }], isError: true };
    return r?.result || { content: [{ type: "text", text: "agentbook didn't answer." }], isError: true };
  }
  // The files a call names, on the gateway's machine (see mcp.mjs's localDisk), read through the plugin a piece at
  // a time, while agentbook answers the call. 2 MB a piece, the most the plugin hands over: agentbook connected with
  // Node 22's WebSocket until 0.3.23, and it drops the connection when a compressed message unpacks to 4 MB or more
  // (base64 makes 4 MB of file 5.6).
  const PIECE = 2 << 20;
  const gatewayDisk = (id, home) => ({
    home: home || "/",
    async stat(p) {
      const r = await call("agentbook.read", { id, path: p, length: 0 }, 15000);
      return r?.file ? { size: r.size } : null;
    },
    async read(p) {
      const parts = [];
      for (let at = 0, size = 1; at < size; ) {
        const r = await call("agentbook.read", { id, path: p, offset: at, length: PIECE }, 60000);
        if (!r?.file) throw new Error(`No file at ${p}`);
        const piece = Buffer.from(r.data || "", "base64");
        size = r.size;
        if (!piece.length) break;
        parts.push(piece);
        at += piece.length;
      }
      return Buffer.concat(parts);
    },
  });

  /* ---------- the gateway ---------- */

  function call(method, params = {}, timeout = 30000) {
    if (gw) return gw.rpc(method, params, timeout);
    return new Promise((resolve, reject) =>
      execFile(bin(), ["gateway", "call", method, "--params", JSON.stringify(params), "--json", "--timeout", String(timeout - 2000)], { timeout, maxBuffer: 32 << 20 }, (err, stdout, stderr) => {
        let out = null;
        try {
          out = JSON.parse(String(stdout));
        } catch {}
        if (err) {
          if (err.code === "ENOENT") return reject(new Error("OpenClaw isn't installed here, and no gateway is set to connect to."));
          // The first line says what's wrong (the rest is how to fix it, e.g. which Node to install).
          const why = out?.error?.message || out?.message || String(stderr || err.message).trim().split("\n")[0].replace(/^openclaw:\s*/, "");
          return reject(new Error(why || `openclaw gateway call ${method} failed`));
        }
        resolve(out);
      }),
    );
  }

  // The machine its agents run on, the gateway's: by the name you reach it at ("gpu" for
  // wss://gpu.tail1234.ts.net), or, for an address that's a number or this machine, the name the gateway
  // gives itself.
  let presenceHost = null;
  let presenceAt = 0;
  async function loadPresence() {
    presenceAt = Date.now();
    const list = await call("system-presence", {}, 15000).catch(() => null);
    const self = (Array.isArray(list) ? list : list?.presence || []).find((p) => p?.mode === "gateway" && p.reason === "self") || null;
    presenceHost = self?.host ? String(self.host).split(".")[0] : null;
  }
  function hostName() {
    try {
      const h = gw && new URL(settings().url).hostname;
      if (h && !/^(\d+\.){3}\d+$|^\[|^localhost$/i.test(h)) return h.split(".")[0];
    } catch {}
    return presenceHost;
  }

  const post = (key) => host.state.sessions[key];
  // What agentbook keeps of a session while it runs. `posted`: the history entries already on the post (by
  // their id in OpenClaw), so a restart, which starts with nothing in memory, never copies them again; `sent`,
  // what you wrote on agentbook, which OpenClaw's history has too; `say`, the agent's latest words in the
  // turn that's running, its reply once the turn is over, and `media`, what that turn's replies held.
  // `seq`: where in its history the last entry agentbook read is (OpenClaw numbers them from 1).
  // `legacy`: a post an earlier agentbook copied without ids, maybe several times over.
  const session = (key) => {
    if (!sessions.has(key)) {
      const kept = conversationOf(host.state, key);
      const posted = new Set(kept.filter((m) => m.ext).map((m) => m.ext));
      const sent = kept.filter((m) => m.from === "human" && m.via === "dash" && !m.ext).map((m) => m.text.trim());
      // `upTo`: when the newest message the post has from the history was said, by who said it (copy()).
      const upTo = {};
      for (const m of kept) if (m.ext && Date.parse(m.at) > (upTo[m.from] || 0)) upTo[m.from] = Date.parse(m.at);
      sessions.set(key, { updated: 0, active: false, running: false, cursor: null, seq: 0, seen: new Set(), posted, sent, upTo, legacy: !posted.size && kept.some(copied), digest: blank(), say: null, media: [], loaded: false });
    }
    return sessions.get(key);
  };
  // A message copied from OpenClaw's history before its id was kept: not yours from agentbook, nor agentbook's own word.
  const copied = (m) => !m.ext && !(m.from === "human" && m.via === "dash") && !(m.from === "agent" && /^agentbook /.test(m.text));
  const agentId = (id) => `${AGENT}${id}`;
  const agentName = (id) => agents.get(id)?.name || id;

  async function loadAgents() {
    const r = await call("agents.list");
    const listed = (r?.agents || []).filter((a) => a.kind !== "system");
    defaultAgent = r?.defaultId || "main";
    for (const a of listed) {
      const one = { id: a.id, name: a.identity?.name || a.name || a.id, workspace: a.workspace || "", model: a.model?.primary || (typeof a.model === "string" ? a.model : null) };
      agents.set(a.id, one);
      // Where it runs (the gateway's machine), so every machine that reaches it knows it by one id (server/relay.mjs).
      const where = hostName();
      const known = host.state.agents[agentId(a.id)];
      if (!known || known.name !== one.name || (where && known.host !== where)) host.commit({ t: "agent.hello", agent: agentId(a.id), agent_name: one.name, kind: "openclaw", ...(where ? { host: where } : {}) });
    }
    agentsAt = Date.now();
    lastListed = listed;
    loadAvatars(listed);
  }

  // Each agent's avatar as OpenClaw has it, its identity's picture or emoji (from its config or IDENTITY.md),
  // is the one its profile shows until you set another. A picture comes as a data: URL (a file in its
  // workspace) or a web address, and is saved here only when it changed: `src` says what it came from.
  let avatarsBusy = null;
  let lastListed = [];
  function loadAvatars(list) {
    avatarsBusy ||= (async () => {
      for (const a of list) {
        const id = await call("agent.identity.get", { agentId: a.id }, 15000).catch(() => null);
        const picture = [id?.avatar, a.identity?.avatarUrl, a.identity?.avatar].find((v) => typeof v === "string" && /^(https?:\/\/|data:image\/)/i.test(v));
        // Without one, OpenClaw's avatar is its default, "A".
        const emoji = emojiOf(id?.emoji) || emojiOf(a.identity?.emoji) || (id?.avatar !== "A" ? emojiOf(id?.avatar) : null);
        const src = picture ? crypto.createHash("sha256").update(picture).digest("hex").slice(0, 16) : emoji || "";
        const known = host.state.agents[agentId(a.id)]?.avatar_default || null;
        if ((known?.src || "") === src) continue;
        let avatar = null;
        if (picture) {
          const buf = picture.startsWith("data:") ? fromDataUrl(picture) : await fetchPicture(picture);
          // Its bytes go to the server, which shows it.
          try {
            const pic = buf && pictureOf(buf);
            const blob = pic && (await host.blobPut?.(buf, pic.type));
            avatar = pic && blob ? { ...pic, blob, src } : null;
          } catch {}
        }
        // A picture it couldn't get is tried again next time, with the emoji meanwhile.
        if (!avatar && emoji) avatar = { emoji, src: picture ? "" : src };
        if (JSON.stringify(avatar) === JSON.stringify(known)) continue;
        host.commit({ t: "agent.avatar", agent: agentId(a.id), default: true, avatar });
      }
    })()
      .catch((e) => log(`OpenClaw: couldn't get its agents' avatars: ${e.message}`))
      .finally(() => (avatarsBusy = null));
  }

  /* ---------- its commands ---------- */

  // What a session can run with a slash command, as its gateway lists them for its
  // agent (commands.list): OpenClaw's own and one for each skill it can use, with what each takes. A command comes in
  // through chat.send as one typed in Telegram does. Left out (`off`, with why): what agentbook's operator scopes
  // can't run (only an admin's or the gateway owner's may), what means nothing here, and what agentbook does itself.
  const NOT_HERE = {
    new: "starts over, which OpenClaw lets only an admin do from outside: give agentbook admin on Settings, Agents, or start a new thread on its wall",
    reset: "starts over, which OpenClaw lets only an admin do from outside: give agentbook admin on Settings, Agents, or start a new thread on its wall",
    stop: "is Stop, on the live line",
    btw: "answers on the side, which agentbook doesn't show yet",
    restart: "restarts the gateway, which only its owner may",
    update: "updates OpenClaw, which only the gateway's owner may",
    config: "changes the gateway's settings, which only its owner may",
    debug: "is the gateway owner's",
    mcp: "changes the gateway's MCP servers, which only its owner may",
    plugins: "changes the gateway's plugins, which only an admin may",
    acp: "is an admin's",
    allowlist: "changes who may use it, which only an admin may",
    send: "is the gateway owner's",
    diagnostics: "is the gateway owner's",
    activation: "is the gateway owner's",
    loop: "is the gateway owner's",
    "export-session": "is the gateway owner's",
    "export-trajectory": "is the gateway owner's",
    bash: "runs a shell on the gateway, which only its owner may",
    login: "signs in in a terminal",
    openclaw: "sets OpenClaw up, in a terminal",
    tts: "speaks its replies, which agentbook doesn't play",
  };
  // What admin lets its owner run after all (only they send slash commands: an operator's message can't start with /).
  const WITH_ADMIN = new Set(["new", "reset"]);
  const notHere = (name) => (WITH_ADMIN.has(name) && adminOn() ? null : NOT_HERE[name]);
  const commandLists = new Map(); // OpenClaw agent id -> { at, list, off }
  const COMMANDS_MS = 5 * 60e3;
  async function commands(s) {
    const a = keyAgent(s.session_id || s.id);
    const have = commandLists.get(a);
    if (have && Date.now() - have.at < COMMANDS_MS) return { list: have.list, off: have.off };
    const r = await call("commands.list", { agentId: a, sessionKey: s.session_id || s.id, scope: "text", includeArgs: true }, 20000);
    // Its name as typed (the gateway gives it without the slash), and what it takes: each argument, or its choices.
    const nameOf = (c) => String(c.name || "").replace(/^\//, "");
    const what = (x) => (x.choices?.length ? x.choices.map((o) => o?.value ?? o).join("|") : x.name);
    const hintOf = (args) => (Array.isArray(args) ? args : []).map((x) => (x.required ? `<${what(x)}>` : `[${what(x)}]`)).join(" ");
    const rows = (Array.isArray(r?.commands) ? r.commands : []).filter((c) => nameOf(c));
    const list = rows
      .filter((c) => !notHere(nameOf(c)))
      .map((c) => {
        const args = Array.isArray(c.args) ? c.args : [];
        return { name: nameOf(c), hint: hintOf(args), description: short(c.description, 200), from: c.source === "skill" ? "skill" : c.source === "plugin" ? "plugin" : "built-in", takes: args.some((x) => x.required) ? "req" : c.acceptsArgs || args.length ? "opt" : "" };
      });
    const off = rows.filter((c) => notHere(nameOf(c))).map((c) => ({ name: nameOf(c), why: notHere(nameOf(c)) }));
    commandLists.set(a, { at: Date.now(), list, off });
    return { list, off };
  }

  /* ---------- its agents' skills ---------- */

  // The skills each agent can use, as its gateway lists them (OpenClaw's own, those installed for all its
  // agents, and its workspace's), less those turned off, missing what they need, or not allowed for it. They
  // go on its newest post when they change, as Claude Code's do on each of its sessions, and a profile shows
  // what its posts list; an agent's first post gets them as it's made (`skillsDue`).
  const skillLists = new Map(); // OpenClaw agent id -> the skills it can use, as last listed
  let skillsDue = false;
  async function loadSkills() {
    skillsAt = Date.now();
    for (const a of agents.keys()) {
      const r = await call("skills.status", { agentId: a }, 30000).catch((e) => log(`OpenClaw: couldn't list ${agentName(a)}'s skills: ${e.message}`));
      if (Array.isArray(r?.skills)) skillLists.set(a, r.skills.filter((k) => k?.name && k.eligible !== false && !k.disabled && !k.blockedByAgentFilter).map((k) => ({ name: k.name, description: short(k.description, 200), file: k.filePath || null })));
    }
    noteSkills();
  }
  function noteSkills() {
    skillsDue = false;
    const newest = new Map(); // agentbook agent id -> its newest post, and its newest that lists skills
    for (const s of Object.values(host.state.sessions)) {
      if (!s.agent?.startsWith(AGENT)) continue;
      const n = newest.get(s.agent) || {};
      if (!n.post || s.started > n.post.started) n.post = s;
      if (s.skills && (!n.listed || s.started > n.listed.started)) n.listed = s;
      newest.set(s.agent, n);
    }
    for (const [a, list] of skillLists) {
      const n = newest.get(agentId(a));
      if (n?.post && JSON.stringify(n.listed?.skills || null) !== JSON.stringify(list)) host.commit({ t: "session.skills", post: n.post.id, skills: list });
    }
  }
  // A skill's SKILL.md, when it's in the agent's workspace (a skill of its own). OpenClaw's, and those
  // installed for all its agents, are elsewhere on the gateway's machine, which it doesn't hand over: null.
  async function skillFile(id, file) {
    const root = agents.get(id.slice(AGENT.length))?.workspace;
    const rel = root && file ? path.posix.relative(root, file) : "";
    if (!rel || rel.startsWith("..") || path.posix.isAbsolute(rel)) return null;
    const f = await workspaceFile(id, rel).catch(() => null);
    return typeof f?.text === "string" ? f.text : null;
  }

  /* ---------- sessions become posts ---------- */

  // The cron job a post is the thread of: one of the jobs you made, not OpenClaw's own upkeep.
  const threadJob = (key) => {
    const id = JOB_KEY.exec(key)?.[1];
    return (id && jobs?.find((j) => j.id === id && !j.builtin)) || null;
  };
  // Sessions people have with an agent, and its cron jobs': not subagents', and no other cron session.
  const shown = (row) => row?.key && !row.spawnedBy && !row.subagentRole && (!/:cron:/.test(row.key) || !!threadJob(row.key));
  // Whether a job's session has something to show: a job with nothing to report leaves no thread. Its session has only
  // what the job said then, since OpenClaw doesn't keep a NO_REPLY. Once its run is over, so its thread doesn't start empty.
  const reported = (r) => {
    const entries = r?.messages || [];
    const last = entries.at(-1);
    return (
      !midTurn(last?.message || last) &&
      entries.some((entry) => {
        const m = entry?.message || entry;
        return m?.customType === "run-failed-before-reply" || (m?.role === "assistant" && (!!fold(blank(), m, "", null) || mediaOf(m).length > 0));
      })
    );
  };

  // When a session began, as OpenClaw has it: created, or (for an agent's main session, which doesn't say)
  // when its place on the gateway was made. Never when agentbook first saw it.
  const startOf = (row) => iso(row.createdAt) || iso(row.placement?.createdAtMs) || null;
  // A post learns its session began earlier than it thought (its history goes further back).
  function began(key, at) {
    const s = post(key);
    if (s && at && at < s.started) host.commit({ t: "session.snapshot", post: key, started: at });
  }

  function ensurePost(row, { lid, prompt } = {}) {
    const key = row.key;
    const se = session(key);
    const job = threadJob(key);
    if (job) se.digest.ai_title = short(job.name, 120);
    else if (row.derivedTitle || row.displayName || row.label) se.digest.ai_title = short(row.label || row.displayName || row.derivedTitle, 120);
    if (row.model) se.digest.model = row.model;
    if (post(key) && !lid) {
      began(key, startOf(row));
      return post(key);
    }
    const a = keyAgent(key) === row.agentId || !row.agentId ? keyAgent(key) : row.agentId;
    host.commit({
      t: "session.hello",
      proc: `openclaw:${key}`,
      agent: agentId(a),
      agent_name: agentName(a),
      kind: "openclaw",
      label: host.label(key),
      session_id: key,
      cwd: row.cwd || agents.get(a)?.workspace || "",
      root: "",
      repo: "",
      branch: "",
      host: hostName() || undefined,
      channel: true,
      launch: lid,
      started: startOf(row) || iso(row.updatedAt || row.lastActivityAt) || undefined,
      updated: iso(row.updatedAt || row.lastActivityAt) || undefined,
      prompt: prompt ? short(prompt, 2000) : undefined,
    });
    if (host.keptOff(key)) return null; // kept off agentbook (Private terminals)
    host.changed(key, true);
    skillsDue = true;
    return post(key);
  }

  // A session that's running (or just was) is working; one that's quiet for an hour is over until it's active again.
  function setActive(key, active, updatedMs) {
    const s = post(key);
    const se = session(key);
    if (!s) return;
    if (active) {
      if (s.state === "done") host.commit({ t: "session.hello", proc: `openclaw:${key}`, agent: s.agent, kind: "openclaw", label: s.label, session_id: key, channel: true });
      if (!post(key).busy) host.commit({ t: "session.status", post: key, state: "working", turn: "start" });
    } else if (se.active || s.busy) {
      reply(key);
      host.commit({ t: "session.status", post: key, state: "idle", text: "Waiting for your next message", turn: "end", settle_permissions: true });
    } else if (s.state !== "done" && updatedMs && Date.now() - updatedMs > QUIET_MS && !(workers.get(key) || []).some(workerGoing)) {
      host.commit({ t: "session.gone", post: key, reason: "Quiet", ended: iso(updatedMs) });
    }
    se.active = active;
  }

  /* ---------- the subagents a session starts ---------- */

  // A session's agent can hand work to subagents (sessions_spawn), which run as sessions of their own and stay off
  // agentbook as threads. Each is a worker (workers.mjs) of the thread that started it (or that started the one that
  // did), with the tool it last started, which the gateway's session.tool events say.
  // A row's state: running while it has a run, else what OpenClaw says of its last one (done when it doesn't say).
  const workerState = (row) => (row.hasActiveRun ? "running" : stateOf(row.status) || "done");
  function noteWorkers(rows) {
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const starter = (row) => row?.spawnedBy || row?.controlOwnerSessionKey || null;
    const next = new Map();
    const kept = new Set();
    for (const row of rows) {
      if (shown(row) || !(row.spawnedBy || row.subagentRole)) continue;
      // The thread it's on: the post up its line of starters (a subagent can start its own).
      let parent = starter(row);
      for (let n = 0; parent && !post(parent) && n < 8; n++) parent = starter(byKey.get(parent));
      if (!parent || !post(parent)) continue;
      const state = workerState(row);
      const ended = workerGoing({ state }) ? null : iso(row.endedAt) || iso(row.lastActivityAt || row.updatedAt);
      const failed = state === "failed" || state === "timed out" || state === "stopped";
      const w = { id: row.key, title: short(row.label || row.derivedTitle || row.displayName || "A subagent", 120), state, started: iso(row.startedAt) || startOf(row), ended, error: failed && row.lastRunError ? short(String(row.lastRunError), 300) : null };
      kept.add(row.key);
      (next.get(parent) || next.set(parent, []).get(parent)).push(w);
    }
    for (const [key, list] of next) {
      next.set(key, shownWorkers(list));
      // One that went quiet while its workers went on is going again.
      const s = post(key);
      if (s.state === "done" && list.some(workerGoing)) host.commit({ t: "session.hello", proc: `openclaw:${key}`, agent: s.agent, kind: "openclaw", label: s.label, session_id: key, channel: true });
    }
    // A step heard before its worker was listed (one started since the list was asked for) waits a while for it.
    for (const [key, st] of workerSteps) if (!kept.has(key) && Date.now() - Date.parse(st.at) > 5 * 60e3) workerSteps.delete(key);
    for (const key of workerN.keys()) if (!kept.has(key) && !workerSteps.has(key)) workerN.delete(key);
    workers = next;
  }
  // The tool a subagent just started (a session.tool event), as its step says it.
  function workerStep(p) {
    const d = p?.data;
    if (!p?.sessionKey || post(p.sessionKey) || d?.phase !== "start" || !d.name) return;
    if (!p.spawnedBy && !workerSteps.has(p.sessionKey)) return;
    workerSteps.set(p.sessionKey, { title: toolTitle(d.name, d.args), at: new Date().toISOString() });
    workerN.set(p.sessionKey, (workerN.get(p.sessionKey) || 0) + 1);
  }
  // A post's workers, each with its last step, and how many tools it started as far as agentbook knows.
  const workersOf = (key) => (workers.get(key) || []).map((w) => ({ ...w, step: workerSteps.get(w.id) || null, n: workerN.get(w.id) || 0 }));
  // A worker's steps, from its own session's history, as a run's are (routineRun): read when you open it on its
  // thread's page, and again as it starts another tool. Its latest WORKER_STEPS; none (`gone`) once OpenClaw has let
  // go of its history.
  const WORKER_STEPS = 40;
  async function workerStepsOf(key, worker) {
    if (!(workers.get(key) || []).some((w) => w.id === worker)) return null;
    const r = await call("chat.history", { sessionKey: worker, limit: 200 });
    const d = blank();
    const messages = r?.messages || [];
    for (const entry of messages) {
      const m = entry?.message || entry;
      if (!m?.role) continue;
      if (startsTurn(m)) d.turn++;
      fold(d, m, entry.id || m.id || `${m.role}:${m.timestamp}`, iso(m.timestamp || entry.timestamp), agents.get(keyAgent(worker))?.workspace);
    }
    const n = d.steps.filter((x) => x.kind === "tool").length;
    if (n > (workerN.get(worker) || 0)) workerN.set(worker, n);
    return { steps: d.steps.slice(-WORKER_STEPS).map(({ id, kind, at, tool, title, text, done, error }) => ({ id, kind, at, tool, title, text, done, error })), n, gone: !messages.length };
  }

  // Read a session's history and copy onto the post what isn't there yet: your messages, and the agent's
  // reply to each, once its turn is over, each at the time it was said. Its steps come from it too.
  async function readHistory(key) {
    const se = session(key);
    const ask = (more) => call("chat.history", { sessionKey: key, limit: 200, ...more });
    let r = await ask(se.cursor ? { cursor: se.cursor } : {});
    if (r?.kind === "reset") {
      se.cursor = null;
      r = await ask({});
    }
    let entries = r?.messages || [];
    // Without a cursor, the history comes back a page at a time, the latest first. A post that has some of it
    // already (agentbook restarted, or was away for more than a page of it) reads back to what it has, so
    // nothing in between is lost. Its digest is of all of it (`whole`) when that reached its first page.
    if (!se.cursor) {
      let page = r;
      if (se.posted.size) {
        const has = (entry) => se.posted.has(idOf(entry)) || se.posted.has(`${idOf(entry)}:say`);
        for (let n = 0; page?.hasMore && page.nextOffset != null && !entries.some(has) && n < 10; n++) {
          page = await ask({ offset: page.nextOffset });
          entries = [...(page?.messages || []), ...entries];
        }
      }
      if (!se.seen.size) se.digest.whole = !page?.hasMore;
    }
    if (se.legacy) {
      // Those copies go, and the history is copied again, this time once.
      se.legacy = false;
      const drop = conversationOf(host.state, key).filter(copied).map((m) => m.id);
      if (drop.length) host.commit({ t: "message.drop", post: key, mids: drop });
    }
    for (const entry of entries) take(key, entry);
    if (entries.length && seqOf(entries.at(-1))) se.seq = seqOf(entries.at(-1));
    const last = entries.at(-1);
    if (!r?.inFlightRun && !se.running && !midTurn(last?.message || last)) reply(key);
    if (r?.deltaCursor) se.cursor = r.deltaCursor;
    const first = entries.map((x) => x?.message || x).find((m) => m?.timestamp);
    if (first) began(key, iso(first.timestamp));
    se.loaded = true;
    took(key);
    return r;
  }
  // The skills it used are on its post at once, not only once a turn ends while agentbook watches.
  function took(key) {
    const used = skillUses(session(key).digest, post(key));
    if (used.changed) host.commit({ t: "session.snapshot", post: key, skill_uses: used.uses });
    host.changed(key);
  }

  // An entry the gateway says was just added to a session's history (session.message, which it sends agentbook
  // for the sessions it follows): on the post at once, as Discord gets the agent's words while it works, rather
  // than once agentbook reads the history again, which a busy gateway can take minutes to answer. Only the next
  // entry agentbook expects, by its place in the history, so none before it is missed and the post keeps its
  // order (the first of a new session is one), and only one with its id there, so reading it again later
  // doesn't copy it twice; any other comes with the rest of the history. Whether it took it.
  const seqOf = (entry) => Number((entry?.message || entry)?.__openclaw?.seq) || 0;
  function heard(p) {
    const key = p?.sessionKey;
    const m = p?.message;
    const seq = seqOf(m) || Number(p?.messageSeq) || 0;
    if (!m?.role || !post(key) || !(m.id || m.__openclaw?.id) || !seq) return false;
    if (JOB_KEY.test(key)) return false; // each run starts counting again: its history says what's new
    if (joined(m)) return false; // what it follows comes only from reading the history
    const se = session(key);
    if (seq !== se.seq + 1) return false;
    if (seq === 1 && !se.seen.size) se.digest.whole = se.loaded = true; // all there is of it
    take(key, m);
    se.seq = seq;
    took(key);
    return true;
  }

  const OUTBOUND_KEPT_MS = 24 * 3600e3; // OpenClaw's OUTBOUND_STAGING_TTL_MS
  // Copy a history entry onto the post, once, with its media as files. One copied before agentbook kept its
  // media gets them now. A file comes from OpenClaw when it's first opened, or at once when the message is new,
  // or said less than a day ago: OpenClaw deletes what its agents send (media/outbound) a day after, so one
  // read after a restart, or added to a message agentbook already had, would be gone by the time it's opened.
  function copy(key, ext, m, media = []) {
    const se = session(key);
    const young = Date.now() - Date.parse(m.when) < OUTBOUND_KEPT_MS;
    if (se.posted.has(ext)) {
      const had = media.length && conversationOf(host.state, key).find((x) => x.ext === ext);
      if (!had || had.files?.length) return;
      const files = keep(key, ext, media, m.from);
      host.commit({ t: "message.files", post: key, ext, files });
      if (young) for (const fid of files) host.fetchFile?.(fid);
      return;
    }
    se.posted.add(ext);
    // agentbook's first read of it since it started adds only what's newer than what the post already has from the
    // history, by who said it. What's older was copied, or left out, by the rules agentbook had then (a turn's last
    // words, what it sent OpenClaw itself), and reading it again by today's would add messages to turns long over.
    if (!se.loaded && Date.parse(m.when) < (se.upTo[m.from] || 0)) return;
    const files = keep(key, ext, media, m.from);
    host.commit({ t: "message.add", post: key, ext, ...m, files });
    if (se.loaded || young) for (const fid of files) host.fetchFile?.(fid);
  }
  // A message's media, as files on its post that say where in OpenClaw they are.
  function keep(key, ext, media, from) {
    return media.map((x, i) => {
      const stored = `openclaw-${crypto.createHash("sha256").update(`${key}\0${ext}\0${i}`).digest("hex").slice(0, 16)}-${x.name}`;
      return `f${host.commit({ t: "file.add", from, name: x.name, title: x.name, size: x.size, stored, remote: x.ref }).seq}`;
    });
  }
  // The turn is over: what the agent said last is its reply, with what its replies held.
  function reply(key) {
    const se = session(key);
    // What a cron job said goes on the post with what its agent answered, from its routine rather than from you. A
    // session it started has no other name.
    if (se.say && se.held) {
      const { id, job, at } = se.held;
      se.held = null;
      if (!post(key)?.ai_title) host.commit({ t: "session.snapshot", post: key, ai_title: (se.digest.ai_title ||= short(job.name, 120)) });
      copy(key, id, { from: "human", via: "routine", text: job.text, routine: { id: job.job, name: short(job.name, 200), why: "cron" }, when: at });
    }
    if (se.say) copy(key, se.say.id, { from: "agent", via: "dash", text: se.say.text, when: se.say.at }, once(se.media));
    se.say = null;
    se.media = [];
  }

  // A history entry's id in OpenClaw (or, for one without, what it says, and when).
  const idOf = (entry) => {
    const m = entry?.message || entry;
    return entry?.id || m?.id || entry?.__openclaw?.id || `${m?.role}:${m?.timestamp || ""}:${textOf(m?.content).slice(0, 60)}`;
  };

  // Fold one history entry into the post: what you and the agent said, the tools it used.
  function take(key, entry) {
    const m = entry?.message || entry;
    if (!m?.role) return;
    const se = session(key);
    const d = se.digest;
    const id = idOf(entry);
    if (se.seen.has(id)) return;
    se.seen.add(id);
    const at = iso(m.timestamp || entry.timestamp) || new Date().toISOString();
    const seq = (entry.__openclaw || m.__openclaw)?.seq;
    if (startsTurn(m)) {
      reply(key); // the turn before it is over
      se.held = null; // a cron run's prompt, if it had nothing to report
      d.turn++;
      const cron = m.provenance?.sourceTool === "cron" && m.provenance.sourcePromptPrefix;
      const text = cron ? `${cron} ${textOf(m.content)}` : forwarded(m) ? null : yoursOf(textOf(m.content), m.provenance);
      if (text === null) return; // OpenClaw's own, to its agent
      const job = cronPrompt(text);
      if (job) return void (se.held = { id, job, at }); // until its run has something to say: reply()
      const media = mediaOf(m, seq);
      const mine = se.sent.indexOf(text);
      if (mine >= 0) se.sent.splice(mine, 1);
      else if (ANSWER_WORDS.test(text)) return; // agentbook's, sent before it last started, or by its plugin on the gateway
      else if ((text && !OMITTED.test(text)) || media.length) copy(key, id, { from: "human", via: m.__openclaw?.transport?.channel || "terminal", text: OMITTED.test(text) ? "" : text, when: at }, media);
    } else if (m.role === "custom" && m.customType === "run-failed-before-reply") {
      // A turn that failed before the agent said anything ("This turn ended before a reply: All models failed…"):
      // OpenClaw shows that in its place, and so does its post, rather than going quiet.
      const text = textOf(m.content);
      if (!text.trim()) return;
      addSay(d, { id: `${id}:say`, at, text });
      se.say = { id: `${id}:say`, text, at };
    } else {
      const said = fold(d, m, id, at, post(key)?.cwd);
      const media = m.role === "assistant" ? [...mediaOf(m, seq), ...sentOf([...sentIn(m), ...toolSent(m, key)], seq)] : [];
      se.media.push(...media);
      if (joined(m) && !said) {
        // A turn agentbook copied before it told these apart keeps the reply it was given.
        if (se.posted.has(`${id}:say`)) Object.assign(se, { say: null, media: [] });
        return;
      }
      // A reply that's only a picture (or a video, a sound, a file) is a reply too.
      if (said) se.say = { id: `${id}:say`, text: said, at };
      else if (media.length && !se.say) se.say = { id: `${id}:say`, text: "", at };
    }
  }
  // What the agent's entries add to a digest: what it said (the last of which it returns), the tools it used
  // and how they went.
  function fold(d, m, id, at, cwd) {
    let said = null;
    const toolDoneWith = (c) => toolDone(d, c.toolCallId ?? c.tool_use_id ?? c.id, { at, error: c.isError || c.is_error ? textOf(c.content) || "Failed" : null, output: textOf(c.content) });
    if (forwarded(m) || (joined(m) && d.spoke === d.turn)) return said;
    if (m.role === "assistant") {
      if (m.model) d.model = m.model;
      // An agent on the claude-cli runtime records its tool calls and their results in the reply itself.
      for (const c of Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }]) {
        const type = String(c?.type || "").toLowerCase();
        const text = type === "text" ? withoutMedia(c.text) : "";
        if (text.trim()) {
          addSay(d, { id: `${id}:say`, at, text });
          said = text;
          d.spoke = d.turn;
        } else if (type === "toolcall" || type === "tool_use") addTool(d, { id: c.id ?? c.toolCallId, at, name: c.name, args: c.arguments ?? c.input, cwd });
        else if (type === "tool_result" || type === "toolresult") toolDoneWith(c);
      }
      if (m.usage?.input) d.context = Number(m.usage.input) + Number(m.usage.cacheRead || 0);
    } else if (m.role === "toolResult") {
      toolDone(d, m.toolCallId, { at, error: m.isError ? textOf(m.content) || "Failed" : null, output: textOf(m.content) });
    } else if (toolResults(m)) m.content.forEach(toolDoneWith);
    return said;
  }

  // Sessions whose history agentbook hasn't read yet (new to it, or since it started), read a few at a time,
  // the most recently active first. Their posts show they're syncing meanwhile.
  const waiting = [];
  const reading = new Set();
  function catchUp(key) {
    if (waiting.includes(key) || reading.has(key)) return;
    waiting.push(key);
    pump();
  }
  function pump() {
    while (reading.size < READERS && waiting.length) {
      const key = waiting.shift();
      reading.add(key);
      readHistory(key)
        .catch((e) => log(`openclaw history ${key}: ${e.message}`))
        .finally(() => {
          reading.delete(key);
          host.changed(key);
          pump();
        });
    }
  }
  const syncingPost = (key) => waiting.includes(key) || reading.has(key);

  /* ---------- approvals and questions ---------- */

  async function syncAsks() {
    const approvals = await call("exec.approval.list").catch(() => []);
    const live = new Set();
    for (const ap of Array.isArray(approvals) ? approvals : approvals?.approvals || []) {
      const key = ap.request?.sessionKey;
      const rk = `oc-ap:${ap.id}`;
      live.add(rk);
      if (!key || !post(key) || asked.has(rk)) continue;
      asked.set(rk, { kind: "approval", id: ap.id });
      const cmd = ap.request.command || (ap.request.commandArgv || []).join(" ");
      host.commit({ t: "question.ask", post: key, kind: "permission", request_id: rk, title: "Allow this command?", tool_name: "Exec", detail: ap.request.cwd ? `In ${ap.request.cwd}` : `${agentName(keyAgent(key))} wants to run a command.`, preview: cmd });
    }
    const qs = await call("question.list").catch(() => null);
    for (const q of qs?.questions || []) {
      const rk = `oc-q:${q.id}`;
      if (q.status && q.status !== "pending") continue;
      live.add(rk);
      if (!q.sessionKey || !post(q.sessionKey) || asked.has(rk)) continue;
      const req = { kind: "question", id: q.id, asks: new Map(), answers: {} };
      asked.set(rk, req);
      for (const one of q.questions || []) {
        const op = host.commit({ t: "question.ask", post: q.sessionKey, kind: one.options?.length ? "choice" : "text", title: one.question, detail: one.header || "", options: (one.options || []).slice(0, 6).map((o) => ({ label: short(o.label, 80), detail: short(o.description, 140) || null })), key: `${rk}:${one.id}`, blocks: true });
        req.asks.set(`q${op.seq}`, one.id);
      }
    }
    // Answered or expired in OpenClaw itself: forget it.
    for (const rk of [...asked.keys()]) if (!live.has(rk)) asked.delete(rk);
  }

  // Forgotten only once OpenClaw has taken it: until then it lists it as open, and syncAsks would ask it again.
  // One it refused is asked again, so you can answer it.
  const resolved = (rk, method, params) => call(method, params).finally(() => asked.delete(rk));

  async function answer(key, e) {
    if (e.type === "permission") {
      const r = asked.get(e.request_id);
      if (r?.kind !== "approval") return false;
      await resolved(e.request_id, "exec.approval.resolve", { id: r.id, decision: e.behavior === "allow" ? "allow-once" : "deny" });
      return true;
    }
    for (const [rk, r] of asked) {
      if (r.kind !== "question" || !r.asks.has(e.question_id)) continue;
      r.answers[r.asks.get(e.question_id)] = e.skipped || e.value == null ? [] : [String(e.value)];
      if (Object.keys(r.answers).length === r.asks.size) await resolved(rk, "question.resolve", { id: r.id, answers: { answers: r.answers } });
      return true;
    }
    return false;
  }

  /* ---------- keeping up ---------- */

  // Every session, a page at a time (cron runs and subagents' fill most of them).
  async function listSessions() {
    const rows = [];
    const keys = new Set();
    for (let offset = 0; ; ) {
      const r = await call("sessions.list", { limit: PAGE, ...(offset ? { offset } : {}) });
      const page = (r?.sessions || []).filter((x) => !keys.has(x.key));
      for (const x of page) keys.add(x.key);
      rows.push(...page);
      if (!r?.hasMore || !page.length) return rows;
      offset = Number(r.nextOffset) || offset + page.length;
    }
  }

  let syncing = null;
  function sync() {
    syncing ||= (async () => {
      if (!enabled || Date.now() < retryAt) return;
      if (Date.now() - agentsAt > 5 * 60e3) await loadAgents();
      if (Date.now() - presenceAt > 5 * 60e3) await loadPresence();
      const rows = await listSessions();
      if (!gw && !connected) reached(true); // through the command; a gateway's connection says for itself
      connected = true;
      lastError = null;
      backoff = 0;
      noteHomes(rows);
      noteWorkers(rows); // before its posts' quiet is looked at: one whose worker works on isn't over
      const since = Math.max(DAYS ? Date.now() - DAYS * 86400e3 : 0, host.historyFrom?.() || 0);
      for (const row of rows) {
        if (!shown(row)) continue;
        const updated = Number(row.updatedAt || row.lastActivityAt) || 0;
        const active = !!row.hasActiveRun;
        if (!post(row.key) && !active && updated < since) continue;
        const se = session(row.key);
        // A job's thread starts with the first run that says something.
        if (!post(row.key) && threadJob(row.key)) {
          if (updated === se.updated) continue;
          se.updated = updated;
          if (!reported(await call("chat.history", { sessionKey: row.key, limit: 200 }))) continue;
          se.updated = 0;
        }
        se.running = active;
        // Its post first, at once; its history (its first message, its conversation, its steps) follows. None:
        // it's kept off agentbook (Private terminals), and read once it's let on.
        ensurePost(row);
        if (host.keptOff(row.key)) continue;
        if (!se.loaded) catchUp(row.key);
        else if (updated !== se.updated || active) await readHistory(row.key).catch((e) => log(`openclaw history ${row.key}: ${e.message}`));
        se.updated = updated;
        setActive(row.key, active, updated);
      }
      await syncAsks();
      if (Date.now() - jobsAt > CRON_MS) await loadRoutines();
      if (Date.now() - skillsAt > SKILLS_MS) await loadSkills();
      else if (skillsDue) noteSkills();
      for (const s of Object.values(host.state.sessions)) if (s.proc?.startsWith("openclaw:") && host.pending(s.id).length) deliver(s.id);
    })()
      .catch((e) => {
        if (!gw && (connected || !downSince)) reached(false);
        connected = false;
        backoff = Math.min(300e3, backoff ? backoff * 2 : 10e3);
        retryAt = Date.now() + backoff;
        if (lastError !== e.message) log(`openclaw: ${(lastError = e.message)} (trying again in ${Math.round(backoff / 1000)}s)`);
      })
      .finally(() => (syncing = null));
    return syncing;
  }

  /* ---------- what you send ---------- */

  const idem = () => `ab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  // The files you attach go to OpenClaw with your message, in base64, rather than as paths on this machine,
  // which its agents may not be on. OpenClaw takes a picture up to 6 MB and another file up to 20 MB (unless
  // its gateway is set to take more), all of a message's in one frame of up to 25 MB; through the openclaw
  // command, only as much as fits on a command line. What doesn't fit stays here, and the post says so.
  function attachmentsOf(files = []) {
    let room = gw ? 24 << 20 : 700 << 10;
    const attachments = [];
    const left = [];
    for (const f of files) {
      let buf;
      try {
        buf = fs.readFileSync(f.path);
      } catch {
        left.push(`${f.name} (it's gone from agentbook)`);
        continue;
      }
      const mimeType = MIME[path.extname(f.name).slice(1).toLowerCase()] || "application/octet-stream";
      const picture = mimeType.startsWith("image/");
      const content = buf.toString("base64");
      if (buf.length > (picture ? 6 << 20 : 20 << 20)) left.push(`${f.name} (OpenClaw takes ${picture ? "pictures up to 6 MB" : "files up to 20 MB"})`);
      else if (content.length > room) left.push(`${f.name} (${gw ? "it's more than OpenClaw takes in one message" : "it's too big to send through the openclaw command; connect agentbook to the gateway to send it"})`);
      else {
        room -= content.length;
        attachments.push({ type: picture ? "image" : "file", mimeType, fileName: f.name, content, sizeBytes: buf.length });
      }
    }
    return { attachments, left };
  }
  const leftBehind = (key, left) => left.length && host.commit({ t: "message.add", post: key, from: "agent", via: "dash", text: `agentbook couldn't send ${left.join(", ")} to OpenClaw.` });
  // `command`: a slash command, which OpenClaw runs as it does one typed in Telegram, and never steers into a run.
  // `owner`: all of it is this machine's owner's own words (deliverer), which go over the owner's connection.
  async function send(key, text, files = [], { command = null, owner = false } = {}) {
    const se = session(key);
    const { attachments, left } = attachmentsOf(files);
    leftBehind(key, left);
    if (!text.trim() && !attachments.length) return;
    se.sent.push(text.trim());
    await (owner ? ownerCall : call)("chat.send", { sessionKey: key, message: text, idempotencyKey: idem(), ...(attachments.length ? { attachments } : {}), ...(se.active && !command ? { queueMode: "steer" } : {}) }, attachments.length ? 120e3 : 30000);
    if (!se.active) setActive(key, true);
    setTimeout(() => sync(), 1500).unref?.();
  }
  const deliver = deliverer({ host, log, name: "OpenClaw", answer, send, sendsFiles: true });

  // A new session with one of its agents, in the agent's own workspace, under a key agentbook picks, with the
  // files you attached. `user`: someone this machine's owner lets operate it, whose start goes over the everyday
  // connection; the owner's own, over theirs.
  async function start({ agent, prompt, shown = prompt, files = [], lid, user = null }) {
    const id = String(agent).startsWith(AGENT) ? String(agent).slice(AGENT.length) : "main";
    const { attachments, left } = attachmentsOf(files);
    const r = await (user ? call : ownerCall)("sessions.create", { agentId: id, key: `agentbook-${lid}`, message: prompt, idempotencyKey: lid, ...(attachments.length ? { attachments } : {}) }, attachments.length ? 120e3 : 30000);
    if (r?.runStarted === false && r.runError) throw new Error(r.runError.message || String(r.runError));
    const key = r.key;
    const se = session(key);
    se.sent.push(prompt.trim());
    ensurePost({ key, agentId: id, createdAt: Date.now(), updatedAt: Date.now() }, { lid, prompt });
    host.commit({ t: "message.add", post: key, from: "human", via: "dash", text: shown, files: files.map((f) => f.id), resume: lid });
    leftBehind(key, left);
    setActive(key, true);
    return { id: key };
  }

  async function stop(key) {
    await call("sessions.abort", { key, clearQueued: true });
  }

  async function steps(key) {
    const se = session(key);
    if (!se.loaded) await readHistory(key);
    return se.digest;
  }

  /* ---------- files in its workspace ---------- */

  // A file its agent names, read through the gateway from the session's workspace on the gateway's machine
  // (sessions.files.get), so it opens wherever OpenClaw runs. It reads text and pictures, up to 256 KB (a
  // picture up to 5 MB, from its agent's workspace: see bigPicture), and nothing outside the workspace; what it
  // won't read (a video, a sound) comes a piece at a time instead (`stream`, see gatewayFile). A folder it won't
  // read is listed (sessions.files.list) from the workspace's root, which it says. What comes back: { root,
  // path, name, size, modified } and a folder's `entries` (`truncated` past 250), or a file's `text` or `bytes`
  // (a picture), or neither (a kind it doesn't read). It fails with a `status` when there's no such file, or
  // it's too big.
  const roots = new Map(); // session key -> its workspace's root, as the gateway gives it
  const failed = (e, type) => e.details?.type === type || e.message.includes(type === "session_file_too_large" ? "too large" : "not found");
  const refused = (status, message) => Object.assign(new Error(message), { status });
  async function file(key, asked) {
    const p = asked.length > 1 ? asked.replace(/\/+$/, "") : asked;
    try {
      const r = await call("sessions.files.get", { sessionKey: key, path: p });
      if (r.root) roots.set(key, r.root);
      const f = r.file;
      const full = r.root && f.workspacePath ? path.posix.join(r.root, f.workspacePath) : f.path;
      const head = { root: r.root || path.posix.dirname(full), path: full, name: f.name || path.posix.basename(full), size: f.size, modified: iso(f.updatedAtMs) };
      if (typeof f.content !== "string") return (await bigPicture(key, head)) || head;
      return f.contentEncoding === "base64" ? { ...head, bytes: Buffer.from(f.content, "base64") } : { ...head, text: f.content };
    } catch (e) {
      if (failed(e, "session_file_too_large")) throw refused(413, `${asked} is too big to open from OpenClaw${e.details?.size ? ` (${Math.ceil(e.details.size / 1024)} KB)` : ""}: it opens files up to 256 KB.`);
      if (!failed(e, "session_file_not_found")) throw e;
    }
    if (!roots.has(key)) roots.set(key, (await call("sessions.files.list", { sessionKey: key })).root || null);
    const root = roots.get(key);
    const cwd = post(key)?.cwd;
    const where = root || cwd || "its workspace";
    if (!root) throw refused(404, `There's no ${asked} in ${where}.`);
    // Its own paths go from the session's folder, when that's in the workspace, or else from the root.
    const from = [cwd && !path.posix.relative(root, cwd).startsWith("..") ? cwd : null, root].filter(Boolean);
    const rels = [...new Set(from.map((b) => path.posix.relative(root, path.posix.resolve(b, p))))].filter((r) => !r.startsWith("..") && !path.posix.isAbsolute(r));
    if (!rels.length) throw refused(404, `There's no ${asked} in ${where}: OpenClaw only opens files in its workspace.`);
    for (const rel of rels) {
      const b = (await call("sessions.files.list", { sessionKey: key, path: rel }))?.browser;
      if (b?.path !== rel) continue;
      const entries = (b.entries || []).filter((e) => !e.name.startsWith(".")).map((e) => ({ name: e.name, dir: e.kind === "directory" }));
      const full = rel ? path.posix.join(root, rel) : root;
      return { root, path: full, name: path.posix.basename(full), entries, truncated: !!b.truncated };
    }
    throw refused(404, `There's no ${asked} in ${where}.`);
  }

  // A picture over the 256 KB sessions.files.get hands over comes back without its bytes. The agent's own
  // workspace hands it over up to 5 MB (agents.workspace.get, OpenClaw 2026.7 on), when it's in there. Null when
  // it isn't, or OpenClaw won't.
  const PICTURE = /\.(avif|bmp|gif|heic|heif|jpe?g|png|webp)$/i;
  async function bigPicture(key, head) {
    const a = keyAgent(key);
    const rel = path.posix.relative(agents.get(a)?.workspace || head.root, head.path);
    if (!PICTURE.test(head.name) || !rel || rel.startsWith("..") || path.posix.isAbsolute(rel) || head.size > 5 << 20) return null;
    try {
      const f = (await call("agents.workspace.get", { agentId: a, path: rel }))?.file;
      return f?.encoding === "base64" && typeof f.content === "string" ? { ...head, bytes: Buffer.from(f.content, "base64") } : null;
    } catch {
      return null;
    }
  }

  /* ---------- an agent's workspace ---------- */

  // An agent's workspace, on its profile under Files: the folder on the gateway's machine where it keeps its
  // AGENTS.md, SOUL.md and MEMORY.md, its memory/ notes and whatever else it writes. OpenClaw looks through a
  // workspace for one of its sessions (sessions.files), so agentbook does it for one of the agent's own that
  // works there (`homes`): its main session, or else its latest. One without any has only the files OpenClaw
  // makes it of (agents.files: AGENTS.md, SOUL.md, MEMORY.md…).
  // What's in it is read when its profile asks: again once the agent did something since (`at`, which a
  // profile watches), and otherwise after a minute. Folders are listed nearest first, 500 of them at most and
  // for 10 seconds at most (a page waits 30 for it), leaving out hidden ones and what tools fill (node_modules);
  // the rest, and one it couldn't list, are listed when one's opened (`dir`), from there the same way.
  const homes = new Map(); // OpenClaw agent id -> { key, rank, at }: the session to look through, and when the agent last did something
  const looked = new Map(); // OpenClaw agent id (and folder) -> { data, at, done, busy, busyFor }: what's in it, when it was read, for which `at`
  const WS_DIRS = Number(process.env.AGENTBOOK_OPENCLAW_WS_DIRS || 500);
  const WS_MS = Number(process.env.AGENTBOOK_OPENCLAW_WS_MS || 10e3);
  const WS_FILES = 5000;
  const WS_READERS = 8; // folders listed at once
  const FILLED = new Set(["node_modules", "dist", "build", "coverage", "target", "venv", "__pycache__"]);
  const atHome = (row) => !row.spawnedBy && !row.subagentRole && !row.spawnedCwd && !row.spawnedWorkspaceDir && !row.repositoryWorkspaceId && !row.execNode;
  function noteHomes(rows) {
    const next = new Map();
    for (const row of rows) {
      const a = row.agentId || keyAgent(row.key);
      const h = next.get(a) || { key: null, rank: -1, at: 0 };
      const at = Number(row.updatedAt || row.lastActivityAt) || 0;
      h.at = Math.max(h.at, at);
      const rank = row.key === `agent:${a}:main` ? Infinity : at;
      if (atHome(row) && rank > h.rank) Object.assign(h, { key: row.key, rank });
      next.set(a, h);
    }
    const moved = [...next].some(([a, h]) => homes.get(a)?.at !== h.at);
    homes.clear();
    for (const [a, h] of next) homes.set(a, h);
    if (moved) host.changed();
  }
  // What its profile watches: when the agent last did something, which is when its workspace may have changed.
  const workspaceOf = (id) => (agents.has(id.slice(AGENT.length)) ? { at: iso(homes.get(id.slice(AGENT.length))?.at || null) } : null);

  // What's in it: { root, files: [{ path, size, modified }], dirs: [{ path, modified, listed }], more, core }.
  // Paths go from its root. `more`: there's more than was listed; `core`: only the files OpenClaw makes it of.
  // `dir`: what's in one of its folders (by its path from the root), for one that wasn't listed.
  async function workspace(id, dir = "") {
    const a = id.slice(AGENT.length);
    if (!agents.has(a)) return null;
    const at = homes.get(a)?.at || 0;
    const k = dir ? `${a}\0${dir}` : a;
    if (!looked.has(k)) looked.set(k, {});
    const c = looked.get(k);
    if (c.data && c.done === at && Date.now() - c.at < 60e3) return c.data;
    if (c.busy && c.busyFor === at) return c.busy;
    // Read while the agent was doing something else: once that's done, read again.
    const before = c.busy;
    const busy = (async () => {
      await before?.catch(() => {});
      const key = homes.get(a)?.key;
      if (dir && !key) throw refused(404, `Until ${agentName(a)} has a thread, OpenClaw shows only the files it keeps for it (AGENTS.md, SOUL.md, MEMORY.md…).`);
      const data = dir ? await walk(key, dir) : key ? await walk(key).catch(() => coreFiles(a)) : await coreFiles(a);
      Object.assign(c, { data, at: Date.now(), done: at });
      return data;
    })().finally(() => c.busy === busy && (c.busy = null));
    Object.assign(c, { busy, busyFor: at });
    return busy;
  }
  async function walk(key, from = "") {
    const files = [];
    const dirs = [];
    let root = null;
    let more = false;
    let found = false;
    let left = WS_DIRS;
    const until = Date.now() + WS_MS;
    const opening = new Map(); // path -> its folder in `dirs`, while it's to be listed
    for (let level = [from]; level.length; ) {
      left -= level.length;
      // A folder it can't list, or doesn't get to in time, isn't listed; the one it starts from it can't list, it can't show.
      const lists = await pool(level, WS_READERS, (dir) => (dir !== from && Date.now() > until ? null : call("sessions.files.list", { sessionKey: key, ...(dir ? { path: dir } : {}) }).catch((e) => (dir !== from ? null : Promise.reject(e)))));
      const next = [];
      level.forEach((dir, i) => {
        const r = lists[i];
        root ||= r?.root || null;
        const b = r?.browser;
        if (b?.path !== dir) {
          if (dir !== from) opening.get(dir).listed = false;
          return;
        }
        if (dir === from) found = true;
        if (b.truncated) more = true;
        for (const e of b.entries || []) {
          if (e.name.startsWith(".")) continue;
          const p = dir ? `${dir}/${e.name}` : e.name;
          if (e.kind === "directory") {
            const opens = !FILLED.has(e.name) && left > next.length;
            const d = { path: p, modified: iso(e.updatedAtMs), listed: opens };
            dirs.push(d);
            if (opens) {
              next.push(p);
              opening.set(p, d);
            }
          } else if (e.kind !== "file") continue;
          else if (files.length < WS_FILES) files.push({ path: p, size: e.size ?? null, modified: iso(e.updatedAtMs) });
          else more = true;
        }
      });
      level = next;
    }
    if (!root) throw refused(404, "OpenClaw didn't say where its workspace is.");
    if (from && !found) throw refused(404, `There's no ${from} in ${root}.`);
    return { root, files, dirs, more, core: false, ...(from ? { dir: from } : {}) };
  }
  async function coreFiles(a) {
    const r = await call("agents.files.list", { agentId: a });
    const files = (r?.files || []).filter((f) => !f.missing).map((f) => ({ path: f.name, size: f.size ?? null, modified: iso(f.updatedAtMs) }));
    return { root: r?.workspace || agents.get(a)?.workspace || "", files, dirs: [], more: false, core: true };
  }
  // One of its files (or folders), as a post's are (see file): through its session, or else by its name.
  async function workspaceFile(id, asked) {
    const a = id.slice(AGENT.length);
    if (!agents.has(a)) throw refused(404, "No such agent");
    const key = homes.get(a)?.key;
    if (key) return file(key, asked);
    const name = path.posix.basename(asked);
    let r;
    try {
      r = await call("agents.files.get", { agentId: a, name });
    } catch (e) {
      throw /unsupported file|not found|missing/i.test(e.message) ? refused(404, `Until ${agentName(a)} has a thread, OpenClaw shows only the files it keeps for it (AGENTS.md, SOUL.md, MEMORY.md…).`) : e;
    }
    const f = r?.file;
    if (!f || f.missing) throw refused(404, `There's no ${asked} in ${r?.workspace || "its workspace"}.`);
    return { root: r.workspace || path.posix.dirname(f.path), path: f.path, name: f.name, size: f.size, modified: iso(f.updatedAtMs), text: f.content ?? "" };
  }

  // One it can't read (a video, a sound, a file over 256 KB that isn't text or a picture), as it's wanted, a
  // piece at a time, through the session it looks through the workspace with (see gatewayFile).
  function workspaceStream(id, p, opts) {
    const key = homes.get(id.slice(AGENT.length))?.key;
    if (!key) return Promise.reject(refused(404, "Until it has a thread, OpenClaw shows only the files it keeps for it (AGENTS.md, SOUL.md, MEMORY.md…)."));
    return gatewayFile(key, p, opts);
  }

  /* ---------- media in its messages ---------- */

  // A picture, sound, video or file from one of its messages, by what its file on the post keeps (see
  // mediaOf), as it comes (a Response, for agentbook to keep). OpenClaw hands it over (artifacts.download) in
  // base64, or as a short-lived link on its gateway, which agentbook follows: on the gateway it connects to, or
  // else the one `openclaw` reaches on this machine (OPENCLAW_GATEWAY_URL, or its own port). A link anywhere else
  // it doesn't follow. The link has two minutes to start; the rest takes as long as it takes (`signal` stops it),
  // as a gateway far away can be slow. One over MEDIA_MAX is too big to keep here: it comes from the gateway
  // each time it's wanted, a piece at a time (streamMedia).
  const MEDIA_MAX = Number(process.env.AGENTBOOK_OPENCLAW_MEDIA_MAX || 64 << 20); // bytes
  async function fetchMedia(key, ref, { signal } = {}) {
    const res = ref.source ? await gatewayFile(key, ref.source, { signal }) : await streamMedia(key, ref, { signal });
    if (Number(res.headers.get("content-length")) > MEDIA_MAX) {
      res.body?.cancel().catch(() => {});
      throw refused(413, "This file is too big to show here.");
    }
    return res;
  }
  // Its answer, once it starts (`range`: a piece of it; `signal`: stop when nobody wants it anymore).
  async function streamMedia(key, ref, { range, signal } = {}) {
    if (ref.source) return gatewayFile(key, ref.source, { range, signal });
    const r = await download(key, ref);
    if (r?.encoding === "base64" && typeof r.data === "string") return new Response(Buffer.from(r.data, "base64"));
    const res = await started(linkOf(r), { headers: range ? { range } : {}, signal });
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      throw refused(res.status === 404 || res.status === 410 ? 404 : res.status === 416 ? 416 : 502, `OpenClaw's gateway wouldn't hand this file over (${res.status}).`);
    }
    return res;
  }
  async function download(key, ref) {
    let id = ref.artifact;
    if (!id) {
      const list = (await call("artifacts.list", { sessionKey: key }))?.artifacts || [];
      const a = (ref.seq != null && list.filter((x) => x.messageSeq === ref.seq)[ref.n]) || (ref.title && list.find((x) => x.type === ref.type && x.title === ref.title));
      if (!a) throw refused(404, "OpenClaw doesn't have this file anymore.");
      id = a.id;
    }
    try {
      return await call("artifacts.download", { sessionKey: key, artifactId: id }, 60000);
    } catch (e) {
      if (e.details?.type === "artifact_not_found" || /artifact not found/.test(e.message)) throw refused(404, "OpenClaw doesn't have this file anymore.");
      throw e;
    }
  }
  // A file from the gateway, once it starts coming: it has two minutes to start; the rest takes as long as it
  // takes, until `signal` stops it.
  async function started(url, { headers, signal } = {}) {
    const ctl = new AbortController();
    const late = setTimeout(() => ctl.abort(new Error("OpenClaw's gateway took too long to hand this file over.")), 120e3);
    if (signal?.aborted) ctl.abort(signal.reason);
    signal?.addEventListener("abort", () => ctl.abort(signal.reason), { once: true });
    try {
      return await fetch(url, { headers, signal: ctl.signal });
    } finally {
      clearTimeout(late);
    }
  }
  function linkOf(r) {
    const base = gatewayHttp();
    const url = typeof r?.url === "string" ? new URL(r.url.startsWith("/") ? base.pathname.replace(/\/$/, "") + r.url : r.url, base) : null;
    if (!url || url.origin !== base.origin) throw refused(404, "OpenClaw can't hand this file over to agentbook.");
    return url;
  }
  // A file on the gateway's machine (one an agent sent with a MEDIA: line, or one in its workspace), the way
  // OpenClaw's Control UI gets one: over HTTP (assistant-media), signed in as agentbook (its token, or the
  // device token the gateway gave it). OpenClaw hands over what's in its agents' folders (their media, the
  // session's workspace), and pictures elsewhere. Only from a gateway agentbook connects to itself: the openclaw
  // command can't hand one over. A gateway shuts a machine out after a few failed sign-ins, so until one file
  // has come through they're asked for one at a time, and once the gateway turns agentbook away it isn't asked
  // again for an hour.
  const TURNED_AWAY_MS = Number(process.env.AGENTBOOK_OPENCLAW_TURNED_AWAY_MS || 60 * 60e3);
  let sentWorks = false;
  let turnedAway = 0;
  let sentQueue = Promise.resolve();
  function gatewayFile(key, source, opts) {
    if (sentWorks) return askGateway(key, source, opts);
    const turn = sentQueue.then(() => askGateway(key, source, opts));
    sentQueue = turn.catch(() => {});
    return turn;
  }
  // Its answer, once it starts (`range`: a piece of it, as a player asks; `signal`: stop when nobody wants it
  // anymore).
  async function askGateway(key, source, { range, signal } = {}) {
    const s = settings();
    const auth = s.token || s.password || readConfig().device?.deviceToken;
    if (!gw || !s.url || !auth) throw refused(404, "agentbook can open this file only from a gateway it connects to itself (in Add agents).");
    if (Date.now() - turnedAway < TURNED_AWAY_MS) throw refused(503, "OpenClaw's gateway turned agentbook away when it asked for a file, so agentbook waits a while before asking again.");
    const res = await started(mediaUrl(key, source), { headers: { authorization: `Bearer ${auth}`, ...(range ? { range } : {}) }, signal });
    if (res.status === 401 || res.status === 403 || res.status === 429) {
      res.body?.cancel().catch(() => {});
      turnedAway = Date.now();
      sentWorks = false;
      log(`openclaw: the gateway turned agentbook away (${res.status}) when it asked for ${source}; not asking for files again for a while`);
      throw refused(503, "OpenClaw's gateway turned agentbook away when it asked for this file, so agentbook waits a while before asking again.");
    }
    if (!res.ok) {
      res.body?.cancel().catch(() => {});
      if (res.status === 404) throw refused(404, await whyNot(key, source, auth));
      throw refused(res.status === 416 ? 416 : 502, `OpenClaw's gateway wouldn't hand this file over (${res.status}).`);
    }
    sentWorks = true;
    return res;
  }
  function mediaUrl(key, source) {
    const base = gatewayHttp();
    const url = new URL(`${base.pathname.replace(/\/$/, "")}/__openclaw__/assistant-media`, base);
    url.searchParams.set("source", source);
    url.searchParams.set("sessionKey", key);
    return url;
  }
  // Why the gateway won't hand a file over, as its Control UI asks it (meta=1): it isn't there anymore (what an
  // agent sends goes a day after), or it's outside the folders the agent shares. A gateway that doesn't say gets
  // the vaguer answer.
  async function whyNot(key, source, auth) {
    const name = path.posix.basename(source);
    let code = null;
    try {
      const url = mediaUrl(key, source);
      url.searchParams.set("meta", "1");
      const r = await fetch(url, { headers: { authorization: `Bearer ${auth}` }, signal: AbortSignal.timeout(15e3) });
      code = r.ok ? (await r.json())?.code || null : (r.body?.cancel().catch(() => {}), null);
    } catch {}
    if (code === "file-not-found") return /\/media\/outbound\//.test(source) ? `OpenClaw doesn't have ${name} anymore: it deletes what its agents send a day after they send it, and agentbook hadn't kept a copy.` : `${name} isn't on OpenClaw's machine anymore (it was at ${source}).`;
    if (code === "outside-allowed-folders") return `OpenClaw won't hand ${name} over: it's outside the folders its agent shares (${source}).`;
    return "OpenClaw won't hand this file over: it's gone, or not in a folder its agents share.";
  }
  // The gateway's address over HTTP, where its links are (under its path, for one behind a proxy).
  function gatewayHttp() {
    const u = new URL((gw && settings().url) || process.env.OPENCLAW_GATEWAY_URL || `ws://127.0.0.1:${process.env.OPENCLAW_GATEWAY_PORT || 18789}`);
    u.protocol = u.protocol === "wss:" || u.protocol === "https:" ? "https:" : "http:";
    u.search = u.hash = "";
    return u;
  }

  /* ---------- routines ---------- */

  // Its agents' routines: OpenClaw's cron jobs, each with its schedule, what it's told to do, and how its last
  // run went. They're listed every 30 seconds, and again at once when the gateway says its cron changed, so a
  // profile knows what it has; a routine's runs are asked for when a page wants them. Each run is a session
  // of its own (unless the routine runs in a session that's a post), kept off the feed.
  const payloadText = (p = {}) => (p.kind === "agentTurn" ? p.message : p.kind === "systemEvent" ? p.text : p.kind === "command" ? (p.argv || []).join(" ") : p.kind === "script" ? p.script : "");
  function routineOf(j) {
    const st = j.state || {};
    const d = j.delivery;
    return {
      id: j.id,
      agent: agentId(j.agentId || (j.sessionKey ? keyAgent(j.sessionKey) : defaultAgent)),
      name: j.displayName || j.name,
      description: j.description || "",
      enabled: j.enabled !== false,
      builtin: !!j.declarationKey, // upkeep OpenClaw sets up itself
      kind: j.payload?.kind || null, // agentTurn (a prompt), systemEvent, command, script, heartbeat
      what: String(payloadText(j.payload) || ""),
      model: j.payload?.model || null,
      schedule: j.schedule || null,
      target: j.sessionTarget || "isolated", // a session of its own each run, "main", or "session:<key>"
      delivery: d && d.mode !== "none" ? { mode: d.mode, channel: d.channel || null, to: d.to || null } : null,
      next: j.enabled !== false ? iso(st.nextRunAtMs ?? j.nextRunAtMs) : null,
      running: iso(st.runningAtMs),
      last: iso(st.lastRunAtMs ?? j.lastRunAtMs),
      status: st.lastRunStatus ?? st.lastStatus ?? j.lastRunStatus ?? null, // ok, error, skipped
      error: st.lastError ?? j.lastRunError ?? null,
      took: st.lastDurationMs ?? null,
      failing: st.consecutiveErrors || 0,
      created: iso(j.createdAtMs),
    };
  }
  // A run: when, how long, how it went, what it reported, and its session (`post` when that's a post here).
  const runOf = (r) => ({
    id: r.runId || r.sessionId || `${r.jobId}:${r.ts}`,
    job: r.jobId,
    at: iso(r.runAtMs ?? r.ts),
    took: r.durationMs ?? null,
    status: r.status || null,
    error: r.error || null,
    summary: r.summary || null,
    session: r.sessionKey || null,
    post: r.sessionKey && post(r.sessionKey) ? r.sessionKey : null,
    model: r.model || null,
    delivered: r.deliveryStatus || null,
  });

  let jobsError = null;
  async function loadRoutines() {
    jobsAt = Date.now();
    try {
      const list = [];
      for (let offset = 0; ; ) {
        const r = await call("cron.list", { includeDisabled: true, limit: 200, ...(offset ? { offset } : {}) });
        list.push(...(r?.jobs || []));
        if (!r?.hasMore || !r.jobs?.length) break;
        offset = Number(r.nextOffset) || offset + r.jobs.length;
      }
      jobsError = null;
      const next = list.map(routineOf);
      if (JSON.stringify(next) === JSON.stringify(jobs)) return;
      jobs = next;
    } catch (e) {
      if (jobsError !== e.message) log(`OpenClaw: couldn't list its routines: ${(jobsError = e.message)}`);
      if (jobs === null) return;
      jobs = null;
    }
    host.changed();
  }

  // What an agent's profile shows of its routines before you open them: how many, the next run, how many
  // failed last time. null: none to show (it isn't OpenClaw's, or the gateway has no cron).
  function routinesOf(id) {
    if (!jobs) return null;
    const mine = jobs.filter((j) => j.agent === id && !j.builtin);
    const next = mine.map((j) => j.next).filter(Boolean).sort()[0] || null;
    const last = mine.map((j) => j.last).filter(Boolean).sort().at(-1) || null;
    return { n: mine.length, paused: mine.filter((j) => !j.enabled).length, failing: mine.filter((j) => j.enabled && j.status === "error").length, failed: failedRoutines(mine), running: mine.filter((j) => j.running).length, next, last };
  }

  const ownJob = (id, job) => jobs?.find((j) => j.id === job && j.agent === id) || null;
  const fresh = () => (Date.now() - jobsAt > 5000 ? loadRoutines() : null);
  const runsOf = async (params) => {
    const r = await call("cron.runs", { limit: 50, sortDir: "desc", ...params });
    return { runs: (r?.entries || []).map(runOf), total: r?.total ?? null, more: !!r?.hasMore };
  };

  // An agent's routines.
  // A job's thread, when it has one, on what its page says of it.
  const withThread = (j) => {
    const key = `agent:${j.agent.slice(AGENT.length)}:cron:${j.id}`;
    return post(key) ? { ...j, post: key } : j;
  };
  async function routines(id) {
    await fresh();
    return jobs && { routines: jobs.filter((j) => j.agent === id).map(withThread) };
  }
  // One of them, with its runs, newest first (`offset` for older ones).
  async function routine(id, job, { offset = 0 } = {}) {
    await fresh();
    const j = ownJob(id, job);
    if (!j) return null;
    return { routine: withThread(j), ...(await runsOf({ scope: "job", id: job, ...(offset ? { offset } : {}) })) };
  }
  // A run, from its session's history: the steps it took and what it said, the last of which is its result.
  // OpenClaw lets go of a run's session once the run is over and idle, and its history comes back empty then
  // (`gone`), not as an error: what the run reported (its summary) is all that's left of it.
  async function routineRun(id, job, key) {
    if (!ownJob(id, job) || keyAgent(key) !== id.slice(AGENT.length)) return null;
    const r = await call("chat.history", { sessionKey: key, limit: 200 });
    const d = blank();
    let reply = null;
    const messages = r?.messages || [];
    for (const entry of messages) {
      const m = entry?.message || entry;
      if (!m?.role) continue;
      const at = iso(m.timestamp || entry.timestamp);
      if (startsTurn(m)) d.turn++;
      const said = fold(d, m, entry.id || m.id || `${m.role}:${m.timestamp}`, at, agents.get(keyAgent(key))?.workspace);
      if (said) reply = { text: said, at };
    }
    return { steps: d.steps.map(({ id, kind, at, tool, title, text, done, error }) => ({ id, kind, at, tool, title, text, done, error })), reply, model: d.model, gone: !messages.length };
  }
  // Run one now, or pause or resume it.
  // OpenClaw does either only for an admin: its owner's, over the owner's connection.
  async function routineDo(id, job, what) {
    if (!ownJob(id, job)) return false;
    try {
      if (what === "run") await ownerCall("cron.run", { id: job, mode: "force" });
      else await ownerCall("cron.update", { id: job, patch: { enabled: what === "resume" } });
    } catch (e) {
      if (/missing scope: operator\.admin/i.test(e.message)) throw new Error("OpenClaw runs, pauses and resumes cron jobs only for an admin: give agentbook admin on Settings, Agents, OpenClaw.");
      throw e;
    }
    await loadRoutines();
    return true;
  }

  // Posts copied before agentbook left out what OpenClaw adds to what's said: what it wrote to its agents
  // goes, and the rest is said again without its notes, a reply's MEDIA: lines becoming its files.
  // Once, and then this list goes: seven copies agentbook got wrong, which its person said to drop on 2026-11-07, by their
  // id in OpenClaw. Three files said again with no words, an answer agentbook passed on shown as the person's, and three cron
  // prompts shown as their agent's words beside the same prompt from its routine. Its rules no longer copy these.
  const WRONG = new Set(["4d4b8581-f7c4-4bac-8185-b0347e61adaa:say", "674e25f2-1898-4be3-b216-bcd17231ab48:say", "ab1f2903-651f-4244-baa8-dacdb94fb057:say", "c4c80ddd-e4e1-421f-b776-1ed68d3b927b", "2abc4203-83bb-47a2-9b5e-13084d548df6:say", "04008b53-bab7-488b-958a-57a36739b7b4:say", "7ef2548a-3d3a-4376-9e7f-acb4ed946feb:say"]);
  function tidy() {
    const drop = {};
    for (const m of [...host.state.messages, ...outOfMemory(host.state, "messages")]) {
      if (!m.ext || !String(post(m.post)?.agent || "").startsWith(AGENT)) continue;
      if (WRONG.has(m.ext)) {
        (drop[m.post] ||= []).push(m.id);
        continue;
      }
      let text = m.via === "dash" ? m.text : yoursOf(m.text);
      if (m.from === "agent") {
        const lines = mediaLines(m.text);
        text = lines.text;
        const sent = once([...(m.files || []).map((f) => ({ name: f.name })), ...sentOf(lines.sent)]).filter((x) => x.ref?.source);
        if (sent.length) host.commit({ t: "message.files", post: m.post, ext: m.ext, files: keep(m.post, m.ext, sent, "agent") });
      }
      if (text === m.text) continue;
      if (text === null || (!text && !m.files?.length && !m.file_id)) (drop[m.post] ||= []).push(m.id);
      else host.commit({ t: "message.text", post: m.post, ext: m.ext, text });
    }
    for (const [key, mids] of Object.entries(drop)) host.commit({ t: "message.drop", post: key, mids });
  }

  // Its gateway's providers' usage limits: one read for all its agents, at most once a minute.
  const usage = limitsReader(async () => ({ limits: openclawLimitsOf(await call("usage.status", {}, 20000)), host: hostName() }));

  function begin() {
    if (!enabled) return;
    tidy();
    linkGateway();
    sync();
    setInterval(sync, Number(process.env.AGENTBOOK_OPENCLAW_SYNC_MS || 5000)).unref();
  }

  return {
    prefix: "openclaw",
    name: "OpenClaw",
    localFiles: false, // its agents' files are on the gateway's machine, which may not be this one
    sendsFiles: true, // so the files you attach go to it, rather than their paths here
    configure,
    connection,
    askAdmin,
    owns: (id) => String(id).startsWith(AGENT) && host.state.agents[id]?.kind === "openclaw",
    folders: false, // its agents work in their own workspaces
    begin,
    // Its CLI reached its server: pictures it couldn't send up before go now.
    connected: () => lastListed.length && loadAvatars(lastListed),
    sync,
    start,
    stop,
    deliver,
    steps,
    file: (s, p) => file(s.id, p),
    workspaceOf,
    workspace,
    workspaceFile,
    media: (s, ref, opts) => fetchMedia(s.id, ref, opts),
    streamMedia: (s, ref, opts) => streamMedia(s.id, ref, opts),
    streams: () => !!gw, // the files OpenClaw won't hand over whole come a piece at a time only from a gateway it connects to
    stream: (s, p, opts) => gatewayFile(s.id, p, opts),
    workspaceStream,
    skillFile,
    live: (s) => liveOf(sessions.get(s.id)?.digest),
    summary: (s) => summaryOf(sessions.get(s.id)?.digest, s),
    working: (key) => !!sessions.get(key)?.active,
    workers: workersOf,
    workerSteps: workerStepsOf,
    models: () => null,
    switchesModel: false,
    commands,
    replyBlocked: (s) => (JOB_KEY.test(s.id) ? "OpenClaw doesn't take messages in a cron job's own session. Its runs add to this thread." : null),
    resumeCommand: (s) => (JOB_KEY.test(s.id) ? null : `openclaw tui --session ${s.session_id}`),
    syncing: syncingPost,
    routinesOf,
    routines,
    routine,
    routineRun,
    routineDo,
    limits: (id) => (String(id).startsWith(AGENT) && host.state.agents[id]?.kind === "openclaw" ? usage() : null),
    machine: () => hostName(),
    link,
    status: () => ({ enabled, connected, error: lastError, syncing: waiting.length + reading.size }),
  };
}
