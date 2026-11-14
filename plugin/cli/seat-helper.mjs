// The root half of sharing a machine. A shared machine's
// owner adds and takes off people from agentbook's page; each is a seat here: a Linux user, and their own
// agentbook-cli (seats.mjs). Making and deleting Linux users takes root, and nobody's agentbook-cli runs as root, the
// owner's included. So root runs this one small helper, and it does two things only, for the machine's owner only:
//
//   members.change   add someone's seat, when the owner's passkey signed it (checked here, against the keys root
//                    wrote down when the machine was shared, not against what any agentbook-cli says); or remove
//                    one, which needs no signature, as taking something away doesn't. Never the owner's own seat.
//   members.enroll   put a login agentbook-server made for a member into their seat's home, where their own
//                    agentbook-cli picks it up (enroll.mjs). Only for a seat that exists, and only for this
//                    machine's own server.
//   cloud.setup      on a machine agentbook made in a cloud sandbox: run a newer version of its image's script, as the
//                    sandbox's own first user (who has sudo; no seat does). Only the whole command as the owner's
//                    passkey signed it, checked here, and once.
//   keys.change      the owner added or took off a passkey: the same signed change their own agentbook-cli takes,
//                    checked here against the keys kept here, so the helper goes by the passkeys they have now.
//
// The owner's agentbook-cli asks by dropping a file in the spool, a folder only the owner's Linux user (and root)
// can write: /var/lib/agentbook/spool/<id>.json. The helper takes only regular files that user owns, answers in
// <id>.out, and removes the request. Nothing else reaches it: no socket, no port.
//
//   agentbook-cli seat share <owner's seat> [--no-start]   root, once: writes down the owner's passkeys and server
//                                             (/etc/agentbook/box.json), makes the spool, and has systemd run the helper
//   agentbook-cli seat claim <owner> --machine <name> --enroll <file>   root, as a machine agentbook made sets
//                                             itself up: the owner's seat, its login, /work, the spool and the helper,
//                                             and the owner's passkeys, which came in that file with the login
//   agentbook-cli seat serve [--once]         the helper (what systemd runs)

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SEATS_FILE } from "../lib/common.mjs";
import { assertionRefusal, digestOf, isKey } from "../shared/signed.mjs";
import { MARK, addSeat, checkName, joinWork, makeWork, readSeats, removeSeat } from "./seats.mjs";
import { changeRefusal, pinOf, signatureRefusal } from "./signatures.mjs";

export const BOX_FILE = (file = SEATS_FILE) => path.join(path.dirname(file), "box.json");
export const SPOOL = () => process.env.AGENTBOOK_SEATS_SPOOL || "/var/lib/agentbook/spool";
// Who a machine agentbook made has its image installed as, kept by claim for a machine it couldn't share yet.
const ADMIN_FILE = (file = SEATS_FILE) => path.join(path.dirname(file), "admin");
// Where an Update's script writes how it goes, beside the spool: the owner's agentbook-cli reads it (nobody else's).
export const SETUP_LOG = (spool = SPOOL()) => path.join(path.dirname(spool), "setup.log");
const SETUP_UNIT = "agentbook-setup";
const HELPER_UNIT = "agentbook-seats.service";
// A signed add may wait for a machine that's off, a day at most; and a few minutes ahead, for clocks that differ.
const OLDEST_MS = 24 * 3600e3;
const AHEAD_MS = 5 * 60e3;
const MAX_BYTES = 256 * 1024;

// What root wrote down when the machine was shared: { owner (their seat), machine, server, keys, origin, rp_id,
// seen: { user: when their latest change was signed } }. Null when it isn't shared, or the file isn't root's.
// On a machine agentbook made, also: gate (the machine's id in what its owner signs), admin (the sandbox's own
// first user, who its image's script runs as) and ran ({ cid: expires } of the updates that ran).
export function readBox(file = SEATS_FILE, { stat = fs.statSync } = {}) {
  try {
    const f = BOX_FILE(file);
    if (!process.env.AGENTBOOK_SEATS_FILE) {
      const st = stat(f);
      if (st.uid !== 0 || st.mode & 0o022) return null;
    }
    const b = JSON.parse(fs.readFileSync(f, "utf8"));
    return b && typeof b.owner === "string" && Array.isArray(b.keys) ? { ...b, seen: b.seen || {}, ran: b.ran || {} } : null;
  } catch {
    return null;
  }
}

