// Shared machines: one Linux machine with several people on it. Each has a Linux user, an agentbook-cli and logins of
// their own, and the code is shared. Run as root:
//
//   agentbook-cli seat add <name> [--machine <name>] [--no-start]   a person's seat: their Linux user, a port, and their
//                                                                    agentbook-cli under systemd
//   agentbook-cli seat login <name> <server> [login's options]      logs their agentbook-cli in as them; they approve it
//   agentbook-cli seat remove <name>                                 stops it, ends their processes, deletes their user and home
//   agentbook-cli seat [list]                                        the seats, their ports, and whether each is running
//   agentbook-cli seat share <name>                                  the machine is theirs to share: they add and take off
//                                                                    people from agentbook's page (seat-helper.mjs)
//   agentbook-cli seat claim <name> --machine <name> --enroll <file> a machine agentbook made in a cloud sandbox: its
//                                                                    owner's seat, logged in from the file the machine
//                                                                    was made with, and shared once it's logged in
//   agentbook-cli seat refresh                                       every seat's settings written again (after the
//                                                                    machine's tools changed)
//
// Each person's agentbook-cli is the same one every machine runs, run as them. Its key is in their home, which only
// they can read, so another person's process can reach its port but can't sign a call to it. It reads and runs only
// what they could. The only part of agentbook that runs as root is this command. The plan first had one agentbook-cli
// running as root for everyone. That one would have read everyone's transcripts and files as root, and run git as
// root in their folders. git run as root in a folder someone else can write does what that folder's config says.
//
// Nobody's agents get sudo or the docker group, the machine owner's included. A seat's user is in neither, and its
// agentbook-cli runs with NoNewPrivileges, so nothing it starts can gain privileges (sudo, su).
//
// The seats are listed in /etc/agentbook/seats.json. root owns it and everyone can read it. A session's hooks look up
// their person's agentbook-cli's port there by their uid (SEAT in lib/common.mjs).

import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PLUGIN_ROOT, SEATS_FILE, procSockets, seatsIn } from "../lib/common.mjs";
import { machineName, SEAT_RESERVED } from "../shared/ids.mjs";

// The comment on every Linux user agentbook made. It changes or deletes only users that carry it.
export const MARK = "agentbook seat";
const UNIT = "agentbook-cli@.service";
const PORTS = [4321, 4399];
// Groups that amount to root, or that read other people's files and logs. A seat's user is in none of them.
export const PRIVILEGED = ["root", "sudo", "admin", "wheel", "docker", "lxd", "incus", "libvirt", "disk", "shadow", "adm", "systemd-journal"];
// Names that are the machine's own on most Linuxes. Linux users not made by agentbook are refused anyway; this list
// just gives a clearer message for the common ones.
const RESERVED = new Set(SEAT_RESERVED);

const etc = (file = SEATS_FILE) => path.dirname(file);
const envFile = (name, file = SEATS_FILE) => path.join(etc(file), "seats", `${name}.env`);
const unitDir = () => process.env.AGENTBOOK_SYSTEMD_DIR || "/etc/systemd/system";

// A Linux user name for a person: their agentbook username, if it is one.
export function checkName(name) {
  const n = String(name || "").trim();
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(n)) throw new Error(`"${n}" can't be a Linux user's name: lowercase letters, digits, - and _, starting with a letter, at most 32.`);
  if (RESERVED.has(n)) throw new Error(`${n} is a name this machine has for itself. Pick another.`);
  return n;
}

// /etc/passwd's line for a user: { name, uid, gid, gecos, home, shell }, or null.
export function parsePasswd(line) {
  const f = String(line || "").trim().split(":");
  if (f.length < 7) return null;
  return { name: f[0], uid: Number(f[2]), gid: Number(f[3]), gecos: f[4], home: f[5], shell: f[6] };
}

