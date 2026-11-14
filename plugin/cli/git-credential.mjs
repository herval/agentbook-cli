#!/usr/bin/env node
// git's credential helper on a cloud machine: when git asks who to
// be for https://github.com, this asks the machine's agentbook-cli, which asks the server for its owner's GitHub
// sign-in, the one their GitHub connector keeps and renews. Nothing is written to disk: a token is handed over for
// one git command at a time. agentbook-cli sets this up as `credential.https://github.com.helper` in the owner's
// own git config, and only while the server says this machine gets it (daemon.mjs, setPrefs).
//
// git runs it as `<this> get` with "key=value" lines on stdin, and reads the same back. `store` and `erase` do
// nothing here: there's nothing kept to store or forget. Anything but github.com over https gets no answer, so git
// goes on to whatever else it has.

import { api } from "../lib/common.mjs";

const lines = async () => {
  let raw = "";
  for await (const c of process.stdin) raw += c;
  return Object.fromEntries(raw.split("\n").filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
};

if (process.argv[2] === "get") {
  const asked = await lines();
  if (asked.protocol === "https" && /^github\.com(:443)?$/i.test(asked.host || "")) {
    const r = await api("GET", "/api/local/git-github").catch((e) => ({ error: `agentbook-cli didn't answer (${e.message})` }));
    if (r?.token) process.stdout.write(`username=${r.username || "x-access-token"}\npassword=${r.token}\n`);
    else process.stderr.write(`agentbook: no GitHub sign-in for git: ${r?.error || "agentbook-cli gave none"}\n`);
  }
}

// `gh`, the same way: on a cloud machine agentbook-cli puts a small `gh` ahead of the real one on PATH (daemon.mjs,
// setGhShim) that runs `<this> gh <what gh was given>`. gh has no helper to ask, but takes a token from its
// environment, so this asks agentbook-cli for the owner's token and runs the real gh with it, for that one command.
// A token already in the environment, or `gh auth` (its own sign-in), is left alone.
if (process.argv[2] === "gh") {
  const { spawnSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const args = process.argv.slice(3);
  const shim = process.env.AGENTBOOK_GH_SHIM || "";
  const same = (a, b) => {
    try {
      return fs.realpathSync(a) === fs.realpathSync(b);
    } catch {
      return false;
    }
  };
  // The real gh: the first on PATH that isn't the one that ran this.
  const real = (process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((d) => path.join(d, "gh"))
    .find((p) => fs.existsSync(p) && !(shim && same(p, shim)));
  if (!real) {
    process.stderr.write("agentbook: gh isn't installed on this machine.\n");
    process.exit(127);
  }
  const env = { ...process.env };
  if (!env.GH_TOKEN && !env.GITHUB_TOKEN && args[0] !== "auth") {
    const r = await api("GET", "/api/local/git-github").catch((e) => ({ error: `agentbook-cli didn't answer (${e.message})` }));
    if (r?.token) env.GH_TOKEN = r.token;
    else process.stderr.write(`agentbook: no GitHub sign-in for gh: ${r?.error || "agentbook-cli gave none"}\n`);
  }
  const out = spawnSync(real, args, { stdio: "inherit", env });
  process.exit(out.status ?? 1);
}
