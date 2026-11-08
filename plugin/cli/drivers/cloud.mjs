// Sessions that run in the cloud, as far as the command line lets agentbook see them.
//
// - Codex Cloud tasks: `codex cloud list --json` lists them, so recent ones are posts on the Codex profile,
//   with their status and the size of their change. `codex cloud diff` shows the change, and `codex cloud
//   apply` applies it to a local checkout of the same repository. Codex Cloud takes follow-ups only in its
//   own page.
// - Claude Code cloud sessions: nothing lists them, and Claude Code doesn't let agentbook read them, so one
//   comes here by teleport (`claude --teleport <id>`, in a terminal): Claude Code checks out its branch in a
//   checkout of its repository and copies its conversation into a session on this machine, which is then a
//   post like any other. Posts that followed a session from before still send what you write to it
//   (`claude -p … --cloud <id>`). A new one starts in a terminal (`claude --cloud`), where you see what it
//   uploads.

import { execFile } from "node:child_process";
import { pluginCopy } from "../plugin-copy.mjs";
import { cleanEnv, goneOrMissing } from "./claude.mjs";

const DAYS = Number(process.env.AGENTBOOK_CODEX_DAYS || 14);
const short = (s, n = 120) => {
  s = String(s ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
};
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const sh = (s) => (/^[\w@%+=:,./-]+$/.test(String(s)) ? String(s) : q(s));

function run(bin, args, { cwd, timeout = 30000, env } = {}) {
  return new Promise((resolve, reject) =>
    execFile(bin, args, { cwd, timeout, env: env || cleanEnv(), maxBuffer: 32 << 20 }, (err, stdout, stderr) => {
      if (err) return reject(err.code === "ENOENT" ? goneOrMissing(cwd, `${bin} isn't installed here.`) : new Error(String(stderr || err.message).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim().split("\n").at(-1)));
      resolve(String(stdout));
    }),
  );
}

// "https://chatgpt.com/codex/tasks/task_e_…" or a bare task id.
export const codexTaskId = (ref) => String(ref || "").match(/\b(task_[a-z]_[0-9a-z]+)\b/i)?.[1] || null;

// "https://claude.ai/code/session_01…?from=cli", "claude.ai/code/cse_…" or a bare id.
export function cloudSessionId(ref) {
  const m = String(ref || "").trim().match(/(?:claude\.ai\/code\/)?((?:session|cse)_[A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

const CODEX_STATE = { ready: ["done", "Ready"], applied: ["done", "Applied"], error: ["done", "Failed"], failed: ["done", "Failed"], cancelled: ["done", "Cancelled"] };

// host: { state, commit, label, log }
export function createCloud(host) {
  const log = host.log || (() => {});
  const codexBin = process.env.AGENTBOOK_CODEX_BIN || "codex";
  const claudeBin = () => process.env.AGENTBOOK_CLAUDE || "claude";
  const post = (id) => host.state.sessions[id];
  let codexOk = process.env.AGENTBOOK_CODEX !== "0" && process.env.AGENTBOOK_CODEX_CLOUD !== "0";
  const diffs = new Map(); // task id -> { at, text }
  const statuses = new Map(); // task id -> its last status, so a new attempt's diff is fetched again

  /* ---------- Codex Cloud ---------- */

  async function syncCodex() {
    if (!codexOk) return;
    let list;
    try {
      list = JSON.parse(await run(codexBin, ["cloud", "list", "--json", "--limit", "20"])).tasks || [];
    } catch (e) {
      // Not signed in to ChatGPT, or no Codex: stop asking.
      if (/isn't installed|sign|login|auth/i.test(e.message)) codexOk = false;
      return log(`codex cloud: ${e.message}`);
    }
    const since = Math.max(Date.now() - DAYS * 86400e3, host.historyFrom?.() || 0);
    for (const t of list) {
      if (!post(t.id) && (Date.parse(t.updated_at) || Date.now()) < since) continue;
      upsertTask(t);
    }
  }

  // A Codex Cloud task as a post: its title, status, environment and the size of its change.
  function upsertTask(t) {
    const updated = Date.parse(t.updated_at) || Date.now();
    const [st, reason] = CODEX_STATE[String(t.status).toLowerCase()] || ["working", null];
    const repo = t.environment_label ? String(t.environment_label).split("/").pop() : "";
    if (!post(t.id)) {
      host.commit({ t: "session.hello", proc: `codexcloud:${t.id}`, agent: "codex", agent_name: "Codex", kind: "codex", label: host.label(t.id), session_id: t.id, cwd: "", root: "", repo, branch: "", host: "cloud", channel: true, cloud: "codex", url: t.url, prompt: short(t.title, 2000), started: new Date(updated).toISOString(), updated: new Date(updated).toISOString() });
      host.commit({ t: "session.snapshot", post: t.id, ai_title: short(t.title) });
    }
    const s = post(t.id);
    if (!s) return; // kept off agentbook (Private terminals)
    const sum = t.summary || {};
    const change = sum.files_changed ? `${sum.files_changed} file${sum.files_changed === 1 ? "" : "s"} changed, +${sum.lines_added || 0} −${sum.lines_removed || 0}` : "";
    const link = { url: t.url, title: "Open in Codex Cloud", text: [t.environment_label, change].filter(Boolean).join(", ") };
    if (JSON.stringify(s.attachments?.task?.data || null) !== JSON.stringify(link)) host.commit({ t: "session.attach", post: t.id, key: "task", type: "link", title: "Codex Cloud", data: link });
    if (st === "done" && s.state !== "done") host.commit({ t: "session.gone", post: t.id, reason, ended: new Date(updated).toISOString() });
    else if (st === "working" && (s.state === "done" || !s.busy)) {
      if (s.state === "done") host.commit({ t: "session.hello", proc: `codexcloud:${t.id}`, agent: "codex", agent_name: "Codex", kind: "codex", label: s.label, session_id: t.id, host: "cloud", channel: true, cloud: "codex", url: t.url });
      host.commit({ t: "session.status", post: t.id, state: "working", text: `Running in Codex Cloud (${t.status})`, turn: "start" });
    }
    if (statuses.get(t.id) !== t.status) diffs.delete(t.id);
    statuses.set(t.id, t.status);
  }

  // Bring one task here by its link, however old: from the recent list, or else from `codex cloud status`,
  // which prints "[READY] title", "environment  •  date" and "+20/-1 • 2 files".
  async function pullCodexTask(ref) {
    const id = codexTaskId(ref);
    if (!id) throw new Error("That isn't a Codex Cloud task link.");
    let t = null;
    try {
      t = (JSON.parse(await run(codexBin, ["cloud", "list", "--json", "--limit", "20"])).tasks || []).find((x) => x.id === id) || null;
    } catch {}
    if (!t) {
      const out = await run(codexBin, ["cloud", "status", id]).catch((e) => {
        throw new Error(`Codex Cloud doesn't know that task (${e.message}).`);
      });
      const [first = "", second = "", third = ""] = out.trim().split("\n").map((l) => l.trim());
      const head = first.match(/^\[([^\]]+)\]\s*(.*)$/);
      const change = third.match(/\+(\d+)\/-(\d+)\s*•\s*(\d+)\s*files?/);
      t = { id, url: `https://chatgpt.com/codex/tasks/${id}`, title: head?.[2] || id, status: (head?.[1] || "ready").toLowerCase(), updated_at: new Date().toISOString(), environment_label: second.split("•")[0].trim() || null, summary: change ? { lines_added: +change[1], lines_removed: +change[2], files_changed: +change[3] } : {} };
    }
    upsertTask(t);
    return id;
  }

  // The task's change, as a unified diff (cut at 200 KB).
  async function codexDiff(id) {
    const d = diffs.get(id);
    if (d && Date.now() - d.at < 60e3) return d.text;
    const text = await run(codexBin, ["cloud", "diff", id], { timeout: 45000 }).catch((e) => `Couldn't get the diff: ${e.message}`);
    const cut = text.length > 200_000 ? text.slice(0, 200_000) + "\n… (cut here; open it in Codex Cloud for the rest)" : text;
    diffs.set(id, { at: Date.now(), text: cut });
    return cut;
  }

  // Apply the task's change in a local checkout of its repository.
  async function codexApply(id, cwd) {
    return (await run(codexBin, ["cloud", "apply", id], { cwd, timeout: 120000 })).trim();
  }

  /* ---------- Claude Code cloud sessions ---------- */

  // What a post that followed a cloud session (before teleport came here) says about it.
  const followNote = (url) => ({ url, title: "Runs on claude.ai", text: "Its conversation and steps stay there: Claude Code doesn't let agentbook read them. What you write here goes to it. To continue it on this machine, with everything showing here, teleport it." });

  // Queue a message into a Claude Code cloud session. It answers on claude.ai.
  async function send(id, text) {
    const out = await run(claudeBin(), ["-p", text, "--cloud", id, "--output-format", "json"], { timeout: 60000 });
    let r;
    try {
      r = JSON.parse(out.slice(out.indexOf("{")));
    } catch {
      throw new Error(short(out, 200) || "Claude Code didn't say whether it sent it.");
    }
    if (!r.ok) throw new Error(r.error || "Claude Code couldn't send it.");
    return r;
  }

  // The command that teleports cloud session `id` into `root`. For a launch (`lid`), agentbook's plugin and
  // where to find agentbook go along, so the session registers here as that launch's post.
  function teleportCommand(id, { root, lid } = {}) {
    const env = lid ? [`AGENTBOOK_LAUNCH_ID=${sh(lid)}`, ...["AGENTBOOK_PORT", "AGENTBOOK_URL", "AGENTBOOK_HOME"].filter((k) => process.env[k]).map((k) => `${k}=${sh(process.env[k])}`)] : [];
    const plugin = lid && process.env.AGENTBOOK_PLUGIN_DIR ? ` --plugin-dir ${sh(pluginCopy())}` : "";
    return `${root ? `cd ${sh(root)} && ` : ""}${[...env, lid ? sh(claudeBin()) : "claude"].join(" ")} --teleport ${id}${plugin}`;
  }

  function begin() {
    // Followed sessions from before keep up with how they're described.
    for (const s of Object.values(host.state.sessions)) if (s.cloud === "claude" && s.url && JSON.stringify(s.attachments?.cloud?.data) !== JSON.stringify(followNote(s.url))) host.commit({ t: "session.attach", post: s.id, key: "cloud", type: "link", title: "Runs on claude.ai", data: followNote(s.url) });
    const tick = () => syncCodex().catch((e) => log(`codex cloud: ${e.message}`));
    setTimeout(tick, 3000).unref();
    setInterval(tick, Number(process.env.AGENTBOOK_CLOUD_SYNC_MS || 120e3)).unref();
  }

  return { begin, syncCodex, pullCodexTask, codexDiff, codexApply, send, teleportCommand };
}
