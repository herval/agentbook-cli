#!/usr/bin/env node
// agentbook-cli doesn't keep its threads' files for good (plugin/cli/file-keep.mjs): one a month old goes from the
// machine once its server has it, and one its server doesn't have goes up first.
// Run: node test/file-keep.mjs

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStore } from "../plugin/shared/store.mjs";
import { createFileKeep, UPLOAD_MAX } from "../plugin/cli/file-keep.mjs";

let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-file-keep-"));
const FILES = path.join(HOME, "cli", "files");
const store = createStore({ file: path.join(HOME, "cli", "agentbook.db"), filesDir: FILES, legacy: false, acks: true });
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const up = new Map(); // sha -> bytes, as the server keeps them
let reachable = true;
const blobPut = async (buf) => {
  if (!reachable) return null;
  up.set(sha(buf), buf);
  return sha(buf);
};
const keep = createFileKeep({ store, filesDir: FILES, blobPut });
const DAY = 86400e3;
// A file of a thread's, `days` old: an agent's that went up as it was made (`blob`), or one that didn't.
const file = (name, { days, blob = false, bytes = Buffer.from(`${name} `.repeat(50)), fid = null } = {}) => {
  const stored = `${name}-stored`;
  fs.writeFileSync(path.join(FILES, stored), bytes);
  const op = store.commit({ t: "file.add", post: "s1", from: fid ? "human" : "agent", name, size: bytes.length, stored, ...(fid ? { fid } : {}), ...(blob ? { blob: sha(bytes) } : {}) });
  const id = fid || `f${op.seq}`;
  const f = store.state.files.find((x) => x.id === id);
  f.at = new Date(Date.now() - days * DAY).toISOString();
  return { id, p: path.join(FILES, stored), f };
};
const here = (x) => fs.existsSync(x.p);

try {
  store.commit({ t: "session.hello", proc: "p1", session_id: "s1", agent: "claude", label: "wren", kind: "claude-code" });
  const old = file("old-sent", { days: 40, blob: true });
  const fresh = file("fresh-sent", { days: 10, blob: true });
  const notUp = file("old-not-sent", { days: 35 });
  const human = file("their-upload", { days: 45, blob: true, fid: "u_abc123" });
  const big = file("big-video", { days: 50, bytes: Buffer.alloc(0) });
  fs.truncateSync(big.p, UPLOAD_MAX + 1);

  check((await keep.sweep()).kept === 0 && here(old) && up.size === 0, "before a server has this machine, nothing goes, and nothing goes up");

  store.setAcked(store.state.seq);
  const first = await keep.sweep();
  check(!here(old) && !here(human), "a month-old file its server has goes from the machine, an agent's and one someone sent");
  check(!!store.state.files.find((x) => x.id === old.id), "while the thread keeps its record of it (the page opens it from the server)");
  check(here(fresh), "a newer one stays");
  check(here(notUp) && up.has(sha(fs.readFileSync(notUp.p))) && store.state.files.find((x) => x.id === notUp.id)?.blob === sha(fs.readFileSync(notUp.p)), "one its server doesn't have goes up first, and stays until the server has said so");
  check(here(big) && first.sent === 1, "one over what the server takes at once stays here");
  check(first.kept === 2 && first.freed > 0, `it says what went (${JSON.stringify(first)})`);

  await keep.sweep();
  check(here(notUp), "until its file.blob op is acknowledged, it stays");
  store.setAcked(store.state.seq);
  await keep.sweep();
  check(!here(notUp), "then it goes too");

  reachable = false;
  const offline = file("while-offline", { days: 31 });
  store.setAcked(store.state.seq);
  const r = await keep.sweep();
  check(here(offline) && r.sent === 0 && !store.state.files.find((x) => x.id === offline.id)?.blob, "a server out of reach takes nothing, and the file stays");
} catch (e) {
  check(false, `crashed: ${e.stack}`);
} finally {
  store.close();
  fs.rmSync(HOME, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
