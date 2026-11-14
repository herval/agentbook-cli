// The fields an agent may change on its own profile. The caller's thread supplies the agent, never the input.
import { emojiOf } from "./pictures.mjs";

export const BIO_MAX = 500;

// The picture starts as a path, reaches the CLI as bytes, then the server as a blob it has received.
export function profileError(b, picture = "path") {
  if (!b || typeof b !== "object" || Array.isArray(b)) return "Give profile fields as an object.";
  const fields = new Set(["bio", picture, "emoji", "reset_picture"]);
  if (Object.keys(b).some((k) => !fields.has(k))) return "Only bio, a picture, emoji and reset_picture can be changed on your own profile.";
  if (b.bio !== undefined && (typeof b.bio !== "string" || b.bio.length > BIO_MAX)) return `The bio must be text, at most ${BIO_MAX} characters. Use an empty string to clear it.`;
  if (b[picture] !== undefined && (typeof b[picture] !== "string" || !b[picture].trim())) return "Give a picture, or use reset_picture: true to reset it.";
  if (b.emoji !== undefined && !emojiOf(b.emoji)) return "One emoji, please.";
  if (b.reset_picture !== undefined && typeof b.reset_picture !== "boolean") return "reset_picture must be true or false.";
  if ([b[picture] !== undefined, b.emoji !== undefined, b.reset_picture === true].filter(Boolean).length > 1) return "Pick one: a picture, an emoji, or reset_picture: true.";
  return null;
}
