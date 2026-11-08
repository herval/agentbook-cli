// Devin: Cognition's agent, in a machine of theirs, on a service user's key. Each thread is one of its sessions (a
// post whose proc is "devin:<session id>"), one started here: a key sees its whole organization's sessions, and a
// colleague's aren't anyone's thread here.
//
// Devin's API has messages and a status, and no steps, no events and nothing to approve with, so a thread shows what
// it says, its pull requests and what it has used, and links to Devin for the rest. It's asked for what's new only
// while something can change without you: often while it works, slowly while it waits on an approval only Devin's own
// page can give, and not at all while it waits for you (your message, or opening the thread, looks again).

import { addSay, blank, deliverer, iso, liveOf, short, summaryOf } from "./steps.mjs";
import { callApi, filesOn, githubRepo, keptFile, linkPr } from "./remote.mjs";

const AGENT = "devin";
const NAME = "Devin";
const BASE = () => process.env.AGENTBOOK_DEVIN_URL || "https://api.devin.ai";
const WORKING_MS = () => Number(process.env.AGENTBOOK_DEVIN_POLL_MS || 5000);
const APPROVAL_MS = () => WORKING_MS() * 6;
const RETRY_MS = () => WORKING_MS() * 12;
const LOOK_AGAIN_MS = 10e3; // opening a thread looks again, at most this often
// What you send takes Devin a moment to act on: until it says something, or this long passes, "waiting for you" is
// from before your message, and stopping looking then would lose the run it starts.
const SETTLE_MS = () => WORKING_MS() * 6;
const MODES = [
  { id: "normal", name: "Agent" },
  { id: "fast", name: "Fast" },
  { id: "lite", name: "Lite" },
  { id: "ultra", name: "Ultra" },
];
const SHORT_OF_CREDITS = new Set(["out_of_credits", "out_of_quota", "usage_limit_exceeded"]);

const isBusy = (s) => ["new", "claimed", "resuming"].includes(s.status) || (s.status === "running" && (!s.status_detail || s.status_detail === "working"));
const isOver = (s) => s.status === "exit" || s.status === "error" || !!s.is_archived;

