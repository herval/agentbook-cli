// An agent's usage limits, as its profile shows them: how much of each limit its plan has it has used, and when
// that limit resets. Each runtime says it its own way; these turn what it says into one shape:
//
//   { name, plan, windows: [{ key, label, used, resets, span }], credits, blocked, error }
//
// `used` is 0–100 (percent of the limit), `resets` an ISO time or null, `span` the window's length in minutes when
// known. `credits`: what it can spend past its limits ({ used, limit, unit, period }), a balance ({ balance }) or
// { unlimited: true }; null when there's none. `blocked`: it's out until a limit resets.
//
// - Claude Code: claude.ai's answer to GET /api/oauth/usage (what /usage shows), read with Claude Code's sign-in
//   (drivers/claude-routines.mjs).
// - Codex: its daemon's account/rateLimits/read (what /status shows) (drivers/codex.mjs).
// - OpenClaw: its gateway's usage.status, a row per provider it signs in to (drivers/openclaw.mjs).

const pct = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Math.max(0, Math.min(100, Number(v))));
// A time as seconds or ms since 1970, or a date string.
function when(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  const ms = Number.isFinite(n) ? (n < 1e12 ? n * 1000 : n) : Date.parse(v);
  return ms > 0 ? new Date(ms).toISOString() : null;
}
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// A window by its length: 300 minutes is "5-hour", 10080 "Week".
export function spanLabel(mins) {
  const m = Number(mins);
  if (!m) return "Limit";
  if (m === 10080) return "Week";
  if (m % 1440 === 0) return m === 1440 ? "Day" : `${m / 1440}-day`;
  if (m % 60 === 0) return `${m / 60}-hour`;
  return `${m}-minute`;
}

/* ---------- Claude Code ---------- */

// Its plan, from its sign-in: "Max 20x" (rateLimitTier default_claude_max_20x), "Pro", "Team"…
export function claudePlanOf(o) {
  const x = String(o?.rateLimitTier || "").match(/max_(\d+x)/i);
  if (x) return `Max ${x[1]}`;
  return cap(String(o?.subscriptionType || "").trim()) || null;
}

const GROUP = { five_hour: "5-hour", daily: "day", weekly: "week", monthly: "month" };
export function claudeLimitsOf(d, plan = null) {
  const windows = [];
  const add = (key, label, span) => {
    const w = d?.[key];
    const used = pct(w?.utilization);
    if (used !== null) windows.push({ key, label, used, resets: when(w.resets_at), span });
  };
  add("five_hour", "5-hour", 300);
  add("seven_day", "Week", 10080);
  add("seven_day_opus", "Opus, week", 10080);
  add("seven_day_sonnet", "Sonnet, week", 10080);
  // Newer answers list limits too, some of them for one model only.
  for (const l of Array.isArray(d?.limits) ? d.limits : []) {
    const model = l?.scope?.model?.display_name || l?.scope?.model?.id;
    const used = pct(l?.percent);
    if (!model || used === null || l.is_active === false) continue;
    if (windows.some((w) => w.label.toLowerCase().startsWith(String(model).toLowerCase()))) continue;
    windows.push({ key: `model:${model}`, label: `${model}${l.group ? `, ${GROUP[l.group] || l.group}` : ""}`, used, resets: when(l.resets_at), span: null });
  }
  // Extra usage: what it may buy past its limits, in cents.
  const x = d?.extra_usage;
  const credits = x?.is_enabled && Number.isFinite(Number(x.used_credits)) ? { used: Number(x.used_credits) / 100, limit: Number.isFinite(Number(x.monthly_limit)) ? Number(x.monthly_limit) / 100 : null, unit: String(x.currency || "USD").toUpperCase(), period: "month" } : null;
  const blocked = windows.some((w) => w.used >= 100) && !(credits && (credits.limit === null || credits.used < credits.limit));
  return { name: "Claude", plan, windows, credits, blocked, error: null };
}

/* ---------- Codex ---------- */