function writeBox(box, file = SEATS_FILE) {
  const f = BOX_FILE(file);
  fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o755 });
  fs.writeFileSync(`${f}.${process.pid}`, JSON.stringify(box, null, 2) + "\n", { mode: 0o644 });
  fs.renameSync(`${f}.${process.pid}`, f);
}

// One request, done or refused: { ok: true, ... } or { error }. `box`: readBox(). `deps`: what touches the machine
// (the tests' stand-ins): add(name), remove(name), passwd(name), putEnroll(pw, text), restart(name), setup(admin,
// script, owner).
export function handle(req, box, { file = SEATS_FILE, now = Date.now(), deps } = {}) {
  if (!box) return { error: "This machine isn't shared: root runs agentbook-cli seat share <owner's seat> first." };
  // The owner's passkeys changed: the change they signed with one the helper keeps, newer than the last it took.
  if (req?.kind === "keys.change") {
    const why = changeRefusal(req.change, { keys: box.keys, origin: box.origin, rpId: box.rp_id, since: box.keys_at || null });
    if (why) return { error: `Only this machine's owner changes the passkeys it goes by, and this wasn't theirs: ${why}.` };
    const e = req.change.envelope;
    const add = e.add.filter(isKey).map(({ id, alg, spki }) => ({ id, alg, spki }));
    box.keys = [...box.keys.filter((k) => !e.remove.includes(k.id) && !add.some((a) => a.id === k.id)), ...add];
    box.keys_at = e.at;
    writeBox(box, file);
    return { ok: true, keys: box.keys.length };
  }
  if (req?.kind === "cloud.setup") {
    const c = req.command;
    if (!box.admin || !box.gate) return { error: "This machine isn't one agentbook made in a cloud sandbox, so no image's script runs on it." };
    if (!c || typeof c !== "object" || c.kind !== "cloud.setup" || typeof c.args?.script !== "string" || !c.args.script || typeof c.cid !== "string") return { error: "That isn't an update of this machine." };
    const why = signatureRefusal(c, { keys: box.keys, origin: box.origin, rpId: box.rp_id, machine: box.gate, now });
    if (why) return { error: `Only this machine's owner updates it, and this wasn't theirs: ${why}.` };
    if (box.ran[c.cid]) return { error: "That update ran already. Update it again from its page." };
    for (const [cid, until] of Object.entries(box.ran)) if (!(Date.parse(until) > now)) delete box.ran[cid];
    box.ran[c.cid] = c.expires;
    writeBox(box, file);
    try {
      deps.setup(box.admin, c.args.script, box.owner);
    } catch (err) {
      return { error: err.message };
    }
    return { ok: true, started: true, v: Number(c.args.v) || 0 };
  }
  if (req?.kind === "members.change") {
    const e = req.change?.envelope;
    if (!e || typeof e !== "object" || e.kind !== "members.change" || e.v !== 1) return { error: "That isn't a change of who's on this machine." };
    if (e.machine !== box.machine) return { error: `It's for ${String(e.machine).slice(0, 80)}, not for ${box.machine}.` };
    let user;
    try {
      user = checkName(e.user);
    } catch (err) {
      return { error: err.message };
    }
    if (user === box.owner) return { error: `${user} owns this machine: their seat isn't added or removed from the page.` };
    const at = Date.parse(e.at || "");
    if (e.remove === true) {
      // Taking someone off needs no signature. When it happened counts, so an add signed before it that arrives
      // after it (held while the machine was off) doesn't put them back.
      const seen = Math.max(Date.parse(box.seen[user] || "") || 0, Math.min(Number.isFinite(at) ? at : now, now + AHEAD_MS));
      box.seen[user] = new Date(seen).toISOString();
      writeBox(box, file);
      if (!readSeats(file).seats[user]) return { ok: true, removed: false };
      try {
        deps.remove(user);
      } catch (err) {
        return { error: err.message };
      }
      return { ok: true, removed: true };
    }
    if (!Number.isFinite(at) || at > now + AHEAD_MS || at < now - OLDEST_MS) return { error: "It was signed too long ago, or for a time that hasn't come. Add them again from the page." };
    if (at < (Date.parse(box.seen[user] || "") || 0)) return { error: "A later change of theirs is here already. Add them again from the page." };
    const why = assertionRefusal(e, req.change.sig, { keys: box.keys, origin: box.origin, rpId: box.rp_id });
    if (why) return { error: `Only this machine's owner adds people to it, and this wasn't theirs: ${why}.` };
    let said;
    try {
      said = deps.add(user);
    } catch (err) {
      return { error: err.message };
    }
    box.seen[user] = new Date(at).toISOString();
    writeBox(box, file);
    return { ok: true, added: true, port: readSeats(file).seats[user]?.port || null, said: String(said || "").split("\n")[0] };
  }
  if (req?.kind === "members.enroll") {
    let user;
    try {
      user = checkName(req.user);
    } catch (err) {
      return { error: err.message };
    }
    if (user === box.owner) return { error: `${user} owns this machine, and logs in themselves.` };
    const pw = readSeats(file).seats[user] ? deps.passwd(user) : null;
    if (!pw || pw.gecos !== MARK) return { error: `${user} has no seat here yet.` };
    const poll = req.enroll?.poll;
    if (typeof poll !== "string" || !poll || poll.length > 400 || !box.server) return { error: "That isn't a login agentbook-server made for this machine." };
    // Its server is this machine's own, as root wrote it down: never one the request names.
    try {
      deps.putEnroll(pw, JSON.stringify({ server: box.server, name: String(req.enroll.name || "").slice(0, 80), poll }));
      deps.restart(user);
    } catch (err) {
      return { error: err.message };
    }
    return { ok: true, enrolled: true };
  }
  return { error: "The seats helper adds a seat, removes one, or hands a seat its login. Nothing else." };
}

