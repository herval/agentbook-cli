// What a page's shape says back to the agent that writes it. Pages that several threads keep grow a section
// per thread: an intro note, its own totals, a "what stands out" note, a "sources" note, and nothing ever comes
// off. The answer to a write names what it can see of that, so the agent folds what it has into the widgets
// that are there instead of adding more: how many widgets the page has once it's past what reads well, notes
// that do the same job, titles that say the same thing, tables that show the same numbers, a note that's long,
// and text that grew by being added to. An agent can't take a page past AGENT_MAX widgets.

export const READS_WELL = 16; // past this, a write that adds widgets is asked to fold some in
export const AGENT_MAX = 30; // an agent's write can't take a page past this many (a person's, 60)
const NOTE_LONG = 1200; // characters of a note's text
const GREW = 200; // characters a note or doc grew by being added to
const SHARED_NUMBERS = 8; // distinct numbers two tables, lists or notes both show

const STOP = new Set("a an and the of to in on for per by at vs with from or is are this that what how its it all".split(" "));
const MONTHS = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*$/;
// A title's words, without the small ones or bare numbers. A number's title keeps its months, which are what tell
// two of them apart ("GCP bill, September", "GCP bill, October"); other widgets' don't ("Log: this week", "Log: week one").
const titleWords = (t, dates = false) =>
  String(t || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w) && !/^\d+$/.test(w) && (dates || !MONTHS.test(w)))
    .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w));
// Two widgets of a kind whose titles say the same thing: two numbers almost word for word, others mostly, or half
// with the same first two words ("Answer engines: 15 fixed questions", "Answer engines: 5 pitch questions").
function sameTitles(a, b) {
  if (a.type !== b.type || !a.title || !b.title) return false;
  const metric = a.type === "metric";
  const [x, y] = [titleWords(a.title, metric), titleWords(b.title, metric)];
  const j = jaccard(new Set(x), new Set(y));
  if (metric) return j >= 0.8;
  return j >= 0.6 || (j >= 0.5 && x.length > 1 && y.length > 1 && x[0] === y[0] && x[1] === y[1]);
}
const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
};

// What a note or doc is for, by its title: where the numbers come from, or what matters / what changed.
const ROLES = [
  ["say where the numbers come from", /\b(sources?|method|methodology|how (this|it|we|the numbers?)[\w\s]*(built|made|kept|work|computed|pulled|counted|refreshed)|how to read|caveats?|data notes?)\b/i],
  ["say what stands out", /\b(stands? out|what changed|highlights?|takeaways?|summary|tl;?dr|in short|overview|status|where (it|we|things) stands?|today|this week|the gist|intro(duction)?)\b/i],
];
const roleOf = (w) => ((w.type === "note" || w.type === "doc") && ROLES.find(([, re]) => re.test(w.title || ""))?.[0]) || null;

const textOf = (w) => (typeof w.data?.text === "string" ? w.data.text : "");
const cellText = (c) => (c && typeof c === "object" ? String(c.text ?? c.value ?? "") : String(c ?? ""));
// Everything a widget says, for finding the numbers in it.
function said(w) {
  const d = w.data || {};
  const out = [textOf(w)];
  for (const it of Array.isArray(d.items) ? d.items : []) out.push([it?.text, it?.sub, it?.note, it?.label].filter(Boolean).join(" "));
  for (const r of Array.isArray(d.rows) ? d.rows : []) out.push((Array.isArray(r) ? r : Object.values(r || {})).map(cellText).join(" "));
  return out.join("\n");
}
// The numbers a widget shows that are unlikely to be the same by chance: "$552.9k", "40.8¢", "1,080", three digits
// or more. Dates, years and round little numbers ("20%", "$10k") aren't.
function figures(w) {
  const s = said(w).replace(/\b\d{4}-\d{2}(-\d{2})?(T[\d:]+)?\b/g, " ");
  const out = new Set();
  for (const m of s.matchAll(/[$€£]?\d[\d,]*(\.\d+)?\s?[kKmM%¢]?/g)) {
    const f = m[0].replace(/\s/g, "").replace(/,/g, "");
    const n = Number(f.replace(/[^\d.]/g, ""));
    if (/^(19|20)\d\d$/.test(f)) continue;
    if ((f.match(/\d/g) || []).length < 3 || (!/[$€£%¢kKmM.]/.test(f) && n < 100)) continue;
    out.add(f.toLowerCase());
  }
  return out;
}
const sharedCount = (a, b) => {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
};