// The first port in 4321-4399 that no seat has and nothing listens on.
export function pickPort(seats, listening = () => false) {
  const taken = new Set(Object.values(seats || {}).map((s) => s.port));
  for (let p = PORTS[0]; p <= PORTS[1]; p++) if (!taken.has(p) && !listening(p)) return p;
  throw new Error(`Every port from ${PORTS[0]} to ${PORTS[1]} is taken. Remove a seat first.`);
}

// What systemd runs each person's agentbook-cli with: as them, with nothing gaining privileges. KillMode=process,
// because what it starts must outlive a restart of it: Claude Code's sessions, the threads' shells. Its settings, each
// file over the ones before it: the machine's own for every shell (/etc/environment), what a machine agentbook made
// has for everyone (cli.env: which agents; image.env: its image's settings), the machine's for its seats, and the
// seat's own.
export const unitText = ({ node, plugin, file = SEATS_FILE }) => `# agentbook-cli for one person on a shared machine, as them (agentbook-cli seat add <name>).
[Unit]
Description=agentbook-cli for %i
After=network-online.target
Wants=network-online.target

[Service]
User=%i
Group=%i
WorkingDirectory=~
EnvironmentFile=-/etc/environment
EnvironmentFile=-${path.join(etc(file), "cli.env")}
EnvironmentFile=-${path.join(etc(file), "image.env")}
EnvironmentFile=-${path.join(etc(file), "seats.env")}
EnvironmentFile=${path.join(etc(file), "seats")}/%i.env
Environment=AGENTBOOK_SUPERVISED=1
ExecStart=${node} ${path.join(plugin, "cli", "main.mjs")} run
Restart=always
RestartSec=3
KillMode=process
NoNewPrivileges=yes
UMask=0002

[Install]
WantedBy=multi-user.target
`;

// Where the machine's tools are, for everyone on it: the folders root wrote in tools.path, one line, ":" between
// them. A machine agentbook made keeps its image's tools in its first user's home (the Node every shell gets, uv,
// cargo), and that user's PATH is written there as its image is set up. Only root's own file counts, and only whole
// paths: what's in it runs as every person on the machine.
export const toolsFile = (file = SEATS_FILE) => path.join(etc(file), "tools.path");
export function toolsPath(file = SEATS_FILE, { stat = fs.statSync } = {}) {
  try {
    const f = toolsFile(file);
    if (!process.env.AGENTBOOK_SEATS_FILE) {
      const st = stat(f);
      if (st.uid !== 0 || st.mode & 0o022) return [];
    }
    return fs.readFileSync(f, "utf8").trim().split(":").filter((d) => /^\/[\w@%+=,.\/-]{1,300}$/.test(d) && !d.split("/").includes("..")).slice(0, 60);
  } catch {
    return [];
  }
}
// A seat's PATH: Claude Code's own installer puts it in ~/.local/bin, where what they install themselves goes too
// (and cargo's in ~/.cargo/bin), then the machine's tools (`tools`), then the Node its agentbook-cli runs on.
export const pathFor = ({ home, node, tools = [] }) => [path.join(home, ".local", "bin"), path.join(home, ".cargo", "bin"), ...tools, path.dirname(node), "/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"].filter((d, i, a) => a.indexOf(d) === i).join(":");
// Each seat's own settings, written by seat add. They hold no secrets, so they can stay readable. What's the same for
// everyone on the machine and seat add doesn't write (AGENTBOOK_OPENCLAW=0) goes in seats.env beside them.
export const envText = ({ machine, plugin, node, home, tools = [], rustup = rustupIn(tools) }) => [`AGENTBOOK_MACHINE=${machine}`, `AGENTBOOK_PLUGIN_DIR=${plugin}`, `PATH=${pathFor({ home, node, tools })}`, ...installEnv({ home, rustup }), ""].join("\n");
// Nobody on a shared machine has sudo, and the machine's tools aren't theirs to change. So what a person's agents
// install goes into their own home, where nobody else's sessions run it: `npm install -g` (its prefix is ~/.local,
// so its commands land in ~/.local/bin), `go install` (there too), `cargo install` (~/.cargo/bin; the compiler
// itself stays the machine's, read through RUSTUP_HOME). uv, pipx and pip --user go to ~/.local on their own.
// What needs root (an apt package, a service) comes through the machine's image.
export const installEnv = ({ home, rustup = null }) => [`NPM_CONFIG_PREFIX=${path.join(home, ".local")}`, `GOBIN=${path.join(home, ".local", "bin")}`, `CARGO_HOME=${path.join(home, ".cargo")}`, ...(rustup ? [`RUSTUP_HOME=${rustup}`] : [])];
// The machine's Rust toolchains, when its tools have cargo: beside its .cargo, as rustup lays them out.
export function rustupIn(tools = [], { exists = fs.existsSync } = {}) {
  for (const d of tools) {
    if (!d.endsWith("/.cargo/bin")) continue;
    const r = path.join(path.dirname(path.dirname(d)), ".rustup");
    if (exists(r)) return r;
  }
  return null;
}

