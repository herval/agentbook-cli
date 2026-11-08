// Where Claude Code keeps its login on this machine, and when that last changed: `claude /login` writes it, and so
// does a session refreshing its token. agentbook picks up the threads an expired login cut off once it changes.
//
// On macOS the login is an item in the login keychain, "Claude Code-credentials" (with "-" and the first 8 hex
// digits of the sha256 of Claude Code's folder after it when CLAUDE_CONFIG_DIR is set), whose dates `security`
// reads without the secret. Elsewhere, or when the keychain has no such item, it's .credentials.json in Claude
// Code's folder.

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const configDir = () => (process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude")).normalize("NFC");
const keychainItem = () => `Claude Code-credentials${process.env.CLAUDE_CONFIG_DIR ? `-${crypto.createHash("sha256").update(configDir()).digest("hex").slice(0, 8)}` : ""}`;
const keychains = () => path.join(os.homedir(), "Library", "Keychains");

// The keychain item's modification date ("mdat"<timedate>=0x… "20261020165938Z\000"), in ms, or null.
function keychainChangedAt() {
  if (process.platform !== "darwin") return Promise.resolve(null);
  return new Promise((resolve) =>
    execFile("security", ["find-generic-password", "-s", keychainItem()], { timeout: 5000 }, (err, stdout) => {
      const m = !err && /"mdat"<timedate>=\S+\s+"(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z/.exec(stdout);
      resolve(m ? Date.UTC(m[1], m[2] - 1, m[3], m[4], m[5], m[6]) : null);
    }),
  );
}

// When Claude Code's stored login last changed (ms), or null when there's none to see.
export async function loginChangedAt() {
  const at = await keychainChangedAt();
  if (at) return at;
  try {
    return fs.statSync(path.join(configDir(), ".credentials.json")).mtimeMs;
  } catch {
    return null;
  }
}

// Calls `changed()` (a second after the last of a burst) whenever something where the login is kept changes:
// the keychains' folder on macOS, which changes with any keychain item, and Claude Code's folder. close() stops.
export function watchLogin(changed) {
  let timer = null;
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(changed, 1000);
  };
  const watchers = [];
  for (const dir of [...(process.platform === "darwin" ? [keychains()] : []), configDir()]) {
    try {
      watchers.push(fs.watch(dir, { persistent: false }, soon));
    } catch {}
  }
  return {
    close() {
      clearTimeout(timer);
      for (const w of watchers) w.close();
    },
  };
}
