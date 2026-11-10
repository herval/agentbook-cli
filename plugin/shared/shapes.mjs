// How an agent's turn went, as it says it with its ab_* tools: what the page shows on the
// reply that ends the turn, over its text. ab_verdict (its line),
// ab_checks, ab_suggest; and what it made or found for them: ab_draft (an email, a pull request, an invite, a
// message), ab_cards (places, products, prices against a limit), ab_slots (times to pick from), ab_path (the stages
// it went through, dead ends too) and ab_highlight (what matters in its reply, or in what it read); and what the work
// looks like: ab_compare (pictures with a job: before and after, options to pick, a desktop and
// a phone; or numbers that moved), ab_diagram (boxes and arrows) and ab_chart (numbers plotted, lines or bars). The
// machine checks what the agent sent here (shapeOf) before it goes in its store (session.shape).

import { localPicture } from "./pictures.mjs";
import { cleanData, noteLines } from "./widgets.mjs";

// A verdict's kinds, each a color on the page: done green, found blue, needs_you yellow, partly orange, blocked red,
// nothing grey.
export const VERDICTS = ["done", "found", "needs_you", "partly", "blocked", "nothing"];
// A check: it failed, or it wasn't checked. One that passed still comes from older plugins and is kept, but the page
// shows only what could still be wrong.
export const CHECKS = ["failed", "not_checked"];
export const DRAFTS = ["email", "pull_request", "invite", "message"];
// How its cards are picked: several (they can go together, the default): their buttons pick, and Continue sends what
// you picked as one message; one (they're alternatives): a button sends at once.
export const PICKS = ["several", "one"];
export const LIMITS = { line: 200, gist: 3, checks: 12, label: 80, detail: 600, do: 100, replies: 6, reply: 100, drafts: 3, body: 6000, cards: 6, series: 90, slots: 60, stages: 12, items: 8, passage: 1200, numbers: 6 };
// What a compare shows: one frame with a handle to drag between before and after; options side by side to pick from;
// the same screen at a desktop's size and a phone's; numbers that moved, from what they were to what they are.
export const COMPARES = ["before_after", "options", "sizes", "numbers"];
// How many pictures each takes.
const PICTURES = { before_after: [2, 2], options: [2, 4], sizes: [2, 3] };
export const FRAMES = ["desktop", "phone"];

