// A claude.ai artifact, as one HTML file a thread can show (ab_artifact).
//
// claude.ai refuses to be framed by another site, so its link can't be embedded. What a Claude Code session can do
// is read the artifact with its own Artifact tool, which saves the artifact's files in a folder. This turns that
// folder into one self-contained page:
// - a plain page (a session published an HTML file): its index.html, as it is.
// - a Design canvas: its content is `project/<board>.dc.html`, a template that the Design editor's runtime
//   (`artifact-type/dc-runtime.js`, loaded by the board as ./support.js) fills in. The runtime goes into the board
//   in place of that script tag, and stylesheets the board links to beside it go in as <style>.
// - a Claude Doc: its content isn't in its files (they're only its viewer) but in the Docs service, which hands a
//   tab over as HTML through the Docs connector's export. That export reaches the session inside the tool's
//   result, not as a file, so it's read from the session's own conversation record (docExports) and set in a page
//   with a plain style of agentbook's (docPage). Its charts and diagrams aren't in an export.
// - any other type whose content isn't in its files: none.
//
// `disk`: { stat(p) -> { size } | null, read(p) -> Buffer }, the files of the machine the session is on (mcp.mjs).

import path from "node:path";
import { ARTIFACT_URL } from "../shared/mentions.mjs";

// The link as agentbook keeps it: without a query, or null when it isn't one.
export function artifactUrl(s) {
  const one = String(s || "").trim().split(/[?#]/)[0];
  const m = one.match(ARTIFACT_URL);
  return m && m[0] === one ? one : null;
}

// The page may not be bigger than this: it's kept as one file, and opened in a frame.
export const ARTIFACT_MAX = 8 * 1024 * 1024;
const RUNTIME_TAG = /<script\s+src=(["'])\.\/support\.js\1\s*>\s*<\/script>/i;
const RUNTIME = "artifact-type/dc-runtime.js";

// Text that goes inside a <script> or a <style>: its closing tag can't appear in it, and in a script "<!--" followed
// by "<script" makes the parser ignore the closing tag (the runtime has both in a regular expression).
const inScript = (js) => js.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
const inStyle = (css) => css.replace(/<\/style/gi, "<\\/style");

const text = async (disk, p) => ((await disk.stat(p)) ? (await disk.read(p)).toString("utf8") : null);
const safeRel = (rel) => !!rel && !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(rel) && !rel.split(/[\\/]/).includes("..");

// -> { html, title, kind: "page" | "design", notes: [] } or { error }. `dir`: the folder the Artifact tool saved the
// artifact's files under, or one HTML file. `board`: a Design canvas's artboard to show, by its file name.
export async function artifactPage(disk, dir, { board = "" } = {}) {
  if (await disk.stat(dir)) {
    if (!/\.html?$/i.test(dir)) {
      // A result of the Docs connector's export that Claude Code saved as a file.
      const saved = docExportsIn((await disk.read(dir)).toString("utf8"));
      return saved.length ? docPage(saved) : { error: `${dir} isn't an HTML page.` };
    }
    const html = (await disk.read(dir)).toString("utf8");
    if (RUNTIME_TAG.test(html)) return designBoard(disk, path.dirname(path.dirname(dir)), path.basename(dir), html, null);
    return sized({ html, title: titleOf(html), kind: "page", notes: [] });
  }
  const index = await text(disk, path.join(dir, "project", "canvas.json"));
  if (index != null) {
    let canvas;
    try {
      canvas = JSON.parse(index);
    } catch {
      return { error: "Its project/canvas.json isn't JSON." };
    }
    const boards = (canvas.order?.length ? canvas.order : Object.keys(canvas.boards || {})).filter((b) => typeof b === "string" && safeRel(b));
    if (!boards.length) return { error: "This Design canvas has no artboards yet." };
    const want = board ? boards.find((b) => b === board || b === `${board}.dc.html`) : (boards.includes(canvas.launch?.file) && canvas.launch.file) || boards[0];
    if (!want) return { error: `It has no artboard "${board}". It has: ${boards.join(", ")}.` };
    const html = await text(disk, path.join(dir, "project", want));
    if (html == null) return { error: `Read its file project/${want} with your Artifact tool first (action "read", paths), then call this again.` };
    return designBoard(disk, dir, want, html, { canvas, boards });
  }
  const typed = (await disk.stat(path.join(dir, "SKILL.md"))) || (await disk.stat(path.join(dir, RUNTIME)));
  const page = typed ? null : await text(disk, path.join(dir, "index.html"));
  if (page != null) return sized({ html: page, title: titleOf(page), kind: "page", notes: [] });
  if (typed) return { error: `This artifact's content isn't in its files, which are only its viewer. If it's a Claude Doc: ${DOC_HOW} Any other type: give them the link instead.` };
  return { error: `No artifact files under ${dir}. Read the artifact with your Artifact tool first: list its files (action "list", scope "files"), read the ones this needs (action "read", paths), and pass the folder it saved them under. A plain page needs index.html; a Design canvas needs project/canvas.json, the artboard's project/<name>.dc.html and ${RUNTIME}.` };
}

async function designBoard(disk, dir, name, html, canvas) {
  if (!RUNTIME_TAG.test(html)) return { error: `project/${name} doesn't load the Design runtime (./support.js), so it isn't an artboard this can show.` };
  const runtime = await text(disk, path.join(dir, RUNTIME));
  if (runtime == null) return { error: `Read its file ${RUNTIME} with your Artifact tool too (action "read", paths), into the same folder, then call this again: the artboard is a template that script fills in.` };
  const notes = [];
  // Stylesheets beside the artboard: in the page itself, since nothing is beside it on the thread.
  const missing = [];
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]).filter((tag) => /\brel=(["'])stylesheet\1/i.test(tag));
  for (const tag of links) {
    const href = /\bhref=(["'])(.*?)\1/i.exec(tag)?.[2];
    if (!safeRel(href)) continue;
    const css = await text(disk, path.join(dir, "project", path.dirname(name), href.split(/[?#]/)[0]));
    if (css == null) missing.push(`project/${path.posix.join(path.posix.dirname(name), href)}`);
    else html = html.replace(tag, () => `<style>${inStyle(css)}</style>`);
  }
  if (missing.length) notes.push(`It links to ${missing.join(", ")}, which ${missing.length > 1 ? "aren't" : "isn't"} in the folder, so it shows without ${missing.length > 1 ? "them" : "it"}: read ${missing.length > 1 ? "them" : "it"} with your Artifact tool and call this again to have ${missing.length > 1 ? "them" : "it"}.`);
  const blobs = new Set(html.match(/\/_blob\/[A-Za-z0-9]+/g) || []);
  if (blobs.size) notes.push(`${blobs.size} of its pictures or fonts ${blobs.size > 1 ? "are" : "is"} kept by claude.ai (/_blob/...) and won't show here.`);
  if (/<dc-import\b/i.test(html)) notes.push("It brings in other artboards (<dc-import>), which show empty here.");
  const others = (canvas?.boards || []).filter((b) => b !== name);
  if (others.length) notes.push(`This is its artboard ${name}. It has ${others.length} more (${others.slice(0, 8).join(", ")}${others.length > 8 ? ", …" : ""}): pass \`board\` to show another.`);
  html = html.replace(RUNTIME_TAG, () => `<script>${inScript(runtime)}</script>`);
  const entry = canvas?.canvas?.boards?.[name];
  return sized({ html, title: String(canvas?.canvas?.title || entry?.title || titleOf(html) || "").trim(), kind: "design", notes });
}

const titleOf = (html) => (/<title[^>]*>([^<]{1,200})<\/title>/i.exec(html)?.[1] || "").replace(/\s+/g, " ").trim();
const sized = (r) => (Buffer.byteLength(r.html) > ARTIFACT_MAX ? { error: `That page is ${Math.round(Buffer.byteLength(r.html) / 1048576)} MB, over the ${ARTIFACT_MAX / 1048576} MB a thread shows. Give them the link instead.` } : r);

/* ---------- a Claude Doc ---------- */

export const DOC_HOW = "export each of its tabs with the Docs connector (read the doc for its tabs' ids, then its export tool with format \"html\"), and call this again with the link and no path: agentbook takes the export from your conversation's record.";

// The doc a link names: its id, the last part of its path (after a title, if it has one).
const idOf = (url) => String(url || "").split(/[?#]/)[0].split("/").pop();
const sameDoc = (frame, container, url) => {
  const id = idOf(url);
  const ids = [frame?.url, frame?.artifactUrl].map(idOf).concat([frame?.slug, container?.id]).filter(Boolean);
  return ids.some((x) => x === id || id.endsWith(`-${x}`));
};

// The HTML exports of the doc `url` names in a Claude Code transcript (its text): the newest of each tab, in the
// order the tabs were first exported. -> [{ tab, name, html }]. An export is the Docs connector's export tool's
// result: a JSON text part { data: { format: "html", name, bytes_b64 }, frame: { url, slug } }, for the call
// (a tool_use) that named the doc and the tab ({ container: { id }, file }).
export function docExports(transcript, url) {
  const calls = new Map(); // a tool call's id -> what it asked for
  const tabs = new Map();
  for (const line of String(transcript || "").split("\n")) {
    if (!line.includes("bytes_b64") && !line.includes("tool_use")) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const blocks = Array.isArray(entry?.message?.content) ? entry.message.content : [];
    for (const b of blocks) {
      if (b?.type === "tool_use" && b.input?.format === "html" && b.input?.container) calls.set(b.id, b.input);
      if (b?.type !== "tool_result") continue;
      for (const part of Array.isArray(b.content) ? b.content : [{ type: "text", text: b.content }]) {
        if (part?.type !== "text" || typeof part.text !== "string" || !part.text.includes("bytes_b64")) continue;
        let r;
        try {
          r = JSON.parse(part.text);
        } catch {
          continue;
        }
        const asked = calls.get(b.tool_use_id);
        if (r?.data?.format !== "html" || typeof r.data.bytes_b64 !== "string" || !sameDoc(r.frame, asked?.container, url)) continue;
        const tab = String(asked?.file || r.data.name || "tab");
        // A Map keeps a key where it first stood: a tab exported again stays in its place, with its newest text.
        tabs.set(tab, { tab, name: String(r.data.name || "").replace(/\.html?$/i, ""), html: Buffer.from(r.data.bytes_b64, "base64").toString("utf8") });
      }
    }
  }
  return [...tabs.values()];
}

// The same from a file Claude Code saved a result in, when one was too big for the conversation: whatever HTML
// exports its text holds, as they come.
export function docExportsIn(text) {
  const out = [];
  for (const m of String(text || "").matchAll(/bytes_b64[\\]*"\s*:\s*[\\]*"([A-Za-z0-9+/=\\]+)/g)) {
    const html = Buffer.from(m[1].replace(/\\/g, ""), "base64").toString("utf8");
    if (/<(p|h[1-6]|ul|ol|table|figure)\b/i.test(html)) out.push({ tab: `tab${out.length}`, name: "", html });
  }
  return out;
}

const DOC_STYLE = `
:root{color-scheme:light}
body{margin:0;background:#fff;color:#1f2328;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
main{max-width:720px;margin:0 auto;padding:28px 20px 48px}
h1{font-size:28px;line-height:1.2;margin:0 0 6px}h2{font-size:20px;margin:30px 0 8px}h3{font-size:17px;margin:22px 0 6px}
p{margin:0 0 12px}ul,ol{margin:0 0 12px;padding-left:22px}li>p{margin:0 0 4px}
a{color:#0969da}code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:#f3f4f6;border-radius:4px;padding:1px 4px}
pre{overflow-x:auto;background:#f6f8fa;border-radius:8px;padding:12px}pre code{background:none;padding:0}
blockquote{margin:0 0 12px;padding-left:12px;border-left:3px solid #d0d7de;color:#57606a}
.table{overflow-x:auto;margin:0 0 14px}table{border-collapse:collapse;font-size:14.5px}
th,td{border:1px solid #d8dee4;padding:6px 10px;text-align:left;vertical-align:top}th{background:#f6f8fa}
img{max-width:100%}hr{border:0;border-top:1px solid #d8dee4;margin:32px 0}
[data-atom=mention]{color:#57606a;background:#f3f4f6;border-radius:10px;padding:0 6px}
[data-atom=date]{color:#57606a}
figure[data-embed]{margin:14px 0;padding:12px 14px;border:1px dashed #c9d1d9;border-radius:8px;color:#57606a;font-size:14px}
figure[data-embed]::before{content:"A chart or diagram, which isn't in this copy";display:block;font-size:12px}
figure[data-embed] figcaption{color:#1f2328}
`.replace(/\n/g, "");
const escHtml = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// A doc's exported tabs, as one page. -> { html, title, kind: "doc", notes } or { error }.
export function docPage(tabs, { title = "" } = {}) {
  if (!tabs.length) return { error: `There's no export of this doc in your conversation yet. For a Claude Doc: ${DOC_HOW}` };
  const notes = [];
  const body = tabs
    .map((t) => t.html)
    .join("\n<hr>\n")
    // A person is named by an id only claude.ai can turn into a name.
    .replace(/(<span\b[^>]*data-atom="mention"[^>]*>)@u_[\w-]+(<\/span>)/g, "$1@someone$2")
    .replace(/<table\b/g, '<div class="table"><table')
    .replace(/<\/table>/g, "</table></div>");
  const figures = (body.match(/<figure\b[^>]*data-embed=/g) || []).length;
  if (figures) notes.push(`${figures} of its charts or diagrams ${figures > 1 ? "aren't" : "isn't"} in an export: ${figures > 1 ? "each shows" : "it shows"} as its caption.`);
  if (/data-atom="mention"/.test(body)) notes.push("The people it names show as @someone: an export has their ids, not their names.");
  if (tabs.length > 1) notes.push(`It has the ${tabs.length} tabs you exported, one after the other.`);
  const name = String(title || tabs[0].name || (/<h1[^>]*>([^<]{1,200})<\/h1>/i.exec(body)?.[1] ?? "")).trim();
  return sized({ html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(name || "Claude Doc")}</title><style>${DOC_STYLE}</style></head><body><main>\n${body}\n</main></body></html>\n`, title: name, kind: "doc", notes });
}
