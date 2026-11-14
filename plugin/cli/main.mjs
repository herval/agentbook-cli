#!/usr/bin/env node
// agentbook-cli: this machine's half of agentbook. Its daemon serves this machine's
// sessions on loopback (hooks, the MCP bridge, /api/mcp), and talks to the agentbook-server it's logged in to over
// HTTPS, with its device token. The page is the server's: / here sends you there. Not logged in yet, it does nothing
// but wait for a login: it follows no session, reads no agent's files, and starts and changes none of them.
// Run: bin/agentbook-cli [run]        the daemon (AGENTBOOK_PORT, AGENTBOOK_HOME; the hooks start it)
//      bin/agentbook-cli <command>    login, logout, status, up, down, help, the gate's, local (commands.mjs)

import "./need-node.mjs"; // first, as what comes after it needs a newer one
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PORT, SERVER_LOG, VERSION, openLog, seatsIn } from "../lib/common.mjs";
import { machineName } from "../shared/ids.mjs";
import { CLI_HOME, FILES_DIR, HOME } from "../shared/store.mjs";
import { keepPrivate, moveIntoCli } from "./cli-folder.mjs";
import { COMMANDS, FLAGS, plainOk, runCommand, save as saveLink } from "./commands.mjs";
import { ENROLL_FILE, enroll } from "./enroll.mjs";
import { stayUp } from "./crash.mjs";
import { createCli } from "./daemon.mjs";
import { watchInstall } from "./uninstall.mjs";
import { createUplink, epochOf, httpTransport } from "./uplink.mjs";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// The server this machine is logged in to, and its device token: AGENTBOOK_SERVER and AGENTBOOK_SERVER_TOKEN,
// else what `agentbook-cli login` saved (cli/device.json), else what `agentbook connect` saved before the split
// (hub.json). Null when it isn't logged in anywhere.
export function serverLink(home = HOME) {
  const url = process.env.AGENTBOOK_SERVER || process.env.AGENTBOOK_HUB;
  if (url) return { url, token: process.env.AGENTBOOK_SERVER_TOKEN || process.env.AGENTBOOK_HUB_TOKEN || "", name: null };
  for (const file of [path.join(home, "cli", "device.json"), path.join(home, "hub.json")]) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      const u = saved.server || saved.url;
      if (u && saved.token) return { url: u, token: saved.token, name: saved.name || null, local: !!saved.local };
    } catch {}
  }
  return null;
}

// The daemon. Not logged in, it looks for a login every few seconds (AGENTBOOK_LINK_POLL_MS), and connects then.
// However a server was given (agentbook-cli login, AGENTBOOK_SERVER, an old hub.json), one elsewhere gets this
// machine's token over HTTPS only, or on a tailnet.
function usable(l) {
  let u = null;
  try {
    u = new URL(l.url);
  } catch {}
  if (u && (u.protocol === "https:" || (u.protocol === "http:" && plainOk(u)))) return true;
  log(`not connecting to ${l.url}: a machine sends its token to a server elsewhere over HTTPS only, or on a tailnet (AGENTBOOK_ALLOW_HTTP=1 allows it anyway)`);
  return false;
}

// The plugin folder its sessions load, in dev mode, when it's started without being told (by a hook, after a
// reboot): the one `agentbook up` was given (cli/settings.json), if it's still there.
function savedPluginDir() {
  if (process.env.AGENTBOOK_PLUGIN_DIR) return;
  try {
    const dir = JSON.parse(fs.readFileSync(path.join(HOME, "cli", "settings.json"), "utf8")).plugin_dir;
    if (dir && fs.existsSync(path.join(dir, ".claude-plugin", "plugin.json"))) process.env.AGENTBOOK_PLUGIN_DIR = dir;
  } catch {}
}

// agentbook on this machine alone (agentbook up): its server runs beside this CLI, on loopback, from the same
// folder. When nothing listens on its port (after a reboot, or it stopped), it's started again, as the hooks start
// this CLI. One that's there but slow to answer (a loaded machine) is left be: another copy can't take its port.
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
function keepLocalServer(l) {
  let url;
  try {
    url = new URL(l.url);
  } catch {
    return;
  }
  const bin = path.join(REPO, "bin", "agentbook-server");
  if (!l.local || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !fs.existsSync(bin)) return;
  let tried = 0;
  const check = async () => {
    if (Date.now() - tried < 60e3) return;
    const down = await fetch(`${url.origin}/api/health`, { signal: AbortSignal.timeout(2000) }).then(
      () => false,
      (e) => e.cause?.code === "ECONNREFUSED",
    );
    if (!down) return;
    tried = Date.now();
    log(`agentbook-server isn't answering at ${url.origin}: starting it`);
    const out = openLog(SERVER_LOG());
    spawn("/bin/sh", [bin], { detached: true, stdio: ["ignore", out, out], env: { ...process.env, AGENTBOOK_SERVER_PORT: url.port || "80" } }).unref();
  };
  check();
  setInterval(check, 30e3).unref();
}

