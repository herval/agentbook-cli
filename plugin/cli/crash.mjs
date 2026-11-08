// What keeps agentbook-cli up. Nothing restarts it until the next session's hook, and until then the page can't reach
// the machine and its running threads go quiet, so an error in one timer, route or reply stays there: it's logged with
// its stack and the rest goes on. The state it works on is safe through that, as each change is logged before it's
// applied. The exception is what it can't work without: a failed listen ends it, and the next hook starts another.
//
// An error that comes back every tick (a full disk) is logged once, and again only after a quiet hour.

const QUIET_MS = 3600e3;
const fatal = (e) => e?.syscall === "listen";
const diskFull = (e) => e?.code === "ENOSPC" || /disk is full|no space left/i.test(String(e?.message));

// `log(line)`: where it's said (cli.log, as the daemon's stdout). -> { report(error, where), last() }, last being
// { message, count, at } of the latest one, for `status`.
export function stayUp({ log, quietMs = QUIET_MS, exit = (code) => process.exit(code) }) {
  const seen = new Map();
  let last = null;
  const say = (line) => {
    try {
      log(line);
    } catch {} // a log that can't be written is no reason to stop either
  };
  function report(thrown, where) {
    const e = thrown instanceof Error ? thrown : new Error(String(thrown));
    if (fatal(e)) {
      say(`stopping, as it can't go on without this (${where}): ${e.stack}`);
      return exit(1);
    }
    const key = diskFull(e) ? "disk full" : `${e.name} ${String(e.message).replace(/\d+/g, "#")} ${String(e.stack).split("\n")[1] || ""}`;
    const now = Date.now();
    const was = seen.get(key);
    if (seen.size >= 500 && !was) seen.clear();
    seen.set(key, { at: now, count: (was?.count || 0) + 1 });
    last = { message: e.message, count: seen.get(key).count, at: new Date(now).toISOString() };
    if (!was || now - was.at > quietMs) say(`${diskFull(e) ? "the disk is full, and it goes on with what it can't save in memory" : "it goes on after an error"} (${where}): ${e.stack}`);
  }
  process.on("uncaughtException", (e, origin) => report(e, origin));
  process.on("unhandledRejection", (e) => report(e, "unhandledRejection"));
  return { report, last: () => last };
}