const text = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
// Text whose lines matter (an email's body): its lines kept, each trimmed at the end.
const body = (v, max) => (typeof v === "string" ? v.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, max) : "");
const list = (v, n, max) => (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,;]\s*/) : []).map((x) => text(x, max)).filter(Boolean).slice(0, n);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const webUrl = (v) => (typeof v === "string" && /^https:\/\/[^\s"'<>]+$/i.test(v.trim()) ? v.trim().slice(0, 1000) : null);
// When something is: a time it can read (ISO, "2026-10-30T15:00"), kept as it was written.
const when = (v) => (typeof v === "string" && v.trim() && !Number.isNaN(Date.parse(v)) ? v.trim().slice(0, 40) : null);
const fail = (error) => ({ error });
// A picture: one on the agent's machine, by its path (its machine sends it up, as for `![](/tmp/shot.png)`), or an
// https address.
const pictureOf = (v) => (typeof v !== "string" ? null : webUrl(v) || (localPicture(v.trim()) && v.trim().length <= 2000 ? v.trim() : null));
// The pictures on this machine a shape names, for its machine to send up (daemon.mjs).
export const localPictures = (shape) => [...(shape?.compare?.pictures || []).map((p) => p.picture), ...(shape?.cards || []).map((c) => c.image)].filter((u) => u && !webUrl(u));

function draftOf(d) {
  if (!d || typeof d !== "object") return fail("draft must be { kind, … }");
  if (!DRAFTS.includes(d.kind)) return fail(`a draft's kind must be one of ${DRAFTS.join(", ")}`);
  const action = text(d.action, 40) || null;
  if (d.kind === "email") {
    const to = list(d.to, 10, 200);
    if (!to.length) return fail("an email needs who it's to");
    if (!text(d.subject, 200)) return fail("an email needs a subject");
    if (!body(d.body, LIMITS.body)) return fail("an email needs its body");
    return { draft: { kind: "email", to, cc: list(d.cc, 10, 200), from: text(d.from, 200) || null, subject: text(d.subject, 200), body: body(d.body, LIMITS.body), action } };
  }
  if (d.kind === "pull_request") {
    if (!text(d.title, 200)) return fail("a pull request needs a title");
    return { draft: { kind: "pull_request", title: text(d.title, 200), body: body(d.body, LIMITS.body), branch: text(d.branch, 200) || null, base: text(d.base, 200) || null, repo: text(d.repo, 200) || null, action } };
  }
  if (d.kind === "invite") {
    if (!text(d.title, 200)) return fail("an invite needs a title");
    if (!when(d.when)) return fail("an invite needs when it is, a time like 2026-10-30T15:00");
    const minutes = num(d.minutes);
    return { draft: { kind: "invite", title: text(d.title, 200), when: when(d.when), minutes: minutes && minutes > 0 ? Math.min(Math.round(minutes), 1440) : null, attendees: list(d.attendees, 20, 200), where: text(d.where, 200) || null, body: body(d.body, 2000), action } };
  }
  if (!text(d.to, 200)) return fail("a message needs who or where it goes: \"#releases\", \"Lena on Slack\"");
  if (!body(d.body, 4000)) return fail("a message needs its text");
  return { draft: { kind: "message", to: text(d.to, 200), via: text(d.via, 60) || null, body: body(d.body, 4000), action } };
}

function cardOf(c) {
  if (!c || typeof c !== "object" || !text(c.title, 120)) return fail("each card needs a title");
  const card = { title: text(c.title, 120) };
  if (text(c.text, 300)) card.text = text(c.text, 300);
  if (pictureOf(c.image)) card.image = pictureOf(c.image);
  if (webUrl(c.url)) card.url = webUrl(c.url);
  const facts = list(c.facts, 5, 40);
  if (facts.length) card.facts = facts;
  if (text(c.badge, 60)) card.badge = text(c.badge, 60);
  if (c.price != null) {
    const p = c.price;
    const value = num(p?.value);
    if (value == null) return fail("a card's price needs its value, a number");
    const series = (Array.isArray(p.series) ? p.series : []).map(num).filter((n) => n != null).slice(-LIMITS.series);
    card.price = { value, unit: text(p.unit, 12) || "", ...(num(p.limit) != null ? { limit: num(p.limit) } : {}), ...(series.length >= 2 ? { series } : {}), ...(text(p.from, 20) ? { from: text(p.from, 20) } : {}), ...(text(p.to, 20) ? { to: text(p.to, 20) } : {}) };
  }
  const actions = (Array.isArray(c.actions) ? c.actions : []).slice(0, 3).map((a) => (typeof a === "string" ? { label: text(a, 40) } : { label: text(a?.label, 40), ...(text(a?.says, 300) ? { says: text(a.says, 300) } : {}) })).filter((a) => a.label);
  if (actions.length) card.actions = actions;
  return { card };
}

function slotsOf(b) {
  if (!text(b.title, 120)) return fail("slots need a title: what the time is for");
  const times = [];
  for (const t of (Array.isArray(b.times) ? b.times : []).slice(0, LIMITS.slots)) {
    const at = when(typeof t === "string" ? t : t?.at);
    if (!at) return fail("each time needs when it starts, like 2026-10-30T15:00");
    times.push({ at, ...(t?.best ? { best: true } : {}) });
  }
  if (!times.length) return fail("slots need at least one time");
  const minutes = num(b.minutes);
  return { slots: { title: text(b.title, 120), minutes: minutes && minutes > 0 ? Math.min(Math.round(minutes), 1440) : null, with: text(b.with, 120) || null, action: text(b.action, 40) || null, times } };
}

function pathOf(stages) {
  if (!Array.isArray(stages) || !stages.length) return fail("stages must be a list of { text, minutes?, dead? }");
  const out = [];
  for (const s of stages.slice(0, LIMITS.stages)) {
    if (!text(s?.text, 200)) return fail("each stage needs its text");
    const minutes = num(s.minutes);
    out.push({ text: text(s.text, 200), ...(minutes != null && minutes >= 0 ? { minutes: Math.min(Math.round(minutes), 1440) } : {}), ...(text(s.dead, 200) ? { dead: text(s.dead, 200) } : {}) });
  }
  return { path: { stages: out } };
}

function highlightOf(b) {
  const items = Array.isArray(b.items) ? b.items.slice(0, LIMITS.items) : [];
  if (!items.length) return fail("items must be a list of { text, … }: what matters, word for word");
  const source = typeof b.source === "string" && b.source.trim() ? b.source.trim().slice(0, 1000) : null;
  if (!source) {
    const marks = items.map((i) => ({ text: text(typeof i === "string" ? i : i?.text, 300), ...(text(i?.note, 300) ? { note: text(i.note, 300) } : {}) })).filter((m) => m.text);
    if (!marks.length) return fail("each item needs its text, word for word as your reply says it");
    return { marks };
  }
  const out = [];
  for (const i of items) {
    const passage = body(typeof i === "string" ? i : i?.text, LIMITS.passage);
    if (!passage) return fail("each item needs its text: the passage, word for word");
    const mark = text(i?.mark, 300);
    out.push({ text: passage, ...(mark && passage.replace(/\s+/g, " ").includes(mark) ? { mark } : {}), ...(text(i?.where, 60) ? { where: text(i.where, 60) } : {}), ...(text(i?.label, 20) ? { label: text(i.label, 20) } : {}), ...(text(i?.note, 300) ? { note: text(i.note, 300) } : {}) });
  }
  return { excerpts: { source, title: text(b.title, 200) || source.split(/[/\\]/).pop(), items: out } };
}

function compareOf(c) {
  if (!c || typeof c !== "object") return fail("compare must be { kind, … }");
  if (!COMPARES.includes(c.kind)) return fail(`compare's kind must be one of ${COMPARES.join(", ")}`);
  const head = { kind: c.kind, ...(text(c.title, 120) ? { title: text(c.title, 120) } : {}) };
  if (c.kind === "numbers") {
    const nums = [];
    for (const n of (Array.isArray(c.numbers) ? c.numbers : []).slice(0, LIMITS.numbers)) {
      const label = text(n?.label, 60);
      const from = num(n?.from);
      const to = num(n?.to);
      if (!label || from == null || to == null) return fail("each number needs its label, and from and to as numbers");
      nums.push({ label, from, to, ...(text(n.unit, 12) ? { unit: text(n.unit, 12) } : {}), ...(n.better === "up" || n.better === "down" ? { better: n.better } : {}) });
    }
    if (!nums.length) return fail("numbers must be a list of { label, from, to, unit?, better? }");
    return { compare: { ...head, numbers: nums } };
  }
  const [least, most] = PICTURES[c.kind];
  const pics = [];
  for (const p of (Array.isArray(c.pictures) ? c.pictures : []).slice(0, most)) {
    const picture = pictureOf(typeof p === "string" ? p : p?.picture);
    if (!picture) return fail("each picture needs its picture: a path on this machine (/tmp/after.png) or an https address, of a PNG, JPEG, GIF or WebP");
    const frame = FRAMES.includes(p?.frame) ? p.frame : null;
    pics.push({ picture, ...(text(p?.label, 60) ? { label: text(p.label, 60) } : {}), ...(text(p?.text, 200) ? { text: text(p.text, 200) } : {}), ...(p?.pick ? { pick: true } : {}), ...(frame ? { frame } : {}), ...(text(p?.says, 300) ? { says: text(p.says, 300) } : {}) });
  }
  if (pics.length < least) return fail(least === most ? `${c.kind} takes ${least} pictures: before, then after` : `${c.kind} takes ${least} to ${most} pictures`);
  // Desktop and phone: the first a desktop's unless it says, the others phones'.
  if (c.kind === "sizes") pics.forEach((p, i) => (p.frame ||= i ? "phone" : "desktop"));
  if (c.kind === "options" && pics.filter((p) => p.pick).length > 1) return fail("pick at most one option: the one you'd go with");
  return { compare: { ...head, pictures: pics, ...(c.kind === "options" && text(c.action, 30) ? { action: text(c.action, 30) } : {}) } };
}

// A diagram: a page's diagram widget, checked as one (widgets.mjs).
function diagramOf(d) {
  if (!d || typeof d !== "object" || !Array.isArray(d.nodes) || !d.nodes.length) return fail("diagram needs nodes: [{ id?, title, text?, state? }], and edges: [{ from, to }]");
  const out = { errors: [], notes: [] };
  const kept = cleanData("diagram", { nodes: d.nodes, edges: d.edges || [] }, out, { at: "diagram" });
  if (out.errors.length) return fail(out.errors.slice(0, 3).join(" "));
  return { diagram: { ...(text(d.title, 120) ? { title: text(d.title, 120) } : {}), ...kept }, notes: noteLines(out.notes) };
}

// A chart: a page's chart widget, checked as one (widgets.mjs): lines, bars side by side or stacked, or a scatter. A
// series with more numbers than x has labels draws only as many, so it's told.
function chartOf(c) {
  const scatter = c?.kind === "scatter";
  if (!c || typeof c !== "object" || !Array.isArray(c.series) || !c.series.length || (!scatter && (!Array.isArray(c.x) || !c.x.length))) return fail(scatter ? "a scatter needs series: [{ name, points: [[x, y], ..] }]" : "chart needs x: [labels] and series: [{ name, values: [numbers] }]");
  const out = { errors: [], notes: [] };
  const { title, ...data } = c;
  const kept = cleanData("chart", data, out, { at: "chart" });
  if (out.errors.length) return fail(out.errors.slice(0, 3).join(" "));
  const n = kept.x?.length;
  if (!scatter) for (const s of kept.series) if (s.values.length > n) out.notes.push(`"${s.name}" has ${s.values.length} values for ${n} x labels: only the first ${n} show.`);
  return { chart: { ...(text(title, 120) ? { title: text(title, 120) } : {}), ...kept }, notes: noteLines(out.notes) };
}

// What it sent ({ verdict, line, gist }, { checks }, { replies }, { draft }, { cards }, { slots }, { stages },
// { items, source? }, { compare }, { diagram }, { chart }), checked and trimmed, as { shape } with the parts it sent
// (and `notes`, what was left out of it); or { error } saying what's wrong, so it can send it again right.
export function shapeOf(b) {
  const shape = {};
  const notes = [];
  if (b.verdict != null) {
    if (!VERDICTS.includes(b.verdict)) return fail(`verdict must be one of ${VERDICTS.join(", ")}`);
    const line = text(b.line, LIMITS.line);
    if (!line) return fail("line is required: how it went, in one line");
    // `gist`: from older plugins, kept and not drawn: the reply itself shows under the line.
    const gist = list(b.gist, LIMITS.gist, 240);
    shape.verdict = { kind: b.verdict, line, ...(gist.length ? { gist } : {}) };
  }
  if (b.checks != null) {
    if (!Array.isArray(b.checks) || !b.checks.length) return fail("checks must be a list of { status, label, detail? }");
    const checks = [];
    for (const c of b.checks.slice(0, LIMITS.checks)) {
      if (!CHECKS.includes(c?.status) && c?.status !== "passed") return fail(`a check's status must be one of ${CHECKS.join(", ")}`);
      const label = text(c.label, LIMITS.label);
      if (!label) return fail("each check needs a label");
      // `do`: what to send to have it check that (a button on the row).
      checks.push({ status: c.status, label, ...(text(c.detail, LIMITS.detail) ? { detail: text(c.detail, LIMITS.detail) } : {}), ...(text(c.do, LIMITS.do) ? { do: text(c.do, LIMITS.do) } : {}) });
    }
    shape.checks = checks;
  }
  if (b.replies != null) {
    if (!Array.isArray(b.replies)) return fail("replies must be a list of what the person might say");
    const replies = [...new Set(b.replies.map((r) => text(r, LIMITS.reply)).filter(Boolean))].slice(0, LIMITS.replies);
    if (!replies.length) return fail("replies must have at least one");
    shape.replies = replies;
  }
  if (b.draft != null) {
    const r = draftOf(b.draft);
    if (r.error) return r;
    shape.drafts = [r.draft];
  }
  if (b.cards != null) {
    if (!Array.isArray(b.cards) || !b.cards.length) return fail("cards must be a list of { title, … }");
    if (b.pick != null && !PICKS.includes(b.pick)) return fail(`pick must be one of ${PICKS.join(", ")}`);
    const cards = [];
    for (const c of b.cards.slice(0, LIMITS.cards)) {
      const r = cardOf(c);
      if (r.error) return r;
      cards.push(r.card);
    }
    shape.cards = cards;
    // Always with its cards, so cards sent again don't keep the last ones' pick.
    shape.cardsPick = b.pick || "several";
  }
  if (b.slots != null) {
    const r = slotsOf(b.slots);
    if (r.error) return r;
    shape.slots = r.slots;
  }
  if (b.stages != null) {
    const r = pathOf(b.stages);
    if (r.error) return r;
    shape.path = r.path;
  }
  if (b.items != null) {
    const r = highlightOf(b);
    if (r.error) return r;
    Object.assign(shape, r.marks ? { marks: r.marks } : { excerpts: r.excerpts });
  }
  if (b.compare != null) {
    const r = compareOf(b.compare);
    if (r.error) return r;
    shape.compare = r.compare;
  }
  if (b.diagram != null) {
    const r = diagramOf(b.diagram);
    if (r.error) return r;
    shape.diagram = r.diagram;
    notes.push(...r.notes);
  }
  if (b.chart != null) {
    const r = chartOf(b.chart);
    if (r.error) return r;
    shape.chart = r.chart;
    notes.push(...r.notes);
  }
  if (!Object.keys(shape).length) return fail("Nothing to show: send a verdict and its line, checks, replies, a draft, cards, slots, stages, items, a compare, a diagram or a chart.");
  return { shape, ...(notes.length ? { notes } : {}) };
}

// A draft added to the turn's others: one like it (the same kind and subject or title) replaced, three at most.
export function withDraft(had, draft) {
  const same = (d) => d.kind === draft.kind && (d.subject || d.title || d.to) === (draft.subject || draft.title || draft.to);
  return [...(had || []).filter((d) => !same(d)), draft].slice(-LIMITS.drafts);
}
