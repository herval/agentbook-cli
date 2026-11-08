#!/usr/bin/env node
// Every test here, as `npm test` runs them: AGENTBOOK_TEST_JOBS at a time (one unless told otherwise; CI runs four, the
// most there are ports for: see testPort in harness-ports.mjs), each one's output whole as it ends. They start real
// servers and work to real clocks, so one that fails gets one more try, alone: if that passes it's flaky, which is
// named at the end and doesn't fail the run. One still going after LIMIT_MS is stopped, and counts as failed.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const JOBS = Math.min(4, Math.max(1, Number(process.env.AGENTBOOK_TEST_JOBS) || 1));
const LIMIT_MS = 5 * 60e3;
const tests = fs.readdirSync(here).filter((f) => f.endsWith(".mjs") && !/^(all\.mjs|demo\.mjs|fake-|harness)/.test(f)).sort();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentbook-tests-"));

// To a file, not a pipe: a test's servers can outlive it, and would hold a pipe open.
function run(test, slot = 0) {
  const log = path.join(tmp, `${test}.log`);
  const out = fs.openSync(log, "w");
  const began = Date.now();
  const child = spawn(process.execPath, [`test/${test}`], { cwd: path.dirname(here), stdio: ["ignore", out, out], env: { ...process.env, AGENTBOOK_TEST_SLOT: String(slot) } });
  const limit = setTimeout(() => {
    fs.writeSync(out, `\nStopped after ${LIMIT_MS / 1000}s.\n`);
    child.kill("SIGKILL");
  }, LIMIT_MS);
  return new Promise((resolve) => {
    child.on("exit", (code) => {
      clearTimeout(limit);
      fs.closeSync(out);
      console.log(`== test/${test} (${Math.round((Date.now() - began) / 1000)}s)`);
      process.stdout.write(fs.readFileSync(log));
      resolve(code === 0);
    });
  });
}

const firstTry = [];
const waiting = [...tests];
await Promise.all(Array.from({ length: JOBS }, async (_, slot) => {
  for (let test; (test = waiting.shift()); ) if (!(await run(test, slot))) firstTry.push(test);
}));

const flaky = [];
const failed = [];
for (const test of firstTry.sort()) {
  console.log(`== test/${test} failed: once more, alone`);
  ((await run(test)) ? flaky : failed).push(test);
}
fs.rmSync(tmp, { recursive: true, force: true });

if (flaky.length) console.log(`Flaky, passed the second time: ${flaky.map((t) => `test/${t}`).join(" ")}`);
if (process.env.GITHUB_ACTIONS) for (const t of flaky) console.log(`::warning file=test/${t}::Failed, then passed on its second try`);
if (failed.length) {
  console.log(`Failed: ${failed.map((t) => `test/${t}`).join(" ")}`);
  process.exit(1);
}
console.log(`All ${tests.length} tests passed.`);
process.exit(0);