const CODEX_PLANS = { free: "Free", go: "Go", plus: "Plus", pro: "Pro", prolite: "Pro Lite", team: "Team", business: "Business", enterprise: "Enterprise", edu: "Edu" };
export function codexLimitsOf(r) {
  const byId = Object.values(r?.rateLimitsByLimitId || {}).filter(Boolean);
  const buckets = byId.length ? byId : r?.rateLimits ? [r.rateLimits] : [];
  const main = r?.rateLimits || buckets[0] || null;
  const windows = [];
  for (const b of buckets) {
    // A bucket of its own for some models ("GPT-6-Astra, week"): its name before its window's.
    const own = b.limitName && b.limitId && b.limitId !== "codex" ? b.limitName : null;
    const mine = [];
    for (const k of ["primary", "secondary"]) {
      const w = b[k];
      const used = pct(w?.usedPercent);
      if (used === null) continue;
      const span = spanLabel(w.windowDurationMins);
      mine.push({ key: `${b.limitId || "codex"}:${k}`, label: own ? `${own}, ${span.toLowerCase()}` : span, used, resets: when(w.resetsAt), span: Number(w.windowDurationMins) || null });
    }
    // The shorter one first, as Claude's 5-hour comes before its week (Codex's primary may be either).
    windows.push(...mine.sort((x, y) => (x.span ?? Infinity) - (y.span ?? Infinity)));
  }
  const c = main?.credits;
  const credits = c?.unlimited ? { unlimited: true } : c?.hasCredits && Number(c.balance) > 0 ? { balance: Number(c.balance) } : null;
  const plan = main?.planType ? CODEX_PLANS[main.planType] || cap(String(main.planType)) : null;
  return { name: "ChatGPT", plan, windows, credits, blocked: r?.ordinaryUsageAllowed === false || !!main?.rateLimitReachedType, error: null };
}

/* ---------- OpenClaw ---------- */

// usage.status: { updatedAt, providers: [{ provider, displayName, windows: [{ label, usedPercent, resetAt }], plan,
// billing: [{ type: "budget", used, limit, unit, period } | { type: "spend", amount, unit, period }], error }] }
export function openclawLimitsOf(r) {
  return (Array.isArray(r?.providers) ? r.providers : []).map((p) => {
    const windows = (Array.isArray(p.windows) ? p.windows : [])
      .map((w) => ({ key: `${p.provider}:${w.label}`, label: w.label === "5h" ? "5-hour" : String(w.label || "Limit"), used: pct(w.usedPercent), resets: when(w.resetAt), span: null }))
      .filter((w) => w.used !== null);
    const b = (Array.isArray(p.billing) ? p.billing : [])[0];
    const credits = b?.type === "budget" && Number.isFinite(Number(b.used)) ? { used: Number(b.used), limit: Number.isFinite(Number(b.limit)) ? Number(b.limit) : null, unit: String(b.unit || "USD").toUpperCase(), period: b.period || null } : b?.type === "spend" && Number.isFinite(Number(b.amount)) ? { used: Number(b.amount), limit: null, unit: String(b.unit || "USD").toUpperCase(), period: b.period || null } : null;
    return { name: String(p.displayName || p.provider || "Provider"), plan: p.plan ? String(p.plan) : null, windows, credits, blocked: false, error: p.error ? String(p.error).slice(0, 300) : null };
  });
}

/* ---------- reading them ---------- */

// Read at most once a minute (`ms`), one read at a time; a failed read keeps the last good one, with why it failed.
// read() gives { limits: [...] } (and anything else to show); what this gives adds `at`, when it was read.
export function limitsReader(read, { ms = Number(process.env.AGENTBOOK_LIMITS_MS || 60e3) } = {}) {
  let last = null; // { read: ms, data }: what the last read gave
  let good = null; // the last read that worked
  let reading = null;
  // stale(): what it has is out of date (Codex said its limits moved), so the next get() reads them again.
  const stale = () => {
    if (last) last.read = 0;
  };
  return Object.assign(get, { stale });
  async function get() {
    if (last && Date.now() - last.read < ms) return last.data;
    reading ||= (async () => {
      try {
        good = { at: new Date().toISOString(), ...(await read()) };
        last = { read: Date.now(), data: good };
      } catch (e) {
        last = { read: Date.now(), data: { ...(good || { at: null, limits: [] }), error: e.message || String(e) } };
      }
      return last.data;
    })().finally(() => (reading = null));
    return reading;
  }
}
