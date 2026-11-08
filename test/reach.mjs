#!/usr/bin/env node
// How far a turn's change reaches (plugin/cli/reach.mjs): the repo by folder from `git ls-tree`, the files the turn
// changed, the files that import them from `git grep`, and the changes no test imports. With a stand-in for git.
// Run: node test/reach.mjs

import { reachOf } from "../plugin/cli/reach.mjs";

let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

const ROOT = "/repo";
const TREE = {
  "core-api/cart/totals.ts": 4000,
  "core-api/cart/totals.test.ts": 2000,
  "core-api/ledger-client/batch.ts": 1500,
  "core-api/ledger-client/client.ts": 2500,
  "core-api/auth/session.ts": 3000,
  "web/checkout/Total.tsx": 1800,
  "web/cart/Cart.tsx": 2200,
  "erp-sync/export.ts": 2100,
  "admin/refunds.ts": 1600,
  "docs/totals.md": 900,
  "README.md": 400,
};
// Who imports what, as `git grep` would find it.
const IMPORTS = { totals: ["core-api/cart/totals.test.ts", "web/checkout/Total.tsx", "erp-sync/export.ts"], batch: ["core-api/cart/totals.ts"] };
const asked = [];
const git = async (args) => {
  asked.push(args);
  if (args[0] === "ls-tree") return Object.entries(TREE).map(([p, n]) => `100644 blob abc123${" ".repeat(4)}${String(n).padStart(7)}\t${p}`).join("\n") + "\n";
  if (args[0] === "grep") {
    const re = args[args.indexOf("-e") + 1];
    const stem = Object.keys(IMPORTS).find((k) => re.includes(k));
    return (IMPORTS[stem] || []).join("\n");
  }
  return "";
};

const files = [
  { abs: `${ROOT}/core-api/cart/totals.ts`, add: 70, del: 10, kind: "edit" },
  { abs: `${ROOT}/core-api/ledger-client/batch.ts`, add: 46, del: 0, kind: "create" },
  { abs: "/elsewhere/notes.md", add: 3, del: 0, kind: "edit" },
];
const r = await reachOf({ files, root: ROOT, git });
const folder = (d) => r.folders.find((f) => f.dir === d);
const file = (d, p) => folder(d)?.files.find((f) => f.path === p);
check(r.changed === 2, "only files in the repo count: one elsewhere is left out");
check(file("core-api", "cart/totals.ts")?.changed && file("core-api", "cart/totals.ts").add === 70 && file("core-api", "ledger-client/batch.ts")?.changed, "the files it changed are in their folder, with what changed");
check(file("web", "checkout/Total.tsx")?.imports && file("erp-sync", "export.ts")?.imports && r.importers === 2, "the files that import a changed one are shown, by folder");
check(!folder("core-api").files.some((f) => f.path === "cart/totals.test.ts") && !file("core-api", "cart/totals.ts").untested, "a test that imports it isn't shown, and says the change has a test");
check(file("core-api", "ledger-client/batch.ts")?.untested && r.untested === 1, "a change no test imports is marked");
check(folder("core-api").size === 4000 + 2000 + 1500 + 2500 + 3000 && folder("core-api").rest === folder("core-api").size - 4000 - 1500, "a folder's size is its files', the rest what isn't shown");
check(r.folders[0].dir === "core-api" && r.folders.slice(0, 3).every((f) => f.files.length) && folder("docs") && folder("."), "folders with something shown come first, then the rest by size");
check(asked.filter((a) => a[0] === "grep").length === 2 && asked.find((a) => a[0] === "grep").includes("*.ts"), "it asks git who imports each changed code file, in code files only");

const big = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i}/x.ts`, 100 * (i + 1)]));
const many = await reachOf({ files: [{ abs: `${ROOT}/f0/x.ts`, add: 1, del: 1, kind: "edit" }], root: ROOT, git: async (a) => (a[0] === "ls-tree" ? Object.entries(big).map(([p, n]) => `100644 blob abc ${n}\t${p}`).join("\n") : "") });
check(many.folders.length === 9 && many.folders[0].dir === "f0" && many.folders.at(-1).dir === "…", "eight folders at most, the one it changed first, the rest as one");
check((await reachOf({ files: [{ abs: "/elsewhere/x.ts", add: 1, del: 0 }], root: ROOT, git })) === null, "nothing changed in the repo: nothing to say");

console.log(failures ? `\n${failures} failed` : "\nAll passed");
process.exit(failures ? 1 : 0);
