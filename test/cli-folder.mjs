#!/usr/bin/env node
// agentbook-cli's files are in cli/ in agentbook's data folder (plugin/cli/cli-folder.mjs): the first agentbook-cli
// to start moves the ones it kept at the top into it, its database whole (with what was only in its log), and never
// one another process still has open. What isn't its own, and what sessions run from, stays. The logs move as what
// writes them is started (openLog).
// Run: node test/cli-folder.mjs

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "../plugin/shared/db.mjs";
import { keepPrivate, moveIntoCli } from "../plugin/cli/cli-folder.mjs";

let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-cli-folder-")));
const at = (...p) => path.join(HOME, ...p);
const write = (p, text) => {
  fs.mkdirSync(path.dirname(at(p)), { recursive: true });
  fs.writeFileSync(at(p), text);
};

// ---------- the folder, as agentbook-cli left it before ----------
write("files/f1-report.txt", "the report");
write("openclaw.json", "{}");
write("groups/ship/plan.md", "# Plan");
write("routine-code/numbers/abc.mjs", "export default 1");
write("steer/123", "");
write("cli/device.json", "{}");
// Not its own, or in use by what runs from it: they stay.
write("connectors.json", "{}");
write("hub.json", "{}");
write("plugin-copies/abc/hooks/hook.mjs", "");
write("pages/status/notes.md", "");
// Its database, with a row that's only in its log: the process that wrote it was killed.
const db = at("agentbook.db");
{
  const d = new DatabaseSync(db);
  d.exec("pragma journal_mode = wal; create table t (v text); insert into t values ('checkpointed'); pragma wal_checkpoint(TRUNCATE)");
  d.close();
}
// Another process with it open, as an agentbook-cli still running on it would; `sql` it runs first.
const holding = async (sql = "select 1") => {
  const p = spawn(process.execPath, ["-e", `const { DatabaseSync } = require("node:sqlite"); const d = new DatabaseSync(${JSON.stringify(db)}); d.exec(${JSON.stringify(`pragma wal_autocheckpoint = 0; ${sql}`)}); console.log("open"); setInterval(() => {}, 1000);`], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise((r) => p.stdout.once("data", r));
  return { kill: () => (p.kill("SIGKILL"), new Promise((r) => p.once("exit", r))) };
};
const holder = await holding();

const said = [];
const log = (line) => said.push(line);
let error = null;
try {
  moveIntoCli({ home: HOME, log });
} catch (e) {
  error = e;
}
check(/open in another process/.test(error?.message) && fs.existsSync(db) && !fs.existsSync(at("cli", "agentbook.db")) && fs.existsSync(at("files")), "a database another process has open isn't moved, nor anything after it, and agentbook-cli doesn't start");

await holder.kill();
await (await holding("insert into t values ('only in its log')")).kill();
check(fs.existsSync(`${db}-wal`) && fs.statSync(`${db}-wal`).size > 0, "(the process that had it open is killed, its last write only in the log)");

const moved = moveIntoCli({ home: HOME, log });
check(["agentbook.db", "files", "openclaw.json", "groups", "routine-code", "steer"].every((n) => moved.includes(n) && fs.existsSync(at("cli", n)) && !fs.existsSync(at(n))), `once it isn't, all of its own goes into cli/ (${moved.join(", ")})`);
const rows = (() => {
  const d = new DatabaseSync(at("cli", "agentbook.db"), { readOnly: true });
  const r = d.prepare("select v from t order by rowid").all().map((x) => x.v);
  d.close();
  return r;
})();
check(rows.join() === "checkpointed,only in its log" && !fs.existsSync(`${db}-wal`) && !fs.existsSync(`${db}-shm`), "the database goes whole, with what was only in its log, leaving no log behind");
check(fs.readFileSync(at("cli", "files", "f1-report.txt"), "utf8") === "the report" && fs.readFileSync(at("cli", "groups", "ship", "plan.md"), "utf8") === "# Plan" && fs.existsSync(at("cli", "device.json")), "with what's in its folders, beside what was in cli/ already");
check(["connectors.json", "hub.json", "plugin-copies/abc/hooks/hook.mjs", "pages/status/notes.md"].every((p) => fs.existsSync(at(p))), "what isn't its own stays, and so do the plugin copies and page folders sessions run in");
check(said.some((l) => /^moved agentbook\.db, files/.test(l)), "and it says what it moved");

check(moveIntoCli({ home: HOME, log }).length === 0, "starting again moves nothing");

// An older agentbook-cli that made a database at the top again: it's left there, and said, not put over the one in cli/.
write("agentbook.db", "");
write("openclaw.json", "{}");
said.length = 0;
check(moveIntoCli({ home: HOME, log }).length === 0 && fs.existsSync(db) && fs.statSync(at("cli", "agentbook.db")).size > 0 && said.some((l) => /left .*agentbook\.db where it is/.test(l)) && said.some((l) => /left .*openclaw\.json where it is/.test(l)), "one made at the top again stays where it is, beside the one in cli/, and that's said");
fs.rmSync(db);
fs.rmSync(at("openclaw.json"));

// Files kept elsewhere (AGENTBOOK_FILES) were elsewhere before too: a files/ at the top isn't the CLI's then.
write("files/other.txt", "not agentbook-cli's");
check(!moveIntoCli({ home: HOME, filesDir: at("elsewhere"), log }).includes("files") && fs.existsSync(at("files", "other.txt")), "with its files kept elsewhere, a files/ at the top isn't moved");
fs.rmSync(at("files"), { recursive: true });

// ---------- the logs ----------
process.env.AGENTBOOK_HOME = HOME;
process.env.AGENTBOOK_SERVER_HOME = at("server");
const { CLI_LOG, SERVER_LOG, openLog } = await import("../plugin/lib/common.mjs");
write("server.log", "the server, before\n");
fs.closeSync(openLog(SERVER_LOG()));
check(SERVER_LOG() === at("server", "server.log") && fs.readFileSync(SERVER_LOG(), "utf8") === "the server, before\n" && !fs.existsSync(at("server.log")), "agentbook-server's log moves into its folder when it's started");
write("cli/cli.log", "the CLI, later\n");
write("cli.log", "the CLI, before\n");
const fd = openLog(CLI_LOG);
fs.writeSync(fd, "the CLI, now\n");
fs.closeSync(fd);
check(CLI_LOG === at("cli", "cli.log") && fs.readFileSync(CLI_LOG, "utf8") === "the CLI, before\nthe CLI, later\nthe CLI, now\n" && !fs.existsSync(at("cli.log")), "and agentbook-cli's into its own: one at the top that was written again goes first, in order");

// ---------- only its person reads it ----------
{
  const mode = (p) => fs.statSync(p).mode & 0o777;
  const elsewhere = at("big-disk", "files");
  fs.mkdirSync(elsewhere, { recursive: true });
  for (const p of [HOME, at("cli"), elsewhere]) fs.chmodSync(p, 0o755);
  for (const n of ["agentbook.db", "cli.log"]) fs.chmodSync(at("cli", n), 0o644);
  const changed = keepPrivate({ home: HOME, filesDir: elsewhere });
  check(mode(HOME) === 0o700 && mode(at("cli")) === 0o700 && mode(elsewhere) === 0o700, "agentbook's folder, agentbook-cli's and its files' (wherever they're kept) are its person's only (0700)");
  check(mode(at("cli", "agentbook.db")) === 0o600 && mode(at("cli", "cli.log")) === 0o600, "and its database and log too (0600)");
  check(changed.includes(HOME) && changed.includes(at("cli", "agentbook.db")) && keepPrivate({ home: HOME, filesDir: elsewhere }).length === 0, "it says what it changed, and leaves what's already private as it is");
  const log = at("cli", "new.log");
  fs.closeSync(openLog(log));
  check(mode(log) === 0o600, "a log started now is its person's only");
  fs.writeFileSync(at("old.log"), "x", { mode: 0o644 });
  fs.closeSync(openLog(at("old.log")));
  check(mode(at("old.log")) === 0o600, "and one from before, once it's opened again");
}

fs.rmSync(HOME, { recursive: true, force: true });
if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log("\nall passed");