const named = (w) => `${w.id}${w.title ? ` ("${String(w.title).slice(0, 50)}")` : ""}`;
const list = (xs) => (xs.length < 3 ? xs.join(" and ") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

// What to tell the agent about the page it just wrote: { lines } (each a sentence or two), empty when the page
// reads well. `made`: the write made the page.
export function pageAdvice({ before = [], after = [], written = [], made = false }) {
  const had = new Map(before.map((w) => [w.id, w]));
  const sent = new Set(written.map((w) => w.id));
  const added = written.filter((w) => !had.has(w.id)).map((w) => w.id);
  const now = new Map(after.map((w) => [w.id, w]));
  const mine = after.filter((w) => sent.has(w.id));
  const lines = [];

  if ((made || added.length) && after.length > READS_WELL)
    lines.push(
      made
        ? `It starts with ${after.length} widgets, more than a page reads well with (about 12). Put what goes together in one widget: one table instead of several, one note on what matters.`
        : `It has ${after.length} widgets now, ${added.length} of them new in this write. A page reads well with about 12: before you add another, fold what it says into a widget that's there (a row, a column, a line, a point) and take the rest off with remove.`,
    );

  // Notes that do the same job. Only when this write has a hand in it, so a refresh isn't told again and again.
  for (const [role] of ROLES) {
    const same = after.filter((w) => roleOf(w) === role);
    if (same.length > 1 && same.some((w) => sent.has(w.id))) lines.push(`${list(same.map(named))} ${same.length === 2 ? "both" : "all"} ${role}: one note is enough. Merge them, and remove ${same.length === 2 ? "the other" : "the others"}.`);
  }
  const notes = after.filter((w) => w.type === "note");
  if (notes.length > 3 && notes.some((w) => added.includes(w.id))) lines.push(`It has ${notes.length} notes. A page needs one on what matters and one on sources: put the rest in the widgets they explain (a column, a row, a line), not in notes of their own.`);

  // Titles that say the same thing, and tables that show the same numbers, where this write touched one of them.
  const pairs = [];
  const nums = new Map(after.filter((w) => w.type !== "metric" && w.type !== "chart").map((w) => [w.id, figures(w)]));
  for (const a of mine)
    for (const b of after) {
      if (a.id === b.id || (sent.has(b.id) && b.id < a.id)) continue;
      if (sameTitles(a, b) && !(roleOf(a) && roleOf(a) === roleOf(b))) pairs.push({ a, b, why: "say the same thing in their titles" });
      else if (nums.has(a.id) && nums.has(b.id) && sharedCount(nums.get(a.id), nums.get(b.id)) >= SHARED_NUMBERS) pairs.push({ a, b, why: `show ${sharedCount(nums.get(a.id), nums.get(b.id))} of the same numbers` });
    }
  for (const { a, b, why } of pairs.slice(0, 4)) lines.push(`${named(a)} and ${named(b)} ${why}: say it once. Keep the one that reads best, fold in what only the other has, and remove it.`);
  if (pairs.length > 4) lines.push(`…and ${pairs.length - 4} more pairs like these.`);

  // Text that grew by being added to, and notes that are long.
  for (const w of mine) {
    const was = had.get(w.id);
    const t = textOf(w).trim();
    const old = was ? textOf(was).trim() : "";
    if (old.length >= GREW && t.length >= old.length + GREW && t.includes(old)) lines.push(`${named(w)} grew from ${old.length} to ${t.length} characters by adding to what it said. Write what's true now instead: the page's versions keep what it said before, and your summary says what changed.`);
    else if (w.type === "note" && t.length > NOTE_LONG) lines.push(`${named(w)} is ${t.length} characters. A note is a few lines on what's true now; a long read goes in a doc, and detail in the table it's about.`);
  }
  return { lines: lines.slice(0, 8), widgets: now.size };
}
