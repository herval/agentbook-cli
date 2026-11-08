// Text helpers both sides use.

// Prompts Claude Code writes itself: channel events, subagent reports, background task notices,
// slash command output. The person typed none of it.
const TAGS = "channel|agent-message|task-notification|teammate-message|system-reminder|command-name|command-message|command-args|local-command-stdout|local-command-stderr|bash-input|bash-stdout|bash-stderr";
const INJECTED = new RegExp(`<(${TAGS})\\b[^>]*>[\\s\\S]*?<\\/\\1>`, "g");
const CUT_OFF = new RegExp(`<(${TAGS})\\b[^>]*>[\\s\\S]*$`); // one whose end was truncated away

// The part of a prompt the person typed; "" when Claude Code wrote all of it.
export function typedPart(prompt) {
  const text = String(prompt || "").replace(INJECTED, "").replace(CUT_OFF, "").trim();
  // A prompt that is one tag block end to end is a wrapper we don't know about yet.
  if (/^<([a-z][\w-]*)\b[^>]*>[\s\S]*<\/\1>$/.test(text)) return "";
  return text;
}

// A task is a title and a body (its note). The title is one short line, like a commit's subject: what's past its
// first line goes on top of the body, and so does what runs past TITLE_MAX, cut at a word, with a … at the end of
// the title and another at the start of the body. The body keeps what it had under that.
export const TITLE_MAX = 80;
export const BODY_MAX = 4000;
export function titled(text, note = "") {
  const all = String(text ?? "").trim();
  const nl = all.indexOf("\n");
  let title = (nl < 0 ? all : all.slice(0, nl)).trim();
  const below = nl < 0 ? "" : all.slice(nl + 1).trim();
  let over = "";
  if (title.length > TITLE_MAX) {
    // At the last space that leaves room for the …; one long word (a URL) is cut where the room ends.
    const space = title.lastIndexOf(" ", TITLE_MAX - 1);
    const at = space > 0 ? space : TITLE_MAX - 1;
    over = `…${title.slice(at).trim()}`;
    title = `${title.slice(0, at).trimEnd()}…`;
  }
  const body = [[over, below].filter(Boolean).join("\n"), String(note ?? "").trim()].filter(Boolean).join("\n\n");
  return { text: title, note: body.slice(0, BODY_MAX) };
}
// The title and the body as one text again, where the title was cut: for what the task asks of an agent.
export function untitled(t) {
  if (!t.text.endsWith("…") || !t.note?.startsWith("…")) return [t.text, t.note].filter(Boolean).join("\n\n");
  const head = t.text.slice(0, -1);
  return `${head}${head.includes(" ") ? " " : ""}${t.note.slice(1)}`;
}

// The code blocks in a message, as the page draws them (md() in ui/app.js): each fenced block's lines, without the
// fence's indent, and the language its fence names ("" for none). One left open runs to the end of the message.
export function codeBlocks(text) {
  const out = [];
  let code = null;
  for (const line of String(text || "").split("\n")) {
    if (code) {
      if (/^\s*```/.test(line)) {
        out.push({ lang: code.lang, code: code.lines.join("\n") });
        code = null;
      } else code.lines.push(code.indent ? line.replace(new RegExp(`^\\s{0,${code.indent}}`), "") : line);
      continue;
    }
    const fence = line.match(/^(\s*)```\s*([^\s`]*)/);
    if (fence) code = { indent: fence[1].length, lang: fence[2].toLowerCase(), lines: [] };
  }
  if (code) out.push({ lang: code.lang, code: code.lines.join("\n") });
  return out;
}
// Whether two code blocks say the same thing, whatever their lines' indents (a block in a list is drawn without the
// list's) and the blank lines around them.
const codeLines = (code) => String(code || "").split("\n").map((l) => l.trim()).join("\n").trim();
export const sameCode = (a, b) => codeLines(a) === codeLines(b);
