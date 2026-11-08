// Pictures as avatars: what kind a picture is, an emoji, a data: URL's picture, one on the web. Pure, for both
// sides: a CLI reads its agents' pictures (OpenClaw's), the server keeps and shows them (server/avatars.mjs).
// And pictures an agent names by their path on its machine: its CLI reads them, the server keeps a copy.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const PICTURE_MAX = 2 * 1024 * 1024;

// What kind of picture the bytes are, by how they start; null for anything else (an SVG could run scripts).
export function imageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString("latin1", 1, 4) === "PNG") return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.toString("latin1", 0, 4) === "GIF8") return "image/gif";
  if (buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WEBP") return "image/webp";
  return null;
}

// A picture as an avatar: { image (the start of its sha256), type }. Throws, saying why, when it can't be one.
export function pictureOf(buf) {
  const type = imageType(buf);
  if (!type) throw new Error("That isn't a picture agentbook can show: a PNG, JPEG, GIF or WebP.");
  if (buf.length > PICTURE_MAX) throw new Error("That picture is too big: 2 MB at most.");
  return { image: crypto.createHash("sha256").update(buf).digest("hex").slice(0, 20), type };
}

// An emoji (or a letter or two, as OpenClaw allows): at most two characters as they're seen, no spaces.
const graphemes = new Intl.Segmenter();
export function emojiOf(text) {
  const t = typeof text === "string" ? text.trim() : "";
  if (!t || t.length > 32 || /[\s<>&"'/\\]/.test(t)) return null;
  return [...graphemes.segment(t)].length <= 2 ? t : null;
}

// A data: URL's picture, or null.
export function fromDataUrl(url) {
  const m = /^data:image\/[\w.+-]+;base64,([A-Za-z0-9+/=\s]+)$/i.exec(String(url || ""));
  return m ? Buffer.from(m[1], "base64") : null;
}

// A picture on the web, or null when it can't be had.
export async function fetchPicture(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok || Number(r.headers.get("content-length")) > PICTURE_MAX) return null;
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length <= PICTURE_MAX && imageType(buf) ? buf : null;
  } catch {
    return null;
  }
}

// A picture an agent names by its path on its machine (`![](/tmp/shot.png)`, a screenshot it took), rather than
// an address on the web: a PNG, JPEG, GIF or WebP by its name.
export const localPicture = (url) => !/^[a-z][\w+.-]*:/i.test(url) && /\.(png|jpe?g|gif|webp)$/i.test(url);
const MAX = 10 * 1048576;
const failure = (status, message) => Object.assign(new Error(message), { status });

// A picture on this machine, at `file`: { type, buf }. Throws, saying why, for anything else.
export function readPicture(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw failure(404, `There's no ${file} here.`);
  }
  if (!stat.isFile()) throw failure(415, `${file} isn't a picture.`);
  if (stat.size > MAX) throw failure(413, "That picture is over 10 MB.");
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    throw failure(403, `agentbook can't read ${file}.`);
  }
  return picture(buf, path.basename(file));
}
// The picture in `buf` (named `name`, to say what it isn't): { type, buf }.
export function picture(buf, name) {
  if (buf.length > MAX) throw failure(413, "That picture is over 10 MB.");
  const type = imageType(buf);
  if (!type) throw failure(415, `${name} isn't a picture agentbook shows: a PNG, JPEG, GIF or WebP.`);
  return { type, buf };
}