export function createDevin(host) {
  const { log } = host;
  const enabled = process.env.AGENTBOOK_DEVIN !== "0";
  const kept = keptFile("devin"); // { key, org, budget: the ACUs a thread may use }
  const convs = new Map(); // post -> what's been read of its session
  let lastError = null;

  const conv = (id) => convs.get(id) || convs.set(id, { digest: blank(), seen: new Set(), sent: [], session: null, busy: false, ended: false, timer: null, pulling: null, looked: 0, link: null, prs: 0, approval: false, asked: 0 }).get(id);
  const post = (id) => host.state.sessions[id];
  const headers = (key) => ({ authorization: `Bearer ${key}` });
  // Its status can't be the last word yet: it may not have got to what you wrote, or what it just said came after that
  // status was read (a look reads the status first, so that the end of a session comes with all it said).
  const settling = (c) => c.heard || Date.now() - c.asked < SETTLE_MS();
  const call = async (method, route, opts = {}, key = kept.read().key) => {
    if (!key) throw new Error(`${NAME} isn't connected on this machine: add its API key on Add agents.`);
    return callApi(NAME, `${BASE()}/v3${route}`, { method, headers: headers(key), ...opts });
  };
  const inOrg = (route) => `/organizations/${encodeURIComponent(kept.read().org)}${route}`;
  const proc = (id) => `devin:${id}`;

  /* ---------- connecting ---------- */

  const announce = () => {
    if (!host.state.agents[AGENT]) host.commit({ t: "agent.hello", agent: AGENT, agent_name: NAME, kind: AGENT });
  };
  // Connect this machine: its key, tried right here, which says which organization it's for unless it's for several.
  async function configure({ disconnect, key, org, budget }) {
    const was = kept.read();
    if (disconnect) {
      kept.write({});
      lastError = null;
      return connection();
    }
    const use = key || was.key;
    if (!use) throw new Error("Paste its API key.");
    const acus = budget === undefined ? was.budget : Number(budget);
    if (acus !== undefined && !(Number.isInteger(acus) && acus > 0)) throw new Error("What a thread may use is a whole number of ACUs.");
    const self = await call("GET", "/self", {}, use);
    const found = org || self.devin_sessions_org_id || self.org_id || (key ? null : was.org);
    if (!found) throw new Error("That key isn't for one organization: give its organization id too.");
    kept.write({ key: use, org: found, ...(acus ? { budget: acus } : {}) });
    lastError = null;
    announce();
    return connection();
  }
  function connection() {
    const c = kept.read();
    return { connected: !!c.key, org: c.org || null, budget: c.budget || null, error: lastError };
  }

  /* ---------- its session, read ---------- */

  function setBusy(id, busy, text) {
    const s = post(id);
    const c = conv(id);
    if (!s) return;
    if (busy && !c.busy && s.state !== "working") {
      if (s.state === "done") host.commit({ t: "session.hello", proc: proc(id), agent: AGENT, agent_name: NAME, kind: AGENT, label: s.label, session_id: id, channel: true });
      host.commit({ t: "session.status", post: id, state: "working", turn: "start" });
    } else if (!busy && (c.busy || s.state === "working" || (text && s.doing !== text))) {
      host.commit({ t: "session.status", post: id, state: "idle", text: text || "Waiting for your next message", turn: "end" });
    }
    const was = c.busy;
    c.busy = busy;
    host.changed(id, was && !busy);
  }
  function ended(id, reason) {
    const c = conv(id);
    if (c.ended) return;
    c.ended = true;
    c.busy = false;
    if (post(id) && post(id).state !== "done") host.commit({ t: "session.gone", post: id, reason, ended: new Date().toISOString() });
    host.changed(id, true);
  }
  const waitingFor = (s) => {
    if (s.status === "suspended") return SHORT_OF_CREDITS.has(s.status_detail) ? "Out of Devin credits" : "Asleep: your next message wakes it";
    if (s.status_detail === "waiting_for_approval") return "Waiting for an approval in Devin";
    if (s.status_detail === "finished") return "Finished: your next message goes on";
    return "Waiting for your next message";
  };

  // What the session says it is now, on its post.
  function note(id, s) {
    const c = conv(id);
    c.session = s;
    if (s.title && s.title !== c.digest.ai_title) c.digest.ai_title = s.title;
    const prs = s.pull_requests || [];
    if (prs.length !== c.prs) {
      c.prs = prs.length;
      for (const p of prs) linkPr(host, id, p.pr_url, iso(s.updated_at) || new Date().toISOString());
    }
    const used = Number(s.acus_consumed);
    const text = Number.isFinite(used) && used > 0 ? `${used.toFixed(1)} ACUs used.` : "Runs in Devin's cloud.";
    if (s.url && `${s.url} ${text}` !== c.link) {
      c.link = `${s.url} ${text}`;
      host.commit({ t: "session.attach", post: id, key: "remote", type: "link", title: NAME, data: { url: s.url, title: "Open in Devin", text } });
    }
    const approval = s.status_detail === "waiting_for_approval";
    if (approval && !c.approval) host.commit({ t: "message.add", post: id, from: "agent", via: "dash", text: `${NAME} is waiting for an approval, which only its own page can give: open this session in Devin to approve.` });
    c.approval = approval;
    if (isOver(s)) return ended(id, s.status === "error" ? `${NAME}'s session failed.` : `${NAME}'s session ended.`);
    if (isBusy(s)) {
      c.asked = 0;
      return setBusy(id, true);
    }
    if (!settling(c)) setBusy(id, false, waitingFor(s));
  }

  // What it said since last time. After a restart everything comes again: what's on the post already stays as it is.
  async function messages(id) {
    const c = conv(id);
    const had = host.state.messages.filter((m) => m.post === id);
    const known = new Set(had.map((m) => m.id));
    const humans = had.filter((m) => m.from === "human").map((m) => String(m.text || "").trim());
    const cold = host.state.cold?.has(id);
    const d = c.digest;
    for (let after = c.cursor || null; ; ) {
      const r = await call("GET", inOrg(`/sessions/${encodeURIComponent(id)}/messages?first=200${after ? `&after=${encodeURIComponent(after)}` : ""}`));
      for (const m of r.items || []) {
        if (!m.event_id || c.seen.has(m.event_id)) continue;
        c.seen.add(m.event_id);
        const text = String(m.message || "").trim();
        if (!text) continue;
        const at = iso(m.created_at) || new Date().toISOString();
        if (m.source === "devin") {
          addSay(d, { id: m.event_id, at, text });
          c.asked = 0;
          c.heard = true;
          if (!cold && !known.has(m.event_id)) host.commit({ t: "message.add", post: id, mid: m.event_id, from: "agent", via: "dash", text, when: at });
          continue;
        }
        d.turn++;
        const i = c.sent.indexOf(text);
        if (i >= 0) c.sent.splice(i, 1);
        // Written in Devin itself.
        else if (!cold && !known.has(m.event_id) && !humans.some((h) => h && text.startsWith(h))) host.commit({ t: "message.add", post: id, mid: m.event_id, from: "human", via: "terminal", text, when: at });
      }
      if (r.end_cursor) c.cursor = r.end_cursor;
      after = r.has_next_page ? r.end_cursor : null;
      if (!after) break;
    }
  }

  function pull(id) {
    const c = conv(id);
    c.pulling ||= (async () => {
      try {
        c.heard = false;
        const s = await call("GET", inOrg(`/sessions/${encodeURIComponent(id)}`));
        await messages(id);
        c.looked = Date.now();
        note(id, s);
      } finally {
        c.pulling = null;
      }
    })();
    return c.pulling;
  }

  // Look again in `ms`, and go on for as long as something can change without you.
  function watch(id, ms) {
    const c = conv(id);
    clearTimeout(c.timer);
    c.timer = setTimeout(async () => {
      c.timer = null;
      let next = null;
      try {
        await pull(id);
        const s = c.session;
        next = c.ended ? null : isBusy(s) || settling(c) ? WORKING_MS() : s.status_detail === "waiting_for_approval" ? APPROVAL_MS() : null;
      } catch (e) {
        if (e.status === 404) return ended(id, `${NAME}'s session is gone.`);
        if (e.status === 401 || e.status === 403) {
          lastError = e.message;
          return log(`devin ${id}: ${e.message}`);
        }
        log(`devin ${id}: ${e.message}`);
        next = RETRY_MS();
      }
      if (next && !c.ended) watch(id, next);
    }, ms);
    c.timer.unref?.();
  }

  /* ---------- talking to it ---------- */

  // A thread's files, kept by Devin: -> their addresses, and a line for each it couldn't get.
  async function attach(files) {
    const { ready, missed } = filesOn(files);
    const urls = [];
    for (const f of ready) {
      const form = new FormData();
      form.set("file", new Blob([f.bytes]), f.name);
      const r = await call("POST", inOrg("/attachments"), { form, timeout: 120e3 });
      const url = typeof r === "string" ? r : r.url || r.attachment_url;
      if (url) urls.push(url);
      else missed.push(f.name);
    }
    return { urls, lines: missed.map((name) => `[${name} couldn't be sent]`) };
  }

  async function send(id, text, files = []) {
    const c = conv(id);
    if (c.ended) throw new Error(`${NAME}'s session has ended.`);
    const { urls, lines } = await attach(files);
    const message = [text, ...lines].filter(Boolean).join("\n\n") || "See the attached files.";
    c.sent.push(message.trim());
    await call("POST", inOrg(`/sessions/${encodeURIComponent(id)}/messages`), { body: { message, ...(urls.length ? { attachment_urls: urls } : {}) } });
    c.asked = Date.now();
    setBusy(id, true);
    watch(id, Math.min(1000, WORKING_MS()));
  }
  const deliver = deliverer({ host, log, name: NAME, answer: async () => false, send, sendsFiles: true });

  async function start({ prompt, shown = prompt, files = [], lid, model, repo }) {
    // The server sends a start again when this process stopped before answering: a session costs money, so it's the
    // same one.
    const again = Object.values(host.state.sessions).find((s) => s.launch === lid && s.proc?.startsWith("devin:"));
    if (again) return { id: again.id };
    if (!kept.read().key) throw new Error(`${NAME} isn't connected on this machine: add its API key on Add agents.`);
    const gh = repo ? githubRepo(repo) : null;
    if (repo && !gh) throw new Error(`${NAME} can only be pointed at repos on GitHub from here.`);
    const { urls, lines } = await attach(files);
    const said = [prompt, ...lines].filter(Boolean).join("\n\n");
    const s = await call("POST", inOrg("/sessions"), { body: { prompt: said, title: short(shown, 100), tags: ["agentbook"], ...(gh ? { repos: [`${gh.owner}/${gh.name}`] } : {}), ...(model ? { devin_mode: model } : {}), ...(kept.read().budget ? { max_acu_limit: kept.read().budget } : {}), ...(urls.length ? { attachment_urls: urls } : {}) } });
    const id = s.session_id;
    const c = conv(id);
    c.sent.push(said.trim());
    c.digest.model = model || "normal";
    const now = iso(s.created_at) || new Date().toISOString();
    host.commit({ t: "session.hello", proc: proc(id), agent: AGENT, agent_name: NAME, kind: AGENT, label: host.label(id), session_id: id, cwd: "", root: "", repo: gh?.key || "", branch: "", host: "cloud", channel: true, launch: lid, started: now, updated: now, prompt: short(shown, 2000) });
    host.commit({ t: "message.add", post: id, from: "human", via: "dash", text: shown, resume: lid });
    host.changed(id, true);
    note(id, s);
    setBusy(id, true);
    watch(id, Math.min(1000, WORKING_MS()));
    return { id };
  }

  // Never ended by this: Devin sleeps, and your next message wakes it.
  async function stop(id) {
    await call("POST", inOrg(`/sessions/${encodeURIComponent(id)}/sleep`));
    watch(id, 0);
  }

  function begin() {
    if (!enabled) return;
    if (kept.read().key) announce();
    for (const s of Object.values(host.state.sessions)) {
      if (!s.proc?.startsWith("devin:")) continue;
      if (s.state !== "done") watch(s.id, 0);
      if (host.pending(s.id).length) deliver(s.id);
    }
  }

  return {
    prefix: "devin",
    name: NAME,
    folders: false,
    localFiles: false, // what it edits is on its machine: a path it names means nothing on this one
    repos: true,
    sendsFiles: true,
    owns: (id) => id === AGENT && host.state.agents[id]?.kind === AGENT,
    machine: () => "cloud",
    link: () => ({ connected: !!kept.read().key, state: kept.read().key ? "connected" : "off" }),
    configure,
    connection,
    begin,
    start,
    stop,
    deliver,
    steps: async (id) => {
      const c = conv(id);
      if (kept.read().key && Date.now() - c.looked > LOOK_AGAIN_MS) {
        await pull(id).catch((e) => log(`devin ${id}: ${e.message}`));
        if (c.session && !c.ended && (isBusy(c.session) || settling(c)) && !c.timer) watch(id, WORKING_MS());
      }
      return c.digest;
    },
    live: (s) => liveOf(convs.get(s.id)?.digest),
    summary: (s) => summaryOf(convs.get(s.id)?.digest, s),
    working: (id) => !!convs.get(id)?.busy,
    models: () => ({ list: MODES, default: "normal" }),
    switchesModel: false,
    replyBlocked: (s) => (s.state === "done" ? `${NAME}'s session has ended.` : null),
    resumeCommand: () => null,
    status: () => ({ enabled, connected: !!kept.read().key, error: lastError }),
  };
}