// The code every seat's agentbook-cli runs, and the Node it runs on, must be changeable by root alone: anyone else who
// can change them could run anything as every person on the machine. -> why not, or null
export function unsafeCode(p, { lstat = fs.lstatSync, realpath = fs.realpathSync } = {}) {
  let at;
  try {
    at = realpath(p);
  } catch {
    return `${p} isn't there.`;
  }
  if (/\s/.test(at)) return `${at} has a space in it, which systemd's ExecStart can't take.`;
  for (let d = at; ; d = path.dirname(d)) {
    const st = lstat(d);
    if (st.uid !== 0) return `${d} isn't root's, so whoever owns it could change what every seat runs. Put agentbook and Node where only root can change them (/usr/lib/agentbook, say: some machines give /opt and /usr/local to a user), and run this from there.`;
    if (st.mode & 0o022 && !(st.isDirectory() && st.mode & 0o1000 && d !== at)) return `${d} can be changed by others than root, so they could change what every seat runs.`;
    if (d === path.dirname(d)) return null;
  }
}

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const real = {
  passwd: (name) => {
    try {
      return parsePasswd(execFileSync("getent", ["passwd", name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    } catch {
      return null;
    }
  },
  groupsOf: (name) => sh("id", ["-nG", name]).trim().split(/\s+/).filter(Boolean),
  run: sh,
  systemd: () => fs.existsSync("/run/systemd/system"),
  listening: (port) => procSockets(readNet(), port).length > 0,
  ownedListener: (port, uid) => procSockets(readNet(), port).some((s) => s.uid === uid),
};
function readNet() {
  return ["/proc/net/tcp", "/proc/net/tcp6"].map((f) => {
    try {
      return fs.readFileSync(f, "utf8");
    } catch {
      return "";
    }
  }).join("\n");
}

function mustBeRoot() {
  if (process.platform !== "linux") throw new Error("Seats are for a shared Linux machine. A Mac has one person, as it does now.");
  if (process.getuid() !== 0) throw new Error("Only root adds or removes seats: run it with sudo.");
}

// What's on this machine: { machine, seats: { name: { uid, port, added } } }.
export const readSeats = (file = SEATS_FILE) => seatsIn(file) || { machine: null, seats: {} };
export function writeSeats(all, file = SEATS_FILE) {
  fs.mkdirSync(etc(file), { recursive: true, mode: 0o755 });
  const tmp = `${file}.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ machine: all.machine, seats: all.seats }, null, 2) + "\n", { mode: 0o644 });
  fs.renameSync(tmp, file);
}

// A seat for `name`: their Linux user (made if there's none), out of every privileged group, with a home only they can
// read; a port of their own; and their agentbook-cli under systemd, as them. Run again, it keeps their port and makes
// sure of the rest. -> what it did, and what's next
export function addSeat(name, { machine, start = true, plugin = PLUGIN_ROOT, node = process.execPath, file = SEATS_FILE, sys = real } = {}) {
  mustBeRoot();
  name = checkName(name);
  const all = readSeats(file);
  const as = machineName(machine || all.machine || os.hostname().split(".")[0]);
  if (all.machine && as !== all.machine) throw new Error(`Everyone on this machine is on ${all.machine}: it's one machine, with one name. Leave --machine out.`);
  for (const p of [plugin, node]) {
    const why = unsafeCode(p);
    if (why) throw new Error(why);
  }
  let pw = sys.passwd(name);
  if (pw && pw.gecos !== MARK) throw new Error(`${name} is a Linux user agentbook didn't make, so agentbook leaves it alone. Pick another name.`);
  const made = !pw;
  if (made) {
    sys.run("useradd", ["--create-home", "--user-group", "--shell", "/bin/bash", "--comment", MARK, name]);
    pw = sys.passwd(name);
    if (!pw) throw new Error(`useradd said nothing went wrong, but there's no ${name} now.`);
  }
  fs.chmodSync(pw.home, 0o700);
  const dropped = sys.groupsOf(name).filter((g) => PRIVILEGED.includes(g) && g !== name);
  for (const g of dropped) sys.run("gpasswd", ["--delete", name, g]);
  // As they'll run it: their agentbook-cli is this Node and this plugin, as them.
  const main = path.join(plugin, "cli", "main.mjs");
  const tried = spawnSync(node, ["-e", `require("fs").accessSync(${JSON.stringify(main)}, require("fs").constants.R_OK)`], { uid: pw.uid, gid: pw.gid, cwd: pw.home, env: { HOME: pw.home, PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 15000 });
  if (tried.status !== 0) throw new Error(`${name} can't run ${node} or read ${main}: ${String(tried.stderr || tried.error?.message || "").trim().split("\n")[0]}`);
  const port = all.seats[name]?.port || pickPort(all.seats, sys.listening);
  all.machine = as;
  all.seats[name] = { uid: pw.uid, port, added: all.seats[name]?.added || new Date().toISOString() };
  writeSeats(all, file);
  fs.mkdirSync(path.dirname(envFile(name, file)), { recursive: true, mode: 0o755 });
  const tools = toolsPath(file);
  fs.writeFileSync(envFile(name, file), envText({ machine: as, plugin, node, home: pw.home, tools }), { mode: 0o644 });
  fs.writeFileSync(path.join(unitDir(), UNIT), unitText({ node, plugin, file }), { mode: 0o644 });
  const running = start && sys.systemd();
  if (running) {
    sys.run("systemctl", ["daemon-reload"]);
    sys.run("systemctl", ["enable", "--now", `agentbook-cli@${name}`]);
  }
  const claude = spawnSync("/bin/sh", ["-c", "command -v claude"], { uid: pw.uid, gid: pw.gid, cwd: pw.home, env: { HOME: pw.home, PATH: pathFor({ home: pw.home, node, tools }) }, encoding: "utf8", timeout: 10000 });
  return [
    `${made ? "Made" : "Kept"} ${name}'s seat on ${as}: Linux user ${name} (uid ${pw.uid}), home ${pw.home} only they can read, agentbook-cli on port ${port}.`,
    dropped.length ? `Took ${name} out of ${dropped.join(", ")}: no seat's agents get root.` : null,
    running ? `Their agentbook-cli runs as agentbook-cli@${name}.` : start ? "There's no systemd here, so nothing runs their agentbook-cli yet." : "Not started (--no-start).",
    claude.status === 0 ? null : `${name} has no claude command yet. Install Claude Code as them, or where everyone has it, before they start a thread.`,
    `Next, log it in as them, and they approve it: agentbook-cli seat login ${name} <server>`,
  ].filter(Boolean).join("\n");
}

// Every seat's settings and the unit they run under, written again: after the machine's tools moved (tools.path), or
// agentbook's code did. Nobody's Linux user, port or login changes, and nothing's restarted.
export function refreshSeats({ plugin = PLUGIN_ROOT, node = process.execPath, file = SEATS_FILE, sys = real } = {}) {
  mustBeRoot();
  const all = readSeats(file);
  const names = Object.keys(all.seats).sort();
  if (!names.length) return "No seats on this machine.";
  for (const p of [plugin, node]) {
    const why = unsafeCode(p);
    if (why) throw new Error(why);
  }
  const tools = toolsPath(file);
  const done = [];
  for (const name of names) {
    const pw = sys.passwd(name);
    if (!pw || pw.gecos !== MARK) continue;
    fs.writeFileSync(envFile(name, file), envText({ machine: all.machine, plugin, node, home: pw.home, tools }), { mode: 0o644 });
    done.push(name);
  }
  fs.writeFileSync(path.join(unitDir(), UNIT), unitText({ node, plugin, file }), { mode: 0o644 });
  return `Wrote the settings of ${done.join(", ") || "nobody"} again. They count from each one's next start.`;
}

// A shared machine's code lives in /work, not in anyone's home: owned by a group every seat on it is in, with folders
// that pass the group on (setgid), so what one person's agent makes another's can change. Each seat's git is told
// so (core.sharedRepository), takes repos others own files in as safe (safe.directory "*": the git on Ubuntu 24.04
// knows no pattern narrower than that for a folder's children), and runs no repo's hooks: a hook someone else wrote
// would run as whoever commits.
export const WORK_DIR = () => process.env.AGENTBOOK_WORK_DIR || "/work";
export const WORK_GROUP = "agentbook-work";
export function makeWork({ sys = real } = {}) {
  mustBeRoot();
  sys.run("groupadd", ["--force", WORK_GROUP]);
  const dir = WORK_DIR();
  fs.mkdirSync(dir, { recursive: true });
  sys.run("chown", [`root:${WORK_GROUP}`, dir]);
  fs.chmodSync(dir, 0o2775);
  return dir;
}
// A seat's person works in /work: in its group, with their git set up for it. `pw`: their passwd entry.
export function joinWork(name, { sys = real } = {}) {
  mustBeRoot();
  const pw = sys.passwd(name);
  if (!pw || pw.gecos !== MARK) throw new Error(`${name} isn't a seat agentbook made.`);
  sys.run("usermod", ["--append", "--groups", WORK_GROUP, name]);
  const hooks = path.join(pw.home, ".agentbook-no-hooks");
  const as = { uid: pw.uid, gid: pw.gid, cwd: pw.home, env: { HOME: pw.home, PATH: "/usr/local/bin:/usr/bin:/bin" }, encoding: "utf8", timeout: 15000 };
  spawnSync("mkdir", ["-p", hooks], as);
  for (const [k, v] of [["core.sharedRepository", "group"], ["core.hooksPath", hooks], ["safe.directory", "*"]]) {
    const r = spawnSync("git", ["config", "--global", "--replace-all", k, v], as);
    if (r.status !== 0) throw new Error(`Couldn't set ${name}'s git up for ${WORK_DIR()}: ${String(r.stderr || r.error?.message || "").trim().split("\n")[0]}`);
  }
  return `${name} works in ${WORK_DIR()} with everyone on this machine.`;
}

// Every process of a user's, ended: what removing their seat leaves running. Never root's.
function endAll(uid) {
  if (!(uid > 0)) return;
  for (let round = 0; round < 10; round++) {
    let left = 0;
    for (const pid of fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
      try {
        const m = /^Uid:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"));
        if (Number(m?.[1]) !== uid) continue;
        left++;
        process.kill(Number(pid), "SIGKILL");
      } catch {}
    }
    if (!left) return;
    spawnSync("sleep", ["0.2"]);
  }
}

// A seat gone: its agentbook-cli stopped, every process of theirs ended, their Linux user and home deleted with every
// credential in them. Their threads stay on agentbook, ended.
export function removeSeat(name, { file = SEATS_FILE, sys = real } = {}) {
  mustBeRoot();
  name = checkName(name);
  const all = readSeats(file);
  if (!all.seats[name]) throw new Error(`${name} has no seat here.`);
  const pw = sys.passwd(name);
  if (pw && pw.gecos !== MARK) throw new Error(`${name} is a Linux user agentbook didn't make, so agentbook leaves it alone.`);
  if (sys.systemd()) {
    try {
      sys.run("systemctl", ["disable", "--now", `agentbook-cli@${name}`]);
    } catch {}
  }
  if (pw) {
    endAll(pw.uid);
    sys.run("userdel", ["--remove", name]);
  }
  delete all.seats[name];
  writeSeats(all, file);
  fs.rmSync(envFile(name, file), { force: true });
  return `Removed ${name}'s seat: their agentbook-cli stopped, and their Linux user and home are deleted.`;
}

// The seats, with whether each one's agentbook-cli is running.
export function listSeats({ file = SEATS_FILE, sys = real } = {}) {
  const all = readSeats(file);
  const names = Object.keys(all.seats).sort();
  if (!names.length) return "No seats on this machine. agentbook-cli seat add <name> makes one.";
  const rows = names.map((n) => {
    const s = all.seats[n];
    return `  ${n.padEnd(16)} port ${s.port}  ${sys.ownedListener(s.port, s.uid) ? "running" : "not running"}`;
  });
  return [`${all.machine}, shared:`, ...rows].join("\n");
}

// Their agentbook-cli logged in as them: login's code goes to whoever ran this, for the person to approve with their own
// passkey. systemd keeps it running, so login only restarts it (AGENTBOOK_SUPERVISED).
export function seatLogin(name, args, { file = SEATS_FILE, plugin = PLUGIN_ROOT, node = process.execPath, sys = real } = {}) {
  mustBeRoot();
  name = checkName(name);
  const all = readSeats(file);
  const s = all.seats[name];
  const pw = s && sys.passwd(name);
  if (!pw || pw.gecos !== MARK) throw new Error(`${name} has no seat here. agentbook-cli seat add ${name} first.`);
  if (!args.length) throw new Error(`Which server? agentbook-cli seat login ${name} <server>`);
  const env = { HOME: pw.home, USER: name, LOGNAME: name, SHELL: pw.shell, LANG: process.env.LANG || "C.UTF-8", AGENTBOOK_SUPERVISED: "1", AGENTBOOK_MACHINE: all.machine, AGENTBOOK_PLUGIN_DIR: plugin, PATH: pathFor({ home: pw.home, node, tools: toolsPath(file) }) };
  const child = spawn(node, [path.join(plugin, "cli", "main.mjs"), "login", ...args, ...(args.includes("--name") ? [] : ["--name", all.machine])], { uid: pw.uid, gid: pw.gid, cwd: pw.home, env, stdio: "inherit" });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve("") : reject(new Error(`Logging ${name} in didn't finish (exit ${code}).`))));
  });
}

