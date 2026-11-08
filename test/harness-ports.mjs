// Ports for tests, apart from the rest of harness.mjs, which starts a server: tests that need none, and ship in
// agentbook-cli's own repo, take their ports from here. harness.mjs passes these on, so every test can keep
// importing them from there.

import net from "node:net";

// Which of the tests running at once this is (test/all.mjs says). Each has ports of its own: the bands below run from
// 4400 to about 6600, so 2200 apart, and they stay apart at the 10000 and 20000 above them that the harness takes. Tests
// share bands, so without this two running together can land on one port. That's four at a time at most (test/all.mjs).
const SHIFT = 2200 * (Number(process.env.AGENTBOOK_TEST_SLOT) || 0);
// Ports fetch and WebSocket refuse ("bad port"), that a band or a shift can land on. Tests add up to 400 to theirs.
const BAD = new Set([5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);
const usable = (p) => ![0, 1, 2, 50, 100, 101, 200, 300, 400, 10000, 20000].some((d) => BAD.has(p + d));

// A port in a test's band, for a test that takes what it gets.
export function testPort(from, span = 90) {
  for (;;) {
    const p = from + SHIFT + Math.floor(Math.random() * span);
    if (usable(p)) return p;
  }
}

// A port in a test's band that's free, with the two above it the harness takes. Something else can hold any of them
// (a demo, a trial, this test in another worktree), and a test that lands on one talks to that: it answers /api/health
// and the setup, and the test's hooks reach its own.
export async function freePort(from, span = 90) {
  const free = (p) =>
    new Promise((resolve) => {
      const s = net.createServer().once("error", () => resolve(false)).once("listening", () => s.close(() => resolve(true)));
      s.listen(p, "127.0.0.1");
    });
  const start = Math.floor(Math.random() * span);
  for (let i = 0; i < span; i++) {
    const p = from + SHIFT + ((start + i) % span);
    if (usable(p) && (await free(p)) && (await free(p + 10000)) && (await free(p + 20000))) return p;
  }
  throw new Error(`no free port in ${from}+${span}`);
}
