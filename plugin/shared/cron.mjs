// When a cron runs next: Claude's loops (plugin/cli/drivers/claude-routines.mjs) and agentbook's routines
// (routines.mjs) read the same 5-field crons.

// The next time a 5-field cron (minute hour day-of-month month day-of-week) matches after `from`, in this
// machine's time, as Claude Code reads it: day-of-month and day-of-week both set means either one.
function field(spec, min, max) {
  const out = new Set();
  for (const part of String(spec).split(",")) {
    const [range, step = "1"] = part.split("/");
    let [a, b] = range === "*" ? [min, max] : range.split("-").map(Number);
    if (b === undefined) b = range.includes("/") || part.includes("/") ? max : a;
    for (let v = a; v <= b; v += Number(step) || 1) out.add(v);
  }
  return out;
}
export function nextCron(expr, from = Date.now()) {
  const f = String(expr || "").trim().split(/\s+/);
  if (f.length !== 5) return null;
  try {
    const [mins, hours, doms, mons, dows] = [field(f[0], 0, 59), field(f[1], 0, 23), field(f[2], 1, 31), field(f[3], 1, 12), field(f[4], 0, 7)];
    if ([mins, hours, doms, mons, dows].some((s) => !s.size || [...s].some((v) => !Number.isInteger(v)))) return null;
    if (dows.has(7)) dows.add(0);
    const anyDom = f[2] === "*";
    const anyDow = f[4] === "*";
    const t = new Date(from);
    t.setSeconds(0, 0);
    t.setMinutes(t.getMinutes() + 1);
    for (let i = 0; i < 366 * 24 * 60; ) {
      const dayOk = mons.has(t.getMonth() + 1) && (anyDom && anyDow ? true : anyDom ? dows.has(t.getDay()) : anyDow ? doms.has(t.getDate()) : doms.has(t.getDate()) || dows.has(t.getDay()));
      if (!dayOk) {
        const skip = (24 - t.getHours()) * 60 - t.getMinutes();
        t.setHours(24, 0, 0, 0);
        i += skip;
        continue;
      }
      if (hours.has(t.getHours()) && mins.has(t.getMinutes())) return t.toISOString();
      t.setMinutes(t.getMinutes() + 1);
      i++;
    }
  } catch {}
  return null;
}

// An agent's routines that are on and whose last run failed, as its profile's summary says them (for Needs you).
export const failedRoutines = (list) => list.filter((r) => r.enabled && r.status === "error").map((r) => ({ id: r.id, name: r.name, at: r.last || null, error: r.error ? String(r.error).slice(0, 200) : null, times: r.failing || 1 }));
