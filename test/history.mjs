#!/usr/bin/env node
// A thread's history outlives memory's limit: an old thread's messages, answered questions and files stay in the
// database however much happens in other threads, its page has all of them, a restart (or a kill between
// checkpoints) brings them back, and changing a thread whose history is out of memory changes all of it.
// Run: node test/history.mjs

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "../plugin/shared/db.mjs";
import { conversationOf, createStore, fileOf, outOfMemory, publicState, sessionDetail } from "../plugin/shared/store.mjs";

const HOME = process.argv[3] || fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-history-"));
const FILE = path.join(HOME, "agentbook.db");
const FILES = path.join(HOME, "files");
const open = () => createStore({ file: FILE, filesDir: FILES, legacy: false });

let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};
const rows = (sql, ...args) => {
  const db = new DatabaseSync(FILE, { readOnly: true });
  try {
    return db.prepare(sql).all(...args);
  } finally {
    db.close();
  }
};
const ago = (ms) => new Date(Date.now() - ms).toISOString();
const DAY = 86400e3;

// What a kill between checkpoints leaves: ops logged, no checkpoint after them.
if (process.argv[2] === "--then-die") {
  const store = open();
  store.ingest({ t: "message.add", post: "busy", from: "human", via: "dash", text: "said before the kill", at: ago(1000) });
  process.kill(process.pid, "SIGKILL");
  await new Promise(() => {});
}

// ---------- an old thread, then a lot elsewhere ----------
let store = open();
const hello = (id, at) => store.ingest({ t: "session.hello", proc: `box-${id}`, session_id: id, agent: "claude", agent_name: "Claude", kind: "claude-code", label: id, named: true, cwd: HOME, at });
hello("old", ago(3 * DAY));
for (let i = 0; i < 5; i++) store.ingest({ t: "message.add", post: "old", from: i % 2 ? "agent" : "human", via: "dash", text: `old message ${i}`, at: ago(3 * DAY - i * 1000) });
store.ingest({ t: "question.ask", post: "old", qid: "q-old", kind: "choice", title: "Which way?", options: ["Left", "Right"], at: ago(3 * DAY - 6000) });
store.ingest({ t: "question.answer", qid: "q-old", value: "Left", by: "human", at: ago(3 * DAY - 7000) });
store.ingest({ t: "file.add", post: "old", fid: "f-old", from: "agent", name: "notes.md", size: 5, stored: "notes.md", at: ago(3 * DAY - 8000) });

// Busy elsewhere: more messages, answered questions and files than memory held before (8,000, 400, 2,000).
const t0 = Date.now();
hello("busy", ago(DAY));
for (let i = 0; i < 8100; i++) store.ingest({ t: "message.add", post: "busy", from: i % 2 ? "agent" : "human", via: "dash", text: `busy ${i}`, at: ago(DAY - i) });
for (let i = 0; i < 450; i++) {
  store.ingest({ t: "question.ask", post: "busy", qid: `q${i}`, title: `Question ${i}`, at: ago(DAY - 9000 - i) });
  store.ingest({ t: "question.answer", qid: `q${i}`, value: "yes", by: "human", at: ago(DAY - 9000 - i) });
}
for (let i = 0; i < 2050; i++) store.ingest({ t: "file.add", post: "busy", fid: `fb${i}`, from: "agent", name: `b${i}.txt`, size: 1, stored: `b${i}.txt`, at: ago(DAY - 10000 - i) });
// Today: a thread used now, which stays in memory whatever.
hello("now", new Date().toISOString());
store.ingest({ t: "message.add", post: "now", from: "human", via: "dash", text: "hi", at: new Date().toISOString() });
console.log(`(${Date.now() - t0} ms to log ${store.state.seq} ops)`);
store.checkpoint(true);

