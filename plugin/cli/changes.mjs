// What a session changed, worked out on the machine: the diff helpers (plugin/shared/diff.mjs), with the file as
// it is on disk now as the last resort.

import fs from "node:fs";
import { createChanges as changesFrom } from "../shared/diff.mjs";

export * from "../shared/diff.mjs";

const MAX_DISK = 4 << 20;
// A file as it is on disk now: null when it isn't there, undefined when it can't be read as text.
export function readDisk(abs) {
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > MAX_DISK) return undefined;
    const text = fs.readFileSync(abs, "utf8");
    return text.includes("\u0000") ? undefined : text;
  } catch (e) {
    return e.code === "ENOENT" ? null : undefined;
  }
}

export const createChanges = ({ load, disk = readDisk }) => changesFrom({ load, disk });
