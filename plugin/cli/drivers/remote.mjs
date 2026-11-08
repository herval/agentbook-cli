// What the drivers of agents that run on someone else's computers share (Claude Agent, Devin): a key kept on this
// machine and nowhere else, their HTTP APIs, their event streams, and the repo a thread of theirs works in.

import fs from "node:fs";
import path from "node:path";
import { HOME } from "../../lib/common.mjs";
import { prOfUrl, prUrl } from "../../shared/prs.mjs";

// A file only this user can read, in the CLI's folder: { key, … }. Its key never goes up to the server, and nothing
// gives it back out.
export function keptFile(name) {
  const file = () => path.join(HOME, "cli", `${name}.json`);
  return {
    read() {
      try {
        return JSON.parse(fs.readFileSync(file(), "utf8")) || {};
      } catch {
        return {};
      }
    },
    write(c) {
      fs.mkdirSync(path.dirname(file()), { recursive: true });
      fs.writeFileSync(file(), JSON.stringify(c, null, 1) + "\n", { mode: 0o600 });
      fs.chmodSync(file(), 0o600);
    },
  };
}

// What a vendor's API said when it refused, in its own words when it has any.
const said = (j, text) => j?.error?.message || (typeof j?.error === "string" ? j.error : null) || (typeof j?.detail === "string" ? j.detail : null) || j?.message || text.slice(0, 200);
export function refusal(name, status, body) {
  let j = null;
  try {
    j = JSON.parse(body);
  } catch {}
  const why = said(j, body).trim();
  const e = new Error(status === 401 || status === 403 ? `${name} refused the key${why ? `: ${why}` : ""}` : `${name} said ${status}${why ? `: ${why}` : ""}`);
  e.status = status;
  return e;
}

// One call to a vendor's API. -> its JSON (or `raw`, its bytes). A call that gets no answer in time fails rather than
// hold up what's waiting on it.
export async function callApi(name, url, { method = "GET", headers = {}, body, form, raw = false, timeout = 30e3 } = {}) {
  const r = await fetch(url, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: form || (body !== undefined ? JSON.stringify(body) : undefined),
    signal: AbortSignal.timeout(timeout),
  }).catch((e) => {
    throw new Error(`Can't reach ${name}: ${e.cause?.message || e.message}`);
  });
  if (!r.ok) throw refusal(name, r.status, await r.text().catch(() => ""));
  if (raw) return Buffer.from(await r.arrayBuffer());
  const text = await r.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${name} answered with something that isn't JSON.`);
  }
}

// A vendor's server-sent events, opened: its answer is in once this returns, so nothing after this moment is missed.
// -> an async iterable of each event's JSON.
export async function openEvents(name, url, { headers = {}, signal } = {}) {
  const r = await fetch(url, { headers: { ...headers, accept: "text/event-stream" }, signal });
  if (!r.ok) throw refusal(name, r.status, await r.text().catch(() => ""));
  return readEvents(r.body, signal);
}
// A connection that died with no goodbye (this machine slept) stays quiet forever, so one quiet this long is given
// up on: whoever reads it opens another and reads what it missed, which costs little if nothing was wrong.
const QUIET_MS = 120e3;
export async function* readEvents(body, signal, quietMs = QUIET_MS) {
  const decoder = new TextDecoder();
  let held = "";
  let data = [];
  const reader = body.getReader();
  const next = () => {
    let timer;
    const quiet = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("Its stream went quiet."), { quiet: true })), quietMs);
    });
    return Promise.race([reader.read(), quiet]).finally(() => clearTimeout(timer));
  };
  try {
    for (;;) {
      const { value, done } = await next();
      if (done || signal?.aborted) return;
      held += decoder.decode(value, { stream: true });
      let at;
      while ((at = held.indexOf("\n")) >= 0) {
        const line = held.slice(0, at).replace(/\r$/, "");
        held = held.slice(at + 1);
        if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        else if (!line && data.length) {
          const text = data.join("\n");
          data = [];
          try {
            yield JSON.parse(text);
          } catch {} // a keep-alive of some kind, not an event
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

// A GitHub repo however it's written, as the post's repo key ("github.com/owner/name") or a URL, an SSH remote or
// "owner/name": -> { key, owner, name, url }, or null for anything else.
export function githubRepo(repo) {
  const m = String(repo || "")
    .trim()
    .replace(/\.git$/, "")
    .replace(/\/+$/, "")
    .match(/^(?:(?:https?:\/\/|ssh:\/\/git@|git@)?(?:www\.)?github\.com[/:])?([\w.-]+)\/([\w.-]+)$/i);
  if (!m) return null;
  const [, owner, name] = m;
  return { key: `github.com/${owner}/${name}`, owner, name, url: `https://github.com/${owner}/${name}` };
}

// A pull request its vendor says it opened (the first link in `text`), on its post now. Said twice, it's the same one.
export function linkPr(host, post, text, at) {
  const pr = prOfUrl(text);
  if (pr) host.commit({ t: "session.pr", post, url: prUrl(pr.repo, pr.number), number: pr.number, repo: pr.repo, how: "opened", at });
}

// A thread's files as bytes, for a vendor that keeps its own copy: those it can read, and the names of those it can't.
export function filesOn(files) {
  const ready = [];
  const missed = [];
  for (const f of files || []) {
    try {
      ready.push({ name: f.name || path.basename(f.path), bytes: fs.readFileSync(f.path) });
    } catch {
      missed.push(f.name || path.basename(String(f.path)));
    }
  }
  return { ready, missed };
}

// Waits between tries at something that keeps failing, growing up to `most`.
export const backoff = (first = 1000, most = 60e3) => {
  let wait = first;
  return {
    next: () => new Promise((r) => {
      const t = setTimeout(r, wait);
      t.unref?.();
      wait = Math.min(wait * 2, most);
    }),
    reset: () => void (wait = first),
  };
};
