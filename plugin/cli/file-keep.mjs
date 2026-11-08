// How much of its threads' files agentbook-cli keeps (cli/files/: what people sent, what agents made, what OpenClaw
// sent). Its server keeps them too, so they open while the machine is off. Once a file is a month old
// (AGENTBOOK_FILE_DAYS) and its server has it, the copy here goes. One its server doesn't have yet goes up first, and
// its copy here goes on a later sweep, once the server has said so. One over what the server takes at once (60 MB)
// stays here.
//
// "Its server has it": the file has a blob (its bytes there, by sha256), and the op that said so has been
// acknowledged. A file its agent wrote about by its path still names that path in its conversation: after a month,
// that path may be gone, while the page still opens the file from the server.

import fs from "node:fs";
import path from "node:path";

export const FILE_DAYS = Math.max(1, Number(process.env.AGENTBOOK_FILE_DAYS) || 30);
// What agentbook-server takes at once (server/main.mjs, BLOB_MAX), and what one sweep sends up at most.
export const UPLOAD_MAX = 60 * 1024 * 1024;
const SWEEP_BYTES = 256 * 1024 * 1024;

// `blobPut(buf, type)`: its bytes onto the server, -> their sha256, or null when it can't be reached.
export function createFileKeep({ store, filesDir, blobPut = null, log = () => {}, days = FILE_DAYS }) {
  // An op about a file its server hasn't acknowledged yet: the one that made it (`f<seq>`, or one with its id) or
  // the one that said the server has its bytes. One the log no longer keeps was acknowledged before it went.
  const unacked = store.db.prepare(`select 1 from events where seq > ? and (
    (json_extract(op, '$.t') = 'file.blob' and json_extract(op, '$.fid') = ?)
    or (json_extract(op, '$.t') = 'file.add' and (json_extract(op, '$.fid') = ? or 'f' || seq = ?))) limit 1`);
  let running = null;

  // -> { kept, freed (bytes), sent }.
  async function sweep() {
    const out = { kept: 0, freed: 0, sent: 0 };
    const acked = store.acked?.() || 0;
    if (!acked) return out; // no server has this machine yet
    const before = Date.now() - days * 86400e3;
    let up = 0;
    for (const f of store.whole("files")) {
      if (!f?.stored || f.pending || !(Date.parse(f.at || "") < before)) continue;
      const p = path.join(filesDir, f.stored);
      let size;
      try {
        size = fs.statSync(p).size;
      } catch {
        continue; // not here (gone already, or never fetched from where its driver keeps it)
      }
      if (f.blob) {
        if (unacked.get(acked, f.id, f.id, f.id)) continue;
        fs.rmSync(p, { force: true });
        out.kept++;
        out.freed += size;
        continue;
      }
      if (!blobPut || size > UPLOAD_MAX || up + size > SWEEP_BYTES) continue;
      const sha = await blobPut(fs.readFileSync(p), f.type || null);
      if (!sha) break; // the server's out of reach: next time
      store.commit({ t: "file.blob", fid: f.id, blob: sha, size });
      out.sent++;
      up += size;
    }
    if (out.kept || out.sent) log(`files older than ${days} days: ${out.kept ? `${out.kept} its server has went from here (${Math.round(out.freed / 1048576)} MB)` : ""}${out.kept && out.sent ? "; " : ""}${out.sent ? `${out.sent} went up to it first (${Math.round(up / 1048576)} MB)` : ""}`);
    return out;
  }

  return {
    // One at a time: a sweep asked for while one runs is that one.
    sweep: () => (running ||= sweep().finally(() => (running = null))),
  };
}
