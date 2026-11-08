// What's agentbook-cli's in agentbook's data folder is in its cli/, beside agentbook-server's server/: its
// database, its files, its settings, its log. Until 2026-10-17 most of it was at the top of the folder, among what
// was left there from before the split; the first agentbook-cli to start since moves it into cli/, before it opens
// its database.
//
// Not moved: plugin-copies/, which running sessions load their plugin from (new copies are made in cli/, and the
// old ones go as they age, plugin-copy.mjs), and pages/, the folders page threads work in. The logs move when what
// writes them is started (openLog, lib/common.mjs).

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "../shared/db.mjs";

const MOVED = ["files", "openclaw.json", "groups", "routine-code", "steer", "events.jsonl"];

// -> what it moved, by name. Throws, moving nothing more, when the database is open elsewhere: an agentbook-cli
// still running on it.
export function moveIntoCli({ home, filesDir = path.join(home, "cli", "files"), log = () => {} }) {
  const cli = path.join(home, "cli");
  const moved = [];
  const left = (name, why) => log(`left ${path.join(home, name)} where it is: ${why}`);
  fs.mkdirSync(cli, { recursive: true });
  // The database first, as one file: its log (-wal) written into it and closed. When the log is still there after
  // that, another process has it open.
  const db = path.join(home, "agentbook.db");
  if (fs.existsSync(db)) {
    if (fs.existsSync(path.join(cli, "agentbook.db"))) left("agentbook.db", `agentbook-cli's database is ${path.join(cli, "agentbook.db")} (that one was made after the move, by an older agentbook-cli?)`);
    else {
      const d = new DatabaseSync(db);
      d.exec("pragma wal_checkpoint(TRUNCATE)");
      d.close();
      if (fs.existsSync(`${db}-wal`)) throw new Error(`${db} is open in another process (an agentbook-cli still running?), so it isn't moved into ${cli}. Stop that one, then start agentbook-cli again.`);
      fs.renameSync(db, path.join(cli, "agentbook.db"));
      moved.push("agentbook.db");
    }
  }
  for (const name of MOVED) {
    const from = path.join(home, name);
    const to = name === "files" ? filesDir : path.join(cli, name);
    // Files kept elsewhere (AGENTBOOK_FILES) were elsewhere before too.
    if (!fs.existsSync(from) || (name === "files" && to !== path.join(cli, "files"))) continue;
    if (fs.existsSync(to)) {
      left(name, `${to} is there too`);
      continue;
    }
    try {
      fs.renameSync(from, to);
      moved.push(name);
    } catch (e) {
      // Another agentbook-cli starting at the same moment moved it first.
      if (e.code !== "ENOENT") left(name, e.message);
    }
  }
  if (moved.length) log(`moved ${moved.join(", ")} into ${cli}`);
  return moved;
}

// Only its person reads agentbook's data folder: conversations, files people sent, steps, the device token. Whatever
// umask made them, the folder, agentbook-cli's in it and its files' folder (wherever AGENTBOOK_FILES puts it) are
// 0700, and its database and log 0600, in case they're copied out. Not a umask for the whole process: the sessions,
// terminals and clones it starts keep the person's own. -> what it changed.
export function keepPrivate({ home, filesDir = path.join(home, "cli", "files"), log = () => {} }) {
  const cli = path.join(home, "cli");
  const changed = [];
  const want = [[home, 0o700], [cli, 0o700], [filesDir, 0o700], ...["agentbook.db", "agentbook.db-wal", "agentbook.db-shm", "cli.log"].map((n) => [path.join(cli, n), 0o600])];
  for (const [p, mode] of want) {
    try {
      if ((fs.statSync(p).mode & 0o777) === mode) continue;
      fs.chmodSync(p, mode);
      changed.push(p);
    } catch (e) {
      if (e.code !== "ENOENT") log(`couldn't make ${p} private: ${e.message}`);
    }
  }
  if (changed.length) log(`made ${changed.join(", ")} readable only by ${process.env.USER || "its owner"}`);
  return changed;
}
