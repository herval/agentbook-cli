// A machine agentbook-server made logs itself in. The server made its
// login and approved it for its owner, as the page's Approve does, then started the machine with one file,
// ~/.agentbook-enroll: { server, name, poll }. `poll` picks up the machine's token once, within ten minutes of the
// file being written, and is worth nothing after. (`codex_tools`: whether Codex there gets agentbook's tools.) agentbook-cli reads the file as it starts, takes its token (with
// its owner's passkeys, so it takes only what they sign), deletes the file, and goes on logged in, as after
// `agentbook-cli login`. Nobody types a code.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { machineName } from "../shared/ids.mjs";
import { createGate } from "./gate.mjs";
import { pinOf } from "./signatures.mjs";

export const ENROLL_FILE = () => process.env.AGENTBOOK_ENROLL_FILE || path.join(os.homedir(), ".agentbook-enroll");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -> the login it saved ({ server, token, name, user }), or null: no file, one that can't be used (it's deleted,
// and `log` says why), or a server that couldn't be reached for `waitMs` (the file stays, for the next start).
// `linked`: it's logged in already, so a file left here is only removed.
// `plainOk(url)`: whether a server at plain http may get a token (this machine, a tailnet), as for a login.
export async function enroll({ home, linked = false, plainOk = () => false, save, log = () => {}, waitMs = Number(process.env.AGENTBOOK_ENROLL_WAIT_MS || 600e3), everyMs = Number(process.env.AGENTBOOK_ENROLL_EVERY_MS || 3000) } = {}) {
  const file = ENROLL_FILE();
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const drop = (why) => {
    fs.rmSync(file, { force: true });
    if (why) log(`${file}: ${why}`);
    return null;
  };
  if (linked) return drop("this machine is logged in already, so it's removed unused");
  let e = null;
  try {
    e = JSON.parse(raw);
  } catch {}
  let url = null;
  try {
    url = new URL(String(e?.server || ""));
  } catch {}
  if (!url || typeof e.poll !== "string" || !e.poll) return drop("it isn't a login agentbook-server wrote, so it's removed");
  // The same rule as a login: a token crosses the network over HTTPS only, or on this machine or a tailnet.
  if (url.protocol !== "https:" && !(url.protocol === "http:" && plainOk(url))) return drop(`${url.origin} isn't HTTPS, so this machine doesn't log in to it`);
  const server = url.origin + url.pathname.replace(/\/$/, "");
  const end = Date.now() + waitMs;
  for (let said = false; ; ) {
    const r = await fetch(`${server}/api/devices/poll?poll=${encodeURIComponent(e.poll)}`, { signal: AbortSignal.timeout(15000) }).catch(() => null);
    const body = r ? await r.json().catch(() => ({})) : {};
    if (r?.status === 404) return drop(`${server} doesn't know this login any more (it lasts ten minutes, and works once). Make the machine again, or log it in with agentbook-cli login`);
    if (body.token) {
      const name = machineName(body.name || e.name || os.hostname().split(".")[0]);
      const gate = createGate({ home });
      // What a person says at a login, said for a machine that has no past and nobody at a terminal: only what
      // happens from now on goes up, and Codex's settings stay as they are.
      // (`codex_tools`: its owner picked Codex for it, so Codex there gets agentbook's tools.)
      gate.agree({ history_from: new Date().toISOString(), codex_tools: e.codex_tools === true });
      save({ server, token: body.token, name, user: body.user });
      if (body.pin) gate.importKeys(pinOf(body.pin));
      fs.rmSync(file, { force: true });
      log(`logged in to ${server} as ${name}, @${body.user}'s, from ${file}${body.pin ? ": it takes what can run something only when one of their passkeys signs it" : ""}`);
      return { server, token: body.token, name, user: body.user };
    }
    if (Date.now() > end) {
      log(`${file}: couldn't reach ${server} to log in. It's tried again when agentbook-cli next starts`);
      return null;
    }
    if (!said) log(`${file}: logging in to ${server}…`);
    said = true;
    await sleep(everyMs);
  }
}
