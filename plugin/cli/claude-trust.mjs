// Claude Code won't start a background session (`claude --bg`) in a folder you haven't trusted: it says
// "Workspace not trusted. Run `claude` in <folder> once and accept the trust prompt", and has no command that
// trusts one. Accepting the prompt sets projects["<folder>"].hasTrustDialogAccepted in ~/.claude.json, which
// Claude Code's own messages name as the other way to do it, so agentbook sets that for the folders you ask it to.
//
// A folder is trusted when it has that entry, or a folder above it does, up to the root of the git repo it's
// in (all the way up when it's in none). So trusting ~/dev covers a plain folder in it, but not a repo.
//
// Claude Code saves the file under a lock (~/.claude.json.lock, a folder: proper-lockfile's), reading it again
// once it holds the lock, so agentbook takes the same lock, changes only that entry and writes the file whole.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STALE_MS = 10e3; // proper-lockfile's: a lock it hasn't refreshed for this long was left behind
const WAIT_MS = 5e3;

// Where Claude Code keeps its settings: ~/.claude.json, in CLAUDE_CONFIG_DIR when that's set, or the old
// ~/.claude/.config.json when that's still there.
export function claudeConfigFile() {
  const dir = process.env.CLAUDE_CONFIG_DIR;
  const legacy = path.join(dir || path.join(os.homedir(), ".claude"), ".config.json");
  return fs.existsSync(legacy) ? legacy : path.join(dir || os.homedir(), ".claude.json");
}

// The path Claude Code keys the folder by: the real one, without a trailing slash.
const keyOf = (dir) => {
  const real = fs.realpathSync(dir).normalize("NFC");
  return real.length > 1 ? real.replace(/\/+$/, "") : real;
};

function read(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw new Error(`agentbook can't read ${file}: ${e.message}`);
  }
}

// Whether Claude Code trusts `dir`: its own entry, or one above it up to its repo's root.
export function isTrusted(dir, file = claudeConfigFile()) {
  const projects = read(file).projects || {};
  let at = keyOf(dir);
  while (true) {
    if (projects[at]?.hasTrustDialogAccepted === true) return true;
    if (fs.existsSync(path.join(at, ".git"))) return false;
    const up = path.dirname(at);
    if (up === at) return false;
    at = up;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function locked(file, fn) {
  const lock = `${file}.lock`;
  const until = Date.now() + WAIT_MS;
  while (true) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs;
      } catch {
        continue; // released between the two calls
      }
      if (age > STALE_MS) {
        fs.rmSync(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > until) throw new Error(`Claude Code kept ${path.basename(file)} locked, so agentbook couldn't trust the folder. Try again.`);
      await sleep(50 + Math.random() * 100);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

// What Claude Code gives a folder it hasn't seen before, trusted.
const FRESH = { allowedTools: [], mcpContextUris: [], mcpServers: {}, enabledMcpjsonServers: [], disabledMcpjsonServers: [], hasTrustDialogAccepted: true, hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: false };

// Trust `dir` in Claude Code, as accepting its trust prompt there does. Resolves whether it wasn't trusted
// before (false: it already was). Never your home folder or one above it: every folder under it that isn't
// a repo would be trusted too, and Claude Code trusts home one session at a time on purpose.
export async function trustFolder(dir, file = claudeConfigFile()) {
  if (!dir || !path.isAbsolute(dir) || !fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`No folder at ${dir}`);
  const key = keyOf(dir);
  const home = keyOf(os.homedir());
  if (key === home || home.startsWith(key === "/" ? key : key + "/")) throw new Error(`agentbook won't trust ${key}: Claude Code would then trust every folder under it that isn't a repo.`);
  if (isTrusted(dir, file)) return false;
  const target = fs.existsSync(file) ? fs.realpathSync(file) : file;
  await locked(file, () => {
    const config = read(target);
    const was = config.projects?.[key];
    if (was?.hasTrustDialogAccepted === true) return;
    config.projects = { ...config.projects, [key]: was ? { ...was, hasTrustDialogAccepted: true } : FRESH };
    const tmp = `${target}.agentbook-${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, target);
  });
  if (!isTrusted(dir, file)) throw new Error(`agentbook wrote ${key}'s trust to ${file}, but it didn't stick. Try again.`);
  return true;
}
