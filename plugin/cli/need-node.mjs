// The first thing main.mjs imports: a Node too old gets this, not a stack from the first module that needs a newer one.
// db.mjs loads node:sqlite as it runs, which is after this.
import { NODE_NEEDED, nodeTooOld } from "../lib/common.mjs";

if (nodeTooOld()) {
  console.error(NODE_NEEDED());
  process.exit(1);
}
