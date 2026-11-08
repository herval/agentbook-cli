// In dev mode (AGENTBOOK_PLUGIN_DIR), sessions run on a copy of the plugin, not on its folder. A session
// working on agentbook edits that folder, and if it ran on it, it would be editing its own hooks, the
// PermissionRequest one that answers its permission prompts included. Auto mode's classifier won't judge
// those edits (it skips every one), so the session couldn't change agentbook at all.
//
// Each version of the folder gets its own copy, in ~/.agentbook/cli/plugin-copies/<hash>, made when a session
// starts or wakes on it. So edits reach the sessions started or woken after them, as an update of an
// installed plugin would. A copy no session started or woke on for a week goes, and so do the ones made at the
// top of ~/.agentbook until 2026-10-17 (sessions started then load theirs from there), then their folder.
// Run: node plugin-copy.mjs [folder]   prints the copy of the folder as it is now (bin/agentbook-cli dev).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HOME } from "../lib/common.mjs";

export const COPIES = path.join(HOME, "cli", "plugin-copies");
const OLD_COPIES = path.join(HOME, "plugin-copies");
const KEEP_MS = 7 * 86400e3;

// The folder's files, in order, leaving out Finder's.
function files(dir, rel = "") {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name === ".DS_Store") continue;
    const r = path.join(rel, e.name);
    if (e.isDirectory()) out.push(...files(dir, r));
    else if (e.isFile()) out.push(r);
  }
  return out;
}

// The copy of `dir` as it is now (made if there's none yet), or null when sessions use the installed plugin.
export function pluginCopy(dir = process.env.AGENTBOOK_PLUGIN_DIR) {
  if (!dir) return null;
  const hash = crypto.createHash("sha1");
  for (const f of files(dir)) hash.update(f).update("\0").update(fs.readFileSync(path.join(dir, f))).update("\0");
  const to = path.join(COPIES, hash.digest("hex").slice(0, 12));
  if (!fs.existsSync(to)) {
    const tmp = `${to}.${process.pid}.tmp`;
    fs.cpSync(dir, tmp, { recursive: true });
    try {
      fs.renameSync(tmp, to);
    } catch {
      fs.rmSync(tmp, { recursive: true, force: true }); // another start made it first
    }
  }
  const now = new Date();
  fs.utimesSync(to, now, now);
  for (const dir of [COPIES, OLD_COPIES]) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {}
    for (const name of names) {
      const p = path.join(dir, name);
      try {
        if (p !== to && fs.statSync(p).mtimeMs < now - KEEP_MS) fs.rmSync(p, { recursive: true, force: true });
      } catch {}
    }
  }
  try {
    fs.rmdirSync(OLD_COPIES); // once it's empty
  } catch {}
  return to;
}

// Whether a session's --plugin-dir is agentbook's plugin folder, or a copy of it.
export const isPluginDir = (p) => !!process.env.AGENTBOOK_PLUGIN_DIR && (path.resolve(p) === path.resolve(process.env.AGENTBOOK_PLUGIN_DIR) || [COPIES, OLD_COPIES].some((d) => path.resolve(p).startsWith(d + path.sep)));

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  console.log(pluginCopy(path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), ".."))));
}