check(rows("select count(*) n from messages where post = 'old'")[0].n === 5, "the old thread's 5 messages are still in the database after a checkpoint");
check(rows("select count(*) n from questions where post = 'old'")[0].n === 1, "its answered question too");
check(rows("select count(*) n from files where post = 'old'")[0].n === 1, "and its file");
check(rows("select count(*) n from messages where post = 'busy'")[0].n === 8100, "the busy thread's 8,100 messages are all in the database");
check(rows("select count(*) n from questions")[0].n === 451 && rows("select count(*) n from files")[0].n === 2051, "every answered question and every file is in the database");
check(store.state.messages.length <= 8000 + 1, `memory holds no more than the limit (${store.state.messages.length})`);
check(store.state.cold.has("old") && store.state.cold.has("busy") && !store.state.cold.has("now"), "the old and busy threads are out of memory, today's isn't");

const card = publicState(store.state).sessions.find((s) => s.id === "old");
check(card.messages === 5 && card.last_messages.map((m) => m.text).join("|") === "old message 2|old message 3|old message 4", "its card still says 5 messages and shows the last 3");
check(card.files === 1 && card.last_files[0]?.name === "notes.md", "and its file");
check(outOfMemory(store.state, "messages", new Set(["old"])).length === 5, "what's out of memory can be read from the database");

const page = sessionDetail(store.state, "old");
check(page.messages.map((m) => m.text).join("|") === [0, 1, 2, 3, 4].map((i) => `old message ${i}`).join("|"), "its page has its whole conversation, in order");
check(page.questions.length === 1 && page.questions[0].value === "Left", "its answered question");
check(page.files.length === 1 && page.files[0].id === "f-old", "and its file");
check(!store.state.cold.has("old"), "reading it brought it back into memory");
check(conversationOf(store.state, "busy").length === 8100, "the busy thread's conversation comes back whole too");
check(fileOf(store.state, "fb0")?.name === "b0.txt", "a file is found by its id");

// ---------- a restart ----------
store.close();
store = open();
check(store.state.cold.has("old") && fileOf(store.state, "f-old")?.name === "notes.md" && !store.state.cold.has("old"), "after a restart, a file of a thread out of memory is found by its id, and brings its thread back");
check(sessionDetail(store.state, "old").messages.length === 5, "and the old thread's page has its 5 messages");
check(sessionDetail(store.state, "busy").questions.length === 450 && sessionDetail(store.state, "busy").files.length === 2050, "and the busy one all its questions and files");
check(store.whole("messages").length === 8100 + 5 + 1, "the whole store has every message, for a server that has none");

// ---------- changing a thread whose history is out of memory ----------
store.checkpoint(true);
check(store.state.cold.has("old") === false, "a thread read in the last hour stays in memory");
store.close();
store = open(); // memory over the limit at start: the threads used least lately go back to the database
check(store.state.cold.has("old"), "after a restart the old thread is out of memory again");
store.commit({ t: "message.add", post: "old", from: "human", via: "dash", text: "back again" });
check(!store.state.cold.has("old"), "a message on it brings its history back");
check(conversationOf(store.state, "old").map((m) => m.text).join("|") === [...[0, 1, 2, 3, 4].map((i) => `old message ${i}`), "back again"].join("|"), "the new message comes after the old ones");
store.checkpoint(true);
check(rows("select count(*) n from messages where post = 'old'")[0].n === 6, "the database has all 6");
store.close();

store = open();
check(store.state.cold.has("busy"), "the busy thread is out of memory");
const drop = rows("select id from messages where post = 'busy' order by ord limit 2").map((r) => r.id);
store.commit({ t: "message.drop", post: "busy", mids: drop });
store.checkpoint(true);
check(rows("select count(*) n from messages where post = 'busy'")[0].n === 8098, "dropping messages of a thread out of memory deletes their rows, and only theirs");
store.close();

// ---------- a kill between checkpoints ----------
store = open();
const cold = store.state.cold.has("busy");
store.close();
const died = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--then-die", HOME], { env: { ...process.env, AGENTBOOK_CHECKPOINT_MS: "600000" } });
check(died.signal === "SIGKILL", "a store killed between checkpoints");
store = open();
check(cold && conversationOf(store.state, "busy").length === 8099 && conversationOf(store.state, "busy").map((m) => m.text).slice(-2).join("|") === "busy 8099|said before the kill","what it was told about a thread out of memory is there after it starts again");
store.close();

fs.rmSync(HOME, { recursive: true, force: true });
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