const realDeps = (file) => ({
  // Their seat, and their place in the code everyone on the machine shares.
  add(name) {
    const said = addSeat(name, { file });
    joinWork(name);
    return said;
  },
  remove: (name) => removeSeat(name, { file }),
  passwd: (name) => {
    const line = fs.readFileSync("/etc/passwd", "utf8").split("\n").find((l) => l.startsWith(`${name}:`));
    const f = String(line || "").split(":");
    return f.length < 7 ? null : { name: f[0], uid: Number(f[2]), gid: Number(f[3]), gecos: f[4], home: f[5], shell: f[6] };
  },
  // Theirs alone, and never through a link someone left in their home.
  putEnroll(pw, text) {
    const f = path.join(pw.home, ".agentbook-enroll");
    fs.rmSync(f, { force: true });
    fs.writeFileSync(f, text, { mode: 0o600, flag: "wx" });
    fs.chownSync(f, pw.uid, pw.gid);
  },
  restart(name) {
    if (!fs.existsSync("/run/systemd/system")) return;
    spawnSync("systemctl", ["restart", `agentbook-cli@${name}`], { stdio: "ignore" });
  },
  // The image's script, as the sandbox's own first user, in a job of its own that outlives this helper (the script
  // ends by starting every seat's agentbook-cli again, and this). Its file is that user's alone; its log, theirs to
  // write and the owner's seat's to read.
  setup(admin, script, owner) {
    const pw = this.passwd(admin);
    const seat = this.passwd(owner);
    if (!pw || !(pw.uid > 0) || pw.gecos === MARK) throw new Error(`${admin}, who this machine's image is installed as, isn't a user here any more.`);
    const dir = path.dirname(SPOOL());
    const file_ = path.join(dir, "setup.sh");
    const logf = SETUP_LOG();
    const fresh = (f, text, mode, uid, gid) => {
      fs.rmSync(f, { force: true });
      fs.writeFileSync(f, text, { mode, flag: "wx" });
      fs.chownSync(f, uid, gid);
      fs.chmodSync(f, mode);
    };
    fresh(file_, script, 0o700, pw.uid, pw.gid);
    fresh(logf, "", 0o640, pw.uid, seat?.gid ?? pw.gid);
    const env = { HOME: pw.home, USER: admin, LOGNAME: admin, SHELL: pw.shell || "/bin/bash", AGENTBOOK_BUILD_LOG: logf };
    if (fs.existsSync("/run/systemd/system")) {
      const r = spawnSync("systemd-run", ["--collect", "--quiet", `--unit=${SETUP_UNIT}`, "-p", `User=${admin}`, "-p", `WorkingDirectory=${pw.home}`, ...Object.entries(env).map(([k, v]) => `--setenv=${k}=${v}`), "/bin/bash", file_], { encoding: "utf8", timeout: 20000 });
      if (r.status !== 0) throw new Error(/already (exists|loaded)|fragment file/i.test(r.stderr || "") ? "It's being updated already." : `Couldn't start its script: ${String(r.stderr || r.error?.message || "").trim().split("\n")[0]}`);
      return;
    }
    const child = spawn("/bin/bash", [file_], { uid: pw.uid, gid: pw.gid, cwd: pw.home, env: { ...env, PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" }, detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  },
});

// The spool is a folder its owner's Linux user writes, and this runs as root: so nothing in it is followed. A request
// is opened without following a link, and what was opened is what's checked (a regular file of the owner's, not too
// big) and read: a name swapped for a link to a file only root reads, between a look and the read, gets nothing. What
// isn't a request says no more than that, so nothing of a file is ever quoted back.
function readRequest(f, uid) {
  let fd = null;
  try {
    fd = fs.openSync(f, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.uid !== uid || st.size > MAX_BYTES) return null;
    const req = JSON.parse(fs.readFileSync(fd, "utf8"));
    return req && typeof req === "object" ? req : null;
  } catch {
    return null;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}
// Its answer is a new file, made only if nothing is at that name: a link left there (to a file of root's, for root
// to overwrite) is removed, never written through, and one put back in the moment between isn't followed either.
function writeReply(f, out) {
  try {
    fs.rmSync(f, { force: true });
    const fd = fs.openSync(f, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o644);
    try {
      fs.writeFileSync(fd, JSON.stringify(out));
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
}
// Every request waiting in the spool, each answered once. Only regular files the owner's Linux user owns are taken.
export function drain({ file = SEATS_FILE, spool = SPOOL(), deps = realDeps(file), ownerUid = null, log = () => {} } = {}) {
  const box = readBox(file);
  const uid = ownerUid ?? (box ? readSeats(file).seats[box.owner]?.uid : null);
  let n = 0;
  let names = [];
  try {
    names = fs.readdirSync(spool).filter((f) => /^[\w-]{1,80}\.json$/.test(f));
  } catch {
    return 0;
  }
  for (const name of names) {
    const f = path.join(spool, name);
    let out;
    const req = readRequest(f, uid);
    if (!req) out = { error: "It isn't a request of this machine's owner." };
    else {
      try {
        out = handle(req, box, { file, deps });
      } catch (e) {
        out = { error: e.message };
      }
    }
    fs.rmSync(f, { force: true });
    writeReply(f.replace(/\.json$/, ".out"), out);
    log(`seats: ${name.replace(/\.json$/, "")}: ${out.error ? `refused: ${out.error}` : JSON.stringify(out)}`);
    n++;
  }
  return n;
}

// What systemd runs as root: the spool, drained as requests arrive (and once as it starts).
export async function serve({ once = false, file = SEATS_FILE, spool = SPOOL(), log = (m) => console.log(new Date().toISOString().slice(11, 19), m) } = {}) {
  if (process.platform !== "linux" || process.getuid() !== 0) throw new Error("The seats helper is for a shared Linux machine, and runs as root.");
  drain({ file, spool, log });
  if (once) return "";
  log(`seats: watching ${spool}`);
  let busy = false;
  const go = () => {
    if (busy) return;
    busy = true;
    setTimeout(() => {
      busy = false;
      drain({ file, spool, log });
    }, 150);
  };
  fs.watch(spool, go);
  return new Promise(() => {});
}

// A seat agentbook made, as /etc/passwd has it, or it throws.
function seatUser(owner, file) {
  const seat = readSeats(file).seats[owner];
  if (!seat) throw new Error(`${owner} has no seat here. agentbook-cli seat add ${owner} first, and log it in.`);
  const pw = realDeps(file).passwd(owner);
  if (!pw || pw.gecos !== MARK) throw new Error(`${owner} isn't a seat agentbook made.`);
  return pw;
}
// Who owns this machine, written down by root from their own seat's files: their passkeys, the page they sign on,
// their server, and the machine's id in what they sign. `admin`: on a machine agentbook made, the sandbox's own
// first user. It throws while their agentbook-cli isn't logged in with a passkey.
export function recordBox(owner, { file = SEATS_FILE, admin = null } = {}) {
  owner = checkName(owner);
  const pw = seatUser(owner, file);
  const read = (f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(pw.home, ".agentbook", "cli", f), "utf8"));
    } catch {
      return {};
    }
  };
  const gate = read("gate.json");
  const device = read("device.json");
  const keys = (gate.keys || []).filter(isKey).map(({ id, alg, spki }) => ({ id, alg, spki }));
  if (!keys.length || !gate.origin || !gate.rp_id) throw new Error(`${owner}'s agentbook-cli keeps none of their passkeys yet, so nothing could prove an add is theirs. Log it in from agentbook's page with a passkey, then share.`);
  if (!device.server) throw new Error(`${owner}'s agentbook-cli isn't logged in to a server yet.`);
  const was = readBox(file);
  // On a machine agentbook made that came with no passkeys, claim left who its image is installed as, for now.
  if (!admin && !was?.admin) {
    try {
      const f = ADMIN_FILE(file);
      const st = fs.statSync(f);
      const name = fs.readFileSync(f, "utf8").trim();
      if ((process.env.AGENTBOOK_SEATS_FILE || (st.uid === 0 && !(st.mode & 0o022))) && /^[a-z_][a-z0-9_-]{0,31}$/.test(name) && name !== "root") admin = name;
    } catch {}
  }
  const box = { owner, machine: readSeats(file).machine, server: device.server, keys, origin: gate.origin, rp_id: gate.rp_id, ...(typeof gate.machine === "string" ? { gate: gate.machine } : {}), ...(admin || was?.admin ? { admin: admin || was.admin } : {}), shared: was?.shared || new Date().toISOString(), seen: was?.seen || {}, ran: was?.ran || {} };
  writeBox(box, file);
  return box;
}
// What a shared machine has besides its owner's keys: /work and the owner's place in it, the spool only they can
// write, and the helper under systemd. -> /work
function prepareBox(owner, { file = SEATS_FILE, spool = SPOOL(), node = process.execPath, plugin, systemd = process.env.AGENTBOOK_SYSTEMD_DIR || "/etc/systemd/system", run = null, start = true } = {}) {
  const pw = seatUser(owner, file);
  // The code everyone on it will work in, and the owner's place in it. Every seat's agentbook-cli clones there.
  const work = makeWork();
  joinWork(owner);
  const shared = path.join(path.dirname(file), "seats.env");
  let had = "";
  try {
    had = fs.readFileSync(shared, "utf8");
  } catch {}
  fs.writeFileSync(shared, `${had.split("\n").filter((l) => l && !l.startsWith("AGENTBOOK_CLONE_DIR=") && !l.startsWith("AGENTBOOK_WORK_DIR=")).join("\n")}\nAGENTBOOK_CLONE_DIR=${work}\nAGENTBOOK_WORK_DIR=${work}\n`.replace(/^\n/, ""), { mode: 0o644 });
  // Its folder is one anyone passes through; the spool in it is the owner's alone.
  fs.mkdirSync(path.dirname(spool), { recursive: true, mode: 0o755 });
  fs.chmodSync(path.dirname(spool), 0o755);
  fs.mkdirSync(spool, { recursive: true, mode: 0o700 });
  fs.chownSync(spool, pw.uid, 0);
  fs.chmodSync(spool, 0o700);
  // KillMode=process: an Update's script, where there's no systemd-run to give it a job of its own, outlives it.
  fs.writeFileSync(
    path.join(systemd, HELPER_UNIT),
    `# agentbook's seats helper: adds and removes people's seats on this shared machine, for its owner (agentbook-cli seat share).
[Unit]
Description=agentbook seats helper
After=network-online.target

[Service]
ExecStart=${node} ${path.join(plugin, "cli", "main.mjs")} seat serve
Restart=always
RestartSec=3
KillMode=process

[Install]
WantedBy=multi-user.target
`,
    { mode: 0o644 },
  );
  if (start && fs.existsSync("/run/systemd/system") && run) {
    run("systemctl", ["daemon-reload"]);
    run("systemctl", ["enable", "--now", HELPER_UNIT]);
  }
  return work;
}

// Share this machine: root writes down who owns it (their seat), their passkeys and their server, from their own
// agentbook-cli's files, makes the spool only they can write, and has systemd run the helper.
export function shareBox(owner, { file = SEATS_FILE, spool = SPOOL(), node = process.execPath, plugin, systemd = process.env.AGENTBOOK_SYSTEMD_DIR || "/etc/systemd/system", run = null, start = true } = {}) {
  if (process.platform !== "linux" || process.getuid() !== 0) throw new Error("Only root shares a machine: run it with sudo, on the Linux machine.");
  owner = checkName(owner);
  const box = recordBox(owner, { file });
  const work = prepareBox(owner, { file, spool, node, plugin, systemd, run, start });
  // The owner's own agentbook-cli starts again in the group, cloning into /work from now on.
  if (start && fs.existsSync("/run/systemd/system") && run) {
    try {
      run("systemctl", ["restart", `agentbook-cli@${owner}`]);
    } catch {}
  }
  return `${box.machine} is shared, as ${owner}'s, with its code in ${work}: ${owner} adds and takes off people from its page on agentbook, each signed with one of their ${box.keys.length} passkey${box.keys.length === 1 ? "" : "s"}.`;
}

// A machine agentbook made in a cloud sandbox, as it sets itself up: its owner gets a seat like anyone who's added
// later, and their agentbook-cli runs there from its first start, so the machine can be shared without moving
// anything. `enroll`: the login the machine was made with (a file in the sandbox's first user's home), which goes to
// the seat's home, where its agentbook-cli takes it. `admin`: that first user, who the image's script runs as.
//
// The file carries the owner's passkeys too (`pin`, as the server gives them to a machine that logs in), and root
// writes them down from it now, before anything of the owner's runs here: never from the seat's own files, which the
// owner's agents can write. With them goes the machine's id in what its owner signs, made here and given to the
// seat's agentbook-cli, so an Update signed for another machine of theirs doesn't hold here. A login with no
// passkeys leaves the machine unshared, and root can share it later (agentbook-cli seat share).
export function claimBox(owner, { machine, enroll = null, admin = null, file = SEATS_FILE, spool = SPOOL(), node = process.execPath, plugin, systemd = process.env.AGENTBOOK_SYSTEMD_DIR || "/etc/systemd/system", run = null, start = true } = {}) {
  if (process.platform !== "linux" || process.getuid() !== 0) throw new Error("Only root sets a machine's owner up: run it with sudo, on the Linux machine.");
  owner = checkName(owner);
  if (!machine) throw new Error("Which machine is it? --machine <its name on agentbook>");
  if (admin != null && (!/^[a-z_][a-z0-9_-]{0,31}$/.test(admin) || admin === "root" || admin === owner)) admin = null;
  const out = [addSeat(owner, { machine, start: false, plugin, node, file }).split("\n")[0]];
  const pw = seatUser(owner, file);
  const work = prepareBox(owner, { file, spool, node, plugin, systemd, run, start });
  let text = null;
  let login = null;
  try {
    text = enroll ? fs.readFileSync(enroll, "utf8") : null;
    login = text ? JSON.parse(text) : null;
  } catch {}
  let shared = !!readBox(file);
  if (login && !shared) {
    let pin = null;
    let server = null;
    try {
      pin = pinOf(login.pin);
      const url = new URL(String(login.server || ""));
      server = url.origin + url.pathname.replace(/\/$/, "");
    } catch {}
    if (pin && server) {
      const gate = `m${crypto.randomBytes(12).toString("base64url")}`;
      // The seat's agentbook-cli goes by this id from its first start. Written as them, into a home that's theirs.
      const seeded = spawnSync(node, ["-e", `const fs=require("fs"),p=require("path");const d=p.join(process.env.HOME,".agentbook","cli");fs.mkdirSync(d,{recursive:true,mode:0o700});fs.writeFileSync(p.join(d,"gate.json"),JSON.stringify({machine:process.argv[1]})+"\\n",{mode:0o600,flag:"wx"})`, gate], { uid: pw.uid, gid: pw.gid, cwd: pw.home, env: { HOME: pw.home, PATH: "/usr/bin:/bin" }, encoding: "utf8", timeout: 15000 });
      if (seeded.status === 0) {
        writeBox({ owner, machine: readSeats(file).machine, server, keys: pin.keys.map(({ id, alg, spki }) => ({ id, alg, spki })), origin: pin.origin, rp_id: pin.rp_id, gate, ...(admin ? { admin } : {}), shared: new Date().toISOString(), seen: {}, ran: {} }, file);
        shared = true;
      } else out.push(`Couldn't give ${owner}'s agentbook-cli its id for signed commands, so the machine isn't shared: ${String(seeded.stderr || seeded.error?.message || "").trim().split("\n").pop()}`);
    }
  }
  if (!shared && admin) fs.writeFileSync(ADMIN_FILE(file), `${admin}\n`, { mode: 0o644 });
  if (text) {
    realDeps(file).putEnroll(pw, text);
    fs.rmSync(enroll, { force: true });
    out.push(`Its login is in ${pw.home}, for ${owner}'s agentbook-cli to take as it starts.`);
  }
  if (start && fs.existsSync("/run/systemd/system") && run) {
    run("systemctl", ["daemon-reload"]);
    run("systemctl", ["enable", `agentbook-cli@${owner}`]);
    run("systemctl", ["restart", `agentbook-cli@${owner}`]);
  }
  out.push(shared ? `Its code is in ${work}, and ${owner} adds people from its page on agentbook, each signed with one of their passkeys.` : `Its code is in ${work}. It came with none of ${owner}'s passkeys, so nobody can be added yet: once their agentbook-cli keeps one, agentbook-cli seat share ${owner}.`);
  return out.join("\n");
}

/* ---------- the owner's agentbook-cli's side: asking the helper ---------- */

// Ask the helper, and wait for its answer. -> its answer, or { error } when none came.
export async function askHelper(req, { spool = SPOOL(), waitMs = 20000 } = {}) {
  const id = `${Date.now().toString(36)}-${digestOf(req).slice(0, 10).replace(/[^\w]/g, "x")}`;
  const f = path.join(spool, `${id}.json`);
  const out = f.replace(/\.json$/, ".out");
  try {
    fs.writeFileSync(`${f}.tmp`, JSON.stringify(req), { mode: 0o600 });
    fs.renameSync(`${f}.tmp`, f);
  } catch (e) {
    return { error: e.code === "ENOENT" || e.code === "EACCES" ? "This machine isn't shared from this seat: only its owner's agentbook-cli asks its seats helper." : e.message };
  }
  for (const end = Date.now() + waitMs; Date.now() < end; await new Promise((r) => setTimeout(r, 150))) {
    try {
      const answer = JSON.parse(fs.readFileSync(out, "utf8"));
      fs.rmSync(out, { force: true });
      return answer;
    } catch {}
  }
  fs.rmSync(f, { force: true });
  return { error: "The seats helper didn't answer. Is it running? systemctl status agentbook-seats" };
}
// Whether this seat is the one a shared machine belongs to, with a helper to ask.
export const sharesHere = (seatName, { file = SEATS_FILE, spool = SPOOL() } = {}) => {
  const box = readBox(file);
  if (!box || box.owner !== seatName) return false;
  try {
    fs.accessSync(spool, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
};