export async function seatCommand([sub = "list", name, ...rest]) {
  const flag = (f) => rest.includes(f);
  const value = (f) => (rest.includes(f) ? rest[rest.indexOf(f) + 1] : undefined);
  switch (sub) {
    case "list":
      return listSeats();
    case "add":
      return addSeat(name, { machine: value("--machine"), start: !flag("--no-start") });
    case "remove":
      return removeSeat(name);
    case "login":
      return seatLogin(name, rest);
    // Sharing the machine: its owner then adds and takes off people from agentbook's page (seat-helper.mjs).
    case "share":
      return (await import("./seat-helper.mjs")).shareBox(name, { plugin: PLUGIN_ROOT, run: sh, start: !flag("--no-start") });
    case "serve":
      return (await import("./seat-helper.mjs")).serve({ once: name === "--once" || flag("--once") });
    // A machine agentbook made: its owner's seat, logged in from the file it was made with, and shared.
    case "claim":
      return (await import("./seat-helper.mjs")).claimBox(name, { machine: value("--machine"), enroll: value("--enroll"), admin: value("--admin") || process.env.SUDO_USER || null, plugin: PLUGIN_ROOT, run: sh, start: !flag("--no-start") });
    case "refresh":
      return refreshSeats();
  }
  throw new Error(`agentbook-cli seat ${sub}? It has: add, login, remove, list, share, claim, refresh, serve.`);
}
