// What going away takes. `agentbook-cli uninstall` undoes what it changed outside its folder (commands.mjs), and a
// daemon notices when its plugin's gone, since Claude Code says nothing to a plugin it removes: without this, an
// agentbook-cli stays up, connected, after `claude plugin uninstall`.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PLUGIN_ROOT, PORT } from "../lib/common.mjs";

const PLUGIN = "agentbook@agentbook";
const pluginsDir = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), "plugins");
const realOr = (p) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

export const codexConfig = () => path.join(process.env.AGENTBOOK_CODEX_HOME || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");

// Take agentbook's entry out of Codex's config.toml, its subtables too, and nothing else: an entry of another
// agentbook (another port) stays. Whether it took one out.
export function removeCodexEntry(file = codexConfig(), port = PORT) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return false;
  }
  const lines = text.split("\n");
  const header = (l) => /^\s*\[{1,2}[^\]]+\]{1,2}\s*(#.*)?$/.test(l);
  const ours = (l) => /^\s*\[\s*mcp_servers\.("agentbook"|'agentbook'|agentbook)(\.[^\]]+)?\s*\]\s*(#.*)?$/.test(l);
  const keep = [];
  let found = false;
  let i = 0;
  while (i < lines.length) {
    if (!ours(lines[i])) {
      keep.push(lines[i++]);
      continue;
    }
    let end = i + 1;
    while (end < lines.length && !header(lines[end])) end++;
    const section = lines.slice(i, end).join("\n");
    if (!new RegExp(`(127\\.0\\.0\\.1|localhost):${port}/api/mcp`).test(section) && !/^\s*\[\s*mcp_servers\.[^.]+\.[^\]]+\]/.test(lines[i])) return false;
    found = true;
    i = end;
  }
  if (!found) return false;
  const tmp = `${file}.agentbook-${process.pid}`;
  fs.writeFileSync(tmp, keep.join("\n"), { mode: fs.statSync(file).mode & 0o777 });
  fs.renameSync(tmp, file);
  return true;
}

// Whether this agentbook-cli runs from a plugin Claude Code installed (not a clone, or a folder someone develops in).
export function installedByClaude(root = PLUGIN_ROOT) {
  return (realOr(root) + path.sep).startsWith(realOr(pluginsDir()) + path.sep);
}

// Whether Claude Code says the plugin's gone. A file it's in the middle of writing, or no file, says nothing.
export function pluginGone(file = path.join(pluginsDir(), "installed_plugins.json")) {
  try {
    const { plugins } = JSON.parse(fs.readFileSync(file, "utf8"));
    return !!plugins && !plugins[PLUGIN]?.length;
  } catch {
    return false;
  }
}

// Call `onGone` once the plugin this agentbook-cli runs from is uninstalled: at once, if it already was. An update
// leaves it listed, under its new version. Claude Code replaces the file, so it's the folder that's watched.
export function watchInstall({ onGone, root = PLUGIN_ROOT, log = () => {} }) {
  if (!installedByClaude(root)) return () => {};
  if (pluginGone()) {
    onGone();
    return () => {};
  }
  let timer = null;
  let watcher;
  try {
    watcher = fs.watch(pluginsDir(), (kind, name) => {
      if (name && name !== "installed_plugins.json") return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!pluginGone()) return;
        watcher.close();
        onGone();
      }, 500);
      timer.unref?.();
    });
    watcher.unref?.();
  } catch (e) {
    log(`agentbook-cli can't watch for its plugin being uninstalled: ${e.message}`);
    return () => {};
  }
  return () => watcher.close();
}