export async function runCli({ port = PORT, host = "127.0.0.1", linkPollMs = Number(process.env.AGENTBOOK_LINK_POLL_MS || 3000) } = {}) {
  // On a shared machine, everyone's agentbook-cli runs as them (seats.mjs). One running as root would run agents as root.
  if (process.platform === "linux" && process.getuid() === 0 && seatsIn()) throw new Error("This is a shared machine, where each person's agentbook-cli runs as them, never as root: agentbook-cli seat lists them.");
  const faults = stayUp({ log });
  // A machine agentbook-server made logs itself in from the file it was started with (enroll.mjs), before anything
  // else: it then starts as any machine that's logged in does. Before the port, so nothing's served meanwhile.
  await enroll({ home: HOME, linked: !!serverLink(), plainOk, save: saveLink, log }).catch((e) => log(`enroll: ${e.message}`));
  let link = null;
  let cli = null;
  function connect(l) {
    if (!usable(l)) return false;
    link = l;
    keepLocalServer(l);
    const transport = httpTransport({ url: l.url, token: l.token });
    // The server says whether anyone has the page open, with each answer to the long-poll.
    const uplink = createUplink({ store: cli.store, transport, info: cli.info, onCommand: cli.onCommand, onFresh: cli.fresh, historyFrom: cli.historyFrom, version: VERSION, onOwner: cli.setOwner, onPrefs: cli.setPrefs, onLatest: cli.setLatest, onConnect: cli.connected, clean: cli.clean, epoch: epochOf(cli.store), log });
    cli.setUplink(uplink, l.url);
    uplink.start();
    return true;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (await cli.handle(req, res, url)) return;
    // The page is the server's.
    if (req.method === "GET" && !url.pathname.startsWith("/api/") && link) {
      res.writeHead(302, { location: link.url.replace(/\/$/, "") + "/" });
      return res.end();
    }
    const error = link ? `This is agentbook-cli, for this machine's sessions. agentbook is at ${link.url}.` : "This is agentbook-cli, for this machine's sessions. It isn't logged in to an agentbook-server yet: run agentbook-cli login <server>, or agentbook up.";
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error }));
  });
  // DeepSeek Harness's plugin connects here (cli.upgrade); nothing else upgrades.
  server.on("upgrade", (req, socket, head) => cli.upgrade(req, socket, head));
  // The port first: several sessions can start this at once, and only the one that gets it goes on to touch its data.
  // Nothing's served before `cli` is there: this runs straight on from the listen, with no turn for a request between.
  await new Promise((resolve, reject) => {
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE") {
        console.error(`agentbook-cli: port ${port} is already in use. Is it already running?`);
        process.exit(0);
      }
      reject(err);
    });
    server.listen(port, host, resolve);
  });
  server.on("error", (e) => faults.report(e, "the local server"));
  // Its files from the top of agentbook's folder, into its own, before it opens its database.
  moveIntoCli({ home: HOME, filesDir: FILES_DIR, log });
  savedPluginDir();
  link = serverLink();
  if (link && !usable(link)) link = null;
  const machine = machineName(link?.name || process.env.AGENTBOOK_MACHINE || os.hostname().split(".")[0]);
  cli = createCli({ machine, faults });
  // Its folder only its person reads, its database (just opened, maybe just made) included.
  keepPrivate({ home: HOME, filesDir: FILES_DIR, log });
  console.log(`agentbook-cli is running at http://${host}:${port} as ${machine}, ${link ? `logged in to ${link.url}` : "not logged in to a server yet"}  (data in ${CLI_HOME})`);
  // Its plugin uninstalled: nothing would start it again, so nothing should keep it going.
  watchInstall({
    log,
    onGone() {
      log("its Claude Code plugin was uninstalled: stopping");
      process.kill(process.pid, "SIGTERM");
    },
  });
  // Its server first, so what starts knows where it reports to.
  if (link) connect(link);
  if (link || process.env.AGENTBOOK_START_UNLINKED) cli.start(); // that variable: the tests', which log in as they go
  if (!link) {
    let enrolling = false;
    const look = setInterval(() => {
      const l = serverLink();
      // A machine agentbook-server made, whose login file was written after this started: it logs in with it now, and
      // starts again as that machine (what keeps it running, systemd there, brings it back).
      if (!l && !enrolling && fs.existsSync(ENROLL_FILE())) {
        enrolling = true;
        enroll({ home: HOME, plainOk, save: saveLink, log })
          .then((saved) => {
            if (saved && process.env.AGENTBOOK_SUPERVISED === "1") process.kill(process.pid, "SIGTERM");
          })
          .catch((e) => log(`enroll: ${e.message}`))
          .finally(() => (enrolling = false));
      }
      if (!l) return;
      clearInterval(look);
      if (!connect(l)) return;
      cli.start();
      log(`logged in to ${l.url}`);
    }, linkPollMs);
  }
  return { cli, server };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const [first, ...rest] = process.argv.slice(2);
  const cmd = FLAGS[first] || first;
  const run = !cmd || cmd === "run" ? runCli() : COMMANDS.includes(cmd) ? runCommand([cmd, ...rest]).then((out) => out && console.log(out)) : Promise.reject(new Error(`there's no ${cmd} command. It has: run, ${COMMANDS.join(", ")}.`));
  run.catch((e) => {
    // The daemon's goes to cli.log, for whoever finds out why it didn't start.
    console.error(`agentbook-cli: ${!cmd || cmd === "run" ? e.stack : e.message}`);
    process.exit(1);
  });
}
