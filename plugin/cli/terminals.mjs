// Terminals: one shell per thread, in its folder, for its owner on the page (term.open, through the gate), kept until
// it's closed or its shell exits. ▶ on a thread's code block runs there too (runs.mjs), as pasted at its prompt.
//
// The shell runs in a pseudo-terminal, which Node can't make without a native module, so a few lines of Python make it
// (HOLDER, below). That process holds the shell, not agentbook-cli: it outlives agentbook-cli, which finds it again on
// a unix socket of its own as it starts (adopt), with what it showed lately. What's typed comes from the page, and
// what the shell shows goes to it, through the server, on one WebSocket for all of this machine's terminals (the line,
// server/terminals.mjs). When the server restarts, or is out of reach a while, the line comes back and says again
// which terminals are open here, with what each showed lately.
//
// zsh and bash get a few lines more, which mark where each command starts and ends, and its exit code (OSC 633, as
// VS Code's terminal does): how a run knows when its code is done, and that the shell is at its prompt.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

// The holder: `python3 -c HOLDER <socket> <meta> <cols> <rows> <shell> [args]`. It listens on <socket> (only its
// person may), starts the shell in a pseudo-terminal, prints "ready", and serves one connection at a time (the newest):
// "M" <meta, as JSON> and "R" <what it showed lately> as one connects, then "O" <bytes> as the shell shows them, and
// "X" <{ code }> once it ends, or "Q" when a newer connection takes over. Each frame is a byte for its kind, four for
// its length, then it. What comes in: "I" <bytes> typed, "S" <"cols rows">, "K" (kill what's running in the foreground,
// not the shell), "C" (hang it up), and "T" <id, newline, bytes>: typed, from the page, which may come again if
// whoever passed it on stopped before saying so. It takes an id once, and answers "G" <id> each time, which goes back
// to the server and the page, so they can stop keeping it. Being the one that outlives them, it's what can tell.
// With nobody connected it keeps reading, so the shell never waits for agentbook-cli.
const HOLDER = String.raw`
import fcntl, json, os, pty, select, signal, socket, struct, sys, termios, time
sock_path, meta = sys.argv[1], json.loads(sys.argv[2])
cols, rows = int(sys.argv[3]), int(sys.argv[4])
argv = sys.argv[5:]
KEPT = 256 * 1024
def size(f, c, r):
    fcntl.ioctl(f, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))
srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
try:
    os.unlink(sock_path)
except FileNotFoundError:
    pass
old = os.umask(0o177)
srv.bind(sock_path)
os.umask(old)
srv.listen(4)
pid, fd = pty.fork()
if pid == 0:
    size(0, cols, rows)
    try:
        os.execvp(argv[0], argv)
    except Exception as e:
        os.write(2, ("agentbook: can't start %s: %s\r\n" % (argv[0], e)).encode())
        os._exit(127)
fcntl.fcntl(fd, fcntl.F_SETFL, fcntl.fcntl(fd, fcntl.F_GETFL) | os.O_NONBLOCK)
class Hang(Exception):
    pass
def hang(*_):
    raise Hang()
signal.signal(signal.SIGTERM, hang)
sys.stdout.write("ready\n")
sys.stdout.flush()
null = os.open(os.devnull, os.O_RDWR)
for f in (0, 1, 2):
    os.dup2(null, f)
kept, typed = bytearray(), bytearray()
seen = {}
client, inbuf, status, hung = None, b"", None, False
def drop():
    global client, inbuf
    if client is not None:
        try:
            client.close()
        except OSError:
            pass
    client, inbuf = None, b""
def send(kind, payload=b""):
    if client is None:
        return
    try:
        client.sendall(kind + struct.pack(">I", len(payload)) + payload)
    except OSError:
        drop()
def kill_foreground():
    try:
        pg = os.tcgetpgrp(fd)
    except OSError:
        return
    if pg > 0 and pg != pid:
        try:
            os.killpg(pg, signal.SIGKILL)
        except OSError:
            pass
try:
    while not hung:
        r, w, _ = select.select([srv, fd] + ([client] if client is not None else []), [fd] if typed else [], [], 1.0)
        if srv in r:
            try:
                c = srv.accept()[0]
            except OSError:
                c = None
            if c is not None:
                send(b"Q")
                drop()
                client = c
                client.settimeout(10)
                send(b"M", json.dumps(dict(meta, v=1, acks=True, pid=pid, cols=cols, rows=rows)).encode())
                send(b"R", bytes(kept))
        if fd in r:
            try:
                data = os.read(fd, 65536)
            except BlockingIOError:
                data = None
            except OSError:
                data = b""
            if data == b"":
                break
            if data:
                kept += data
                if len(kept) > KEPT:
                    del kept[: len(kept) - KEPT]
                send(b"O", data)
        if fd in w:
            try:
                del typed[: os.write(fd, typed)]
            except BlockingIOError:
                pass
            except OSError:
                typed.clear()
        if client is not None and client in r:
            try:
                data = client.recv(65536)
            except OSError:
                data = b""
            if not data:
                drop()
            else:
                inbuf += data
                while len(inbuf) >= 5:
                    n = struct.unpack(">I", inbuf[1:5])[0]
                    if len(inbuf) < 5 + n:
                        break
                    kind, body, inbuf = inbuf[:1], inbuf[5 : 5 + n], inbuf[5 + n :]
                    if kind == b"I" and len(typed) < 1 << 20:
                        typed += body
                    elif kind == b"T":
                        tag, _, text = body.partition(b"\n")
                        if tag not in seen and len(typed) < 1 << 20:
                            typed += text
                            seen[tag] = True
                            if len(seen) > 4096:
                                del seen[next(iter(seen))]
                        if tag in seen:
                            send(b"G", tag)
                    elif kind == b"S":
                        try:
                            c, h = (int(x) for x in body.split())
                            size(fd, c, h)
                            cols, rows = c, h
                        except (ValueError, OSError):
                            pass
                    elif kind == b"K":
                        kill_foreground()
                    elif kind == b"C":
                        hung = True
        if not r and not w:
            p, st = os.waitpid(pid, os.WNOHANG)
            if p:
                status = st
                break
except Hang:
    hung = True
try:
    while not hung:
        data = os.read(fd, 65536)
        if not data:
            break
        send(b"O", data)
except OSError:
    pass
# Closing it hangs the shell up (on macOS a shell exiting with output nobody reads would wait for it forever).
os.close(fd)
if status is None:
    for i in range(30):
        p, st = os.waitpid(pid, os.WNOHANG)
        if p:
            status = st
            break
        if i == 0:
            try:
                os.kill(pid, signal.SIGHUP)
            except ProcessLookupError:
                pass
        time.sleep(0.1)
    if status is None:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        status = os.waitpid(pid, 0)[1]
try:
    os.unlink(sock_path)
except OSError:
    pass
code = os.waitstatus_to_exitcode(status)
send(b"X", json.dumps({"code": code if code >= 0 else 128 - code}).encode())
drop()
`;

// zsh reads its startup files from agentbook-cli's shell/zsh: each reads yours first (from your ZDOTDIR, or your home), so the shell is
// the one you'd get in Terminal; then .zshrc adds the marks, and zsh reads your .zlogin from your own folder.
const ZSH_FILES = {
  ".zshenv": `# agentbook's terminal (plugin/cli/terminals.mjs): your .zshenv, then on to the next of your files.
_ab_zdotdir=$ZDOTDIR
if [[ -n $_AB_ZDOTDIR ]]; then ZDOTDIR=$_AB_ZDOTDIR; else unset ZDOTDIR; fi
[[ -f \${ZDOTDIR:-$HOME}/.zshenv ]] && builtin source \${ZDOTDIR:-$HOME}/.zshenv
_AB_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$_ab_zdotdir
`,
  ".zprofile": `# agentbook's terminal (plugin/cli/terminals.mjs): your .zprofile, then on to the next of your files.
_ab_zdotdir=$ZDOTDIR
if [[ -n $_AB_ZDOTDIR ]]; then ZDOTDIR=$_AB_ZDOTDIR; else unset ZDOTDIR; fi
[[ -f \${ZDOTDIR:-$HOME}/.zprofile ]] && builtin source \${ZDOTDIR:-$HOME}/.zprofile
_AB_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$_ab_zdotdir
`,
  ".zshrc": `# agentbook's terminal (plugin/cli/terminals.mjs): your .zshrc, and from here on your own files (your .zlogin).
if [[ -n $_AB_ZDOTDIR ]]; then ZDOTDIR=$_AB_ZDOTDIR; else unset ZDOTDIR; fi
unset _AB_ZDOTDIR _ab_zdotdir
[[ -f \${ZDOTDIR:-$HOME}/.zshrc ]] && builtin source \${ZDOTDIR:-$HOME}/.zshrc
# Where each command starts (C), where it ended and how (D;<exit code>), and the prompt (A), for agentbook's ▶.
__ab_precmd() { local s=$?; builtin printf '\\e]633;D;%s\\a\\e]633;A\\a' $s; }
__ab_preexec() { builtin printf '\\e]633;C\\a'; }
precmd_functions=(__ab_precmd $precmd_functions)
preexec_functions+=(__ab_preexec)
`,
};
// bash starts with BASH_RC: what a login bash reads, as Terminal's does, then the marks.
const BASH_RC = `# agentbook's terminal (plugin/cli/terminals.mjs): what a login bash reads, then marks for agentbook's ▶.
[ -r /etc/profile ] && . /etc/profile
for _ab_f in ~/.bash_profile ~/.bash_login ~/.profile; do [ -r "$_ab_f" ] && { . "$_ab_f"; break; }; done
unset _ab_f
# Where each command starts (C), where it ended and how (D;<exit code>), and the prompt (A).
__ab_ready=
__ab_precmd() { local s=$?; printf '\\033]633;D;%s\\007\\033]633;A\\007' "$s"; __ab_ready=; return $s; }
__ab_preexec() { [ -n "$__ab_ready" ] && [ -z "$COMP_LINE" ] && [ "$BASH_COMMAND" != __ab_precmd ] || return 0; __ab_ready=; printf '\\033]633;C\\007'; }
if [ -z "$(trap -p DEBUG)" ]; then
  trap '__ab_preexec' DEBUG
  # __ab_ready=1 has to come last: what runs after it would count as a command started, and the terminal would look
  # busy at its prompt. PROMPT_COMMAND can be a list since bash 5.1, and systemd's profile (Ubuntu's) adds to it as one,
  # while an older bash runs only a list's first. So all of it goes in one, a line each, as an entry may end in a ;.
  _ab_pc=__ab_precmd
  for _ab_c in "\${PROMPT_COMMAND[@]}"; do _ab_pc+=$'\\n'"$_ab_c"; done
  unset PROMPT_COMMAND _ab_c
  PROMPT_COMMAND=$_ab_pc$'\\n'__ab_ready=1
  unset _ab_pc
fi
`;

const KEPT = 256 * 1024; // what it showed lately, for the server to show a page that opens it again
const MAX_OPEN = 16;
const PROMPT_MS = 15e3; // a new shell has this long to show its prompt, for a run
const MARK_MS = 5e3; // a run pasted at the prompt has this long to start (or fail to)
const KILL_MS = 3000; // after Stop, how long what it runs has to end before it's killed
// How long after a signature (opening it, a run in it, term.lease) what's typed is taken, with its server elsewhere.
// One found again after a restart has to be signed again first.
const LEASE_MS = Number(process.env.AGENTBOOK_TERM_LEASE_MS || 30 * 60e3);
const HELD_MAX = 4 * 1024 * 1024; // what's waiting to go to the server: past this, the shell waits
const MARKS = /\x1b\]633;([ACD])(?:;([^\x07\x1b]*))?(?:\x07|\x1b\\)|\x1b\[\?2004([hl])/g;
// The start of a mark or a paste switch that the next piece will finish.
const PARTIAL = /\x1b(?:\](?:6(?:3(?:3(?:;[ACD]?(?:;[^\x07\x1b]*)?)?)?)?)?|\[(?:\?(?:2(?:0(?:0(?:4)?)?)?)?)?)?$/;

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(n) || lo)));
const no = (status, message) => Object.assign(new Error(message), { status });
export const newTid = () => `t${crypto.randomBytes(15).toString("base64url")}`;
const isTid = (tid) => typeof tid === "string" && /^t[\w-]{16,40}$/.test(tid);
const frame = (kind, body = Buffer.alloc(0)) => {
  const b = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const head = Buffer.alloc(5);
  head.write(kind, 0, "latin1");
  head.writeUInt32BE(b.length, 1);
  return Buffer.concat([head, b]);
};

// The shell its person uses, as a login shell, as Terminal opens it.
const shellOf = () => process.env.SHELL || os.userInfo().shell || (process.platform === "darwin" ? "/bin/zsh" : "/bin/sh");
// Which of them mark their commands.
const kindOf = (shell) => (/(^|\/)zsh$/.test(shell) ? "zsh" : /(^|\/)bash$/.test(shell) ? "bash" : null);
// Its environment: the machine's, but not agentbook's own (its keys) or what says it's inside Claude Code.
function envOf() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(AGENTBOOK_|CLAUDECODE$|CLAUDE_CODE_|_AB_)/.test(k)) env[k] = v;
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.TERM_PROGRAM = "agentbook";
  if (!env.LANG && !env.LC_ALL) env.LANG = "en_US.UTF-8";
  return env;
}
// Where the holders' sockets are: agentbook-cli's own folder, unless its path is too long for a socket's (about 104
// bytes on macOS), as a test's temporary one is; then a folder of this person's own under /tmp.
export function socketsDir(home) {
  const own = path.join(home, "terminals");
  if (Buffer.byteLength(path.join(own, `${newTid()}.sock`)) < 100) return own;
  return path.join("/tmp", `agentbook-${os.userInfo().uid}`, crypto.createHash("sha256").update(home).digest("hex").slice(0, 12));
}
function ownDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (let d = dir; d !== path.dirname(d) && (d.startsWith(path.join("/tmp", "agentbook-")) || d === dir); d = path.dirname(d)) {
    const st = fs.lstatSync(d);
    if (!st.isDirectory() || st.uid !== process.getuid()) throw no(500, `${d} isn't this machine's person's own folder.`);
    fs.chmodSync(d, 0o700);
  }
}
// The startup files of the shells that mark their commands, in agentbook-cli's folder (as they are in this version).
function writeIfChanged(file, text) {
  try {
    if (fs.readFileSync(file, "utf8") === text) return;
  } catch {}
  fs.writeFileSync(file, text);
}

// `home`: agentbook-cli's folder (~/.agentbook/cli). `line()`: a new WebSocket to the server's terminals line, or null while this machine
// isn't logged in to one.
export function createTerminals({ home, line = () => null, hosted = () => false, log = () => {} }) {
  const open = new Map(); // tid -> T
  const dir = socketsDir(home);
  const exits = new Map(); // tid -> { code }: ended while the line was down, for the server once it's back

  /* ---------- holders ---------- */

  // How it starts: the shell, and for zsh and bash the files that add the marks.
  function argvOf(shell) {
    const env = envOf();
    const kind = kindOf(shell);
    if (kind === "zsh") {
      const zdir = path.join(home, "shell", "zsh");
      fs.mkdirSync(zdir, { recursive: true });
      for (const [name, text] of Object.entries(ZSH_FILES)) writeIfChanged(path.join(zdir, name), text);
      env._AB_ZDOTDIR = process.env.ZDOTDIR || "";
      env.ZDOTDIR = zdir;
      return { args: [shell, "-l"], env };
    }
    if (kind === "bash") {
      const rc = path.join(home, "shell", "bash", "rc");
      fs.mkdirSync(path.dirname(rc), { recursive: true });
      writeIfChanged(rc, BASH_RC);
      return { args: [shell, "--rcfile", rc, "-i"], env };
    }
    return { args: [shell, "-l"], env };
  }

  // A new holder, started apart from agentbook-cli (its own session), listening on `sock` once it's ready.
  async function spawnHolder(sock, meta, cols, rows, { args, env, cwd }) {
    for (const py of ["python3", "/usr/bin/python3"]) {
      const child = spawn(py, ["-I", "-c", HOLDER, sock, JSON.stringify(meta), String(cols), String(rows), ...args], { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
      const r = await new Promise((resolve) => {
        let out = "";
        let err = "";
        const timer = setTimeout(() => resolve({ error: new Error("its terminal didn't start in time") }), 10e3);
        const done = (v) => {
          clearTimeout(timer);
          resolve(v);
        };
        child.once("error", (error) => done({ error }));
        child.stdout.on("data", (b) => (out += b).includes("ready\n") && done({ ok: true }));
        child.stderr.on("data", (b) => (err += b));
        child.once("exit", (code) => done({ error: new Error(err.trim().split("\n").pop() || `python3 exited (${code})`) }));
      });
      if (r.ok) {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        return;
      }
      child.stdout.destroy();
      child.stderr.destroy();
      if (r.error.code !== "ENOENT") throw no(500, `Its terminal couldn't start: ${r.error.message}`);
    }
    throw no(501, `A terminal needs python3 on ${os.hostname().split(".")[0]}, and there's none.`);
  }

  // Connected to a holder: what it says, as it says it. -> T, once it said what it is and what it showed lately.
  function attach(sock) {
    return new Promise((resolve, reject) => {
      const s = net.createConnection(sock);
      let buf = Buffer.alloc(0);
      let T = null;
      s.on("error", (e) => (T ? null : reject(e)));
      s.on("close", () => {
        if (!T) return reject(new Error("it hung up"));
        // Another agentbook-cli has it now: this one lets it go.
        if (T.replaced) {
          T.ended = true;
          if (open.get(T.tid) === T) open.delete(T.tid);
          return log(`terminal ${T.tid}: taken over by another agentbook-cli`);
        }
        // Gone without saying how it ended: the holder was killed.
        gone(T, T.exited || { code: null });
      });
      s.on("data", (d) => {
        buf = buf.length ? Buffer.concat([buf, d]) : d;
        while (buf.length >= 5) {
          const n = buf.readUInt32BE(1);
          if (buf.length < 5 + n) break;
          const kind = String.fromCharCode(buf[0]);
          const body = buf.subarray(5, 5 + n);
          buf = buf.subarray(5 + n);
          if (kind === "M") {
            let m = {};
            try {
              m = JSON.parse(body.toString("utf8"));
            } catch {}
            if (m.v !== 1 || !isTid(m.tid) || typeof m.post !== "string") {
              s.destroy();
              return reject(new Error("it isn't one of this version's"));
            }
            // `marks`: its shell should mark its commands; `marked`: it has.
            T = { tid: m.tid, post: m.post, cwd: m.cwd || null, shell: m.shell || null, marks: !!m.marks, marked: false, acks: m.acks === true, sock: s, kept: [], keptBytes: 0, carry: "", state: "starting", paste: false, typed: false, run: null, exited: null, ended: false, waiters: new Set() };
          } else if (kind === "R" && T) {
            if (body.length) keep(T, Buffer.from(body));
            parse(T, Buffer.from(body), true);
            open.set(T.tid, T);
            resolve(T);
          } else if (kind === "O" && T) {
            const data = Buffer.from(body);
            keep(T, data);
            parse(T, data, false);
            say({ t: "out", tid: T.tid, data: data.toString("base64") });
            held(T);
          } else if (kind === "G" && T) say({ t: "got", tid: T.tid, id: body.toString("latin1") });
          else if (kind === "Q" && T) T.replaced = true;
          else if (kind === "X" && T) {
            try {
              T.exited = JSON.parse(body.toString("utf8"));
            } catch {
              T.exited = { code: null };
            }
          }
        }
      });
    });
  }
  const tell = (T, kind, body) => {
    if (!T.ended) T.sock.write(frame(kind, body));
  };

  function keep(T, data) {
    T.kept.push(data);
    T.keptBytes += data.length;
    while (T.keptBytes - T.kept[0].length >= KEPT) T.keptBytes -= T.kept.shift().length;
  }
  const keptOf = (T) => {
    const all = Buffer.concat(T.kept);
    return all.length > KEPT ? all.subarray(all.length - KEPT) : all;
  };

  // Its end: its run hears it, and so does the server (now, or once the line is back).
  function gone(T, exit) {
    if (T.ended) return;
    T.ended = true;
    open.delete(T.tid);
    for (const w of T.waiters) w();
    // A run's code that ended its shell (an `exit`) ended its terminal too, as it would pasted in any terminal.
    if (T.run) T.run.finish(exit.code != null && T.run.phase === "running" ? { exit: exit.code, note: "It ended the terminal's shell, so the terminal closed." } : { exit: null, error: "Its terminal ended while it ran." });
    log(`terminal ${T.tid}: ended${exit.code != null ? ` (${exit.code})` : ""}`);
    if (!say({ t: "exit", tid: T.tid, code: exit.code ?? null })) exits.set(T.tid, { code: exit.code ?? null });
    if (!open.size) setTimeout(() => !open.size && ws?.close(), 5000).unref?.();
  }

  /* ---------- marks: where its commands start and end ---------- */

  // What it showed, read for its marks: the prompt (idle), a command running (busy), its paste switch, and a run's
  // output and end. `old`: what it showed before agentbook-cli connected, read for where it stands only.
  function parse(T, data, old) {
    const s = T.carry + data.toString("latin1");
    const cut = s.match(PARTIAL);
    const text = cut && cut[0].length < 256 ? s.slice(0, cut.index) : s;
    T.carry = cut && cut[0].length < 256 ? cut[0] : "";
    let at = 0;
    for (const m of text.matchAll(MARKS)) {
      if (!old && m.index > at) T.run?.text(text.slice(at, m.index));
      at = m.index + m[0].length;
      // Its shell takes pastes whole once it ever turned that on (it turns it off while a command runs).
      if (m[3]) {
        T.paste ||= m[3] === "h";
        if (T.paste) for (const w of T.waiters) w();
      }
      else if (m[1] === "C") {
        T.state = "busy";
        T.marked = true;
        if (old) T.since = at;
        T.run?.started();
      } else if (m[1] === "D") {
        T.marked = true;
        T.run?.finish({ exit: Number.isSafeInteger(Number(m[2])) && m[2] !== "" ? Number(m[2]) : null });
      } else if (m[1] === "A") {
        T.marked = true;
        T.state = "idle";
        T.typed = false;
        for (const w of T.waiters) w();
      }
    }
    if (!old && at < text.length) T.run?.text(text.slice(at));
    if (old && T.state === "busy") T.busyText = text.slice(T.since ?? 0);
  }

  // Until it's at its prompt (or ends, or `ms` go by). -> whether it is.
  const prompt = (T, ms) => until(T, () => T.state === "idle", ms);
  // Until `ready()` (or it ends, or `ms` go by), hearing again each time it shows its prompt or takes pastes.
  async function until(T, ready, ms) {
    const end = Date.now() + ms;
    while (!T.ended && !ready() && Date.now() < end) {
      await new Promise((resolve) => {
        const w = () => {
          clearTimeout(timer);
          T.waiters.delete(w);
          resolve();
        };
        const timer = setTimeout(w, Math.max(0, end - Date.now()));
        T.waiters.add(w);
      });
    }
    return !T.ended && ready();
  }

  /* ---------- the line: the server, for every terminal here ---------- */

  let ws = null;
  let up = false;
  let backoff = 500;
  let retry = null;
  const about = (T) => ({ tid: T.tid, post: T.post, cwd: T.cwd, shell: T.shell, acks: T.acks, kept: keptOf(T).toString("base64") });
  // -> whether it went.
  function say(msg) {
    if (!up) return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }
  // What it shows waits for the server when the line's behind: the holder stops being read, and the shell waits.
  function held(T) {
    if (!up || ws.bufferedAmount < HELD_MAX || T.paused) return;
    T.paused = true;
    T.sock.pause();
    const check = () => {
      if (!up || ws.bufferedAmount < HELD_MAX / 2 || T.ended) {
        T.paused = false;
        return T.sock.resume();
      }
      setTimeout(check, 50).unref?.();
    };
    setTimeout(check, 50).unref?.();
  }
  function connect() {
    clearTimeout(retry);
    retry = null;
    if (ws || !open.size) return;
    let sock = null;
    try {
      sock = line();
    } catch (e) {
      log(`terminals: can't reach the server: ${e.message}`);
    }
    if (!sock) return void (retry = setTimeout(connect, 5000)).unref?.();
    ws = sock;
    sock.addEventListener("open", () => {
      up = true;
      backoff = 500;
      sock.send(JSON.stringify({ t: "hello", terms: [...open.values()].map(about), ended: [...exits].map(([tid, e]) => ({ tid, ...e })) }));
      exits.clear();
    });
    sock.addEventListener("message", (e) => {
      let m;
      try {
        m = JSON.parse(String(e.data));
      } catch {
        return;
      }
      const T = open.get(m.tid);
      if (!T) return;
      if (m.t === "in" && typeof m.data === "string") {
        // With its server elsewhere, what's typed isn't signed, so it's taken only for a while after what is.
        if (hosted() && !(T.until > Date.now())) return void sock.send(JSON.stringify({ t: "lease", tid: T.tid, id: typeof m.id === "string" ? m.id : undefined }));
        T.typed = true;
        const data = Buffer.from(m.data, "utf8");
        // A holder from before it said what it got (one still running since this version came) hears it plainly.
        if (T.acks && typeof m.id === "string" && /^[\w.-]{1,40}$/.test(m.id)) tell(T, "T", Buffer.concat([Buffer.from(`${m.id}\n`), data]));
        else tell(T, "I", data);
      } else if (m.t === "size") tell(T, "S", `${clamp(m.cols, 2, 500)} ${clamp(m.rows, 1, 300)}`);
      else if (m.t === "close" || m.t === "gone") {
        log(`terminal ${T.tid}: ${m.t === "close" ? "closed from the page" : "the server won't have it"}`);
        tell(T, "C");
      }
    });
    // Gone, or never there (Node's WebSocket says only "error" when the server turns it down): tried again soon.
    const lost = () => {
      if (ws !== sock) return;
      ws = null;
      up = false;
      if (open.size || exits.size) (retry = setTimeout(connect, (backoff = Math.min(backoff * 2, 10e3)))).unref?.();
    };
    sock.addEventListener("close", lost);
    sock.addEventListener("error", () => sock.readyState !== WebSocket.OPEN && lost());
  }

  /* ---------- what agentbook-cli does with them ---------- */

  // The holders still running from before agentbook-cli restarted: connected again, and the server told.
  async function adopt() {
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => /^t[\w-]{16,40}\.sock$/.test(n));
    } catch {
      return 0;
    }
    await Promise.all(
      names.map((n) =>
        attach(path.join(dir, n)).then(
          (T) => log(`terminal ${T.tid}: found again, ${T.shell} in ${T.cwd}`),
          // Nothing listens there any more (its holder was killed, or the machine restarted).
          (e) => ["ECONNREFUSED", "ENOENT"].includes(e.code) && fs.rmSync(path.join(dir, n), { force: true }),
        ),
      ),
    );
    if (open.size) connect();
    return open.size;
  }

  const forPost = (post) => [...open.values()].find((T) => T.post === post && !T.ended) || null;

  // Open a thread's: { tid, post, cwd, cols, rows } -> { tid, cwd, shell }. The thread's one, when it has one already.
  async function start({ tid = newTid(), post, cwd, cols = 100, rows = 30 }) {
    const had = forPost(post);
    if (had) {
      had.until = Date.now() + LEASE_MS;
      return { tid: had.tid, cwd: had.cwd, shell: had.shell };
    }
    if (open.size >= MAX_OPEN) throw no(429, `${MAX_OPEN} terminals are open on this machine already. Close one first.`);
    if (!isTid(tid)) throw no(400, "That terminal's id won't do.");
    ownDir(dir);
    const shell = shellOf();
    const how = argvOf(shell);
    const sock = path.join(dir, `${tid}.sock`);
    await spawnHolder(sock, { tid, post, cwd, shell: path.basename(shell), marks: !!kindOf(shell) }, clamp(cols, 2, 500), clamp(rows, 1, 300), { ...how, cwd });
    const T = await attach(sock);
    T.until = Date.now() + LEASE_MS;
    log(`terminal ${tid}: ${T.shell} in ${cwd}`);
    say({ t: "open", ...about(T) });
    connect();
    return { tid, cwd, shell: T.shell };
  }

  // Run code in a thread's terminal, as pasted at its prompt (`cwd`: where a new one opens, if it has none and `open`
  // allows). `hooks`: started(), output(text) as it shows it, end({ exit, error }) once it's done. -> { stop() }; null
  // when it has none (and may not open one), or its terminal can't say when code ends (a shell that doesn't mark its
  // commands); throws { status, message } when it's busy, or can't open.
  async function run(post, cwd, code, hooks, { open: opens = true } = {}) {
    let T = forPost(post);
    if (!T && (!opens || !kindOf(shellOf()))) return null;
    if (!T) T = open.get((await start({ post, cwd })).tid);
    T.until = Date.now() + LEASE_MS; // a run is signed too
    if (!T || !T.marks || (T.unmarked && !T.marked)) return null;
    if (T.run) throw no(409, "Another of its code blocks is running in its terminal. Stop it first.");
    if (T.state === "starting" && !(await prompt(T, PROMPT_MS))) {
      if (T.ended) throw no(410, "Its terminal ended.");
      // Its shell never marked a command (its own startup files took the marks off): it runs on its own instead.
      if (!T.marked) {
        T.unmarked = true;
        return null;
      }
      throw no(409, "Its terminal didn't come back to its prompt in time.");
    }
    if (T.state === "busy") throw no(409, "Its terminal is running something. Run it once that's done, or stop it there.");
    // A shell that just showed its prompt says it takes pastes a moment later (zsh, bash 5); one that never says so
    // (bash 3) doesn't.
    if (!T.paste && !T.noPaste && !(await until(T, () => T.paste, 500))) T.noPaste = true;
    if (T.state !== "idle") throw no(409, "Its terminal is running something. Run it once that's done, or stop it there.");
    const body = String(code).replace(/\s+$/, "");
    const R = attachRun(T, hooks);
    // What's half typed at its prompt goes, as Ctrl-U would; then the code, as pasted (bracketed, so the shell takes
    // it whole), and Enter. It goes as one command: a shell that can't take a paste would run each line as it's typed,
    // and bash, even pasted, runs them one at a time, so Stop's Ctrl-C would end one line and the next would start.
    const block = body.includes("\n") && (!T.paste || kindOf(T.shell) === "bash") ? `{\n${body}\n}` : body;
    const typing = T.paste ? `\x1b[200~${block}\x1b[201~` : block;
    tell(T, "I", `${T.typed ? "\x05\x15" : ""}${typing}\r`);
    // Not started: its shell is waiting for more of it (an unclosed quote or bracket). What's typed so far goes, as
    // Ctrl-C would.
    R.timer = setTimeout(() => {
      if (R.phase !== "sent") return;
      // Until its prompt is back, where it stands isn't known.
      T.state = "starting";
      tell(T, "I", "\x03");
      R.pre = "";
      R.finish({ exit: null, error: "Its shell didn't start it: it was waiting for more of it (an unclosed quote or bracket?), so agentbook cancelled it." });
    }, MARK_MS);
    R.timer.unref?.();
    return R;
  }
  // A run whose code was running in a thread's terminal when agentbook-cli stopped: heard again, from what it showed
  // since it started. -> { stop() }, or null when its terminal isn't running anything now.
  function resume(post, hooks) {
    const T = forPost(post);
    if (!T || T.run || T.state !== "busy") return null;
    const R = attachRun(T, hooks);
    R.phase = "running";
    if (T.busyText) R.text(T.busyText);
    return R;
  }
  function attachRun(T, hooks) {
    const R = {
      phase: "sent",
      started() {
        if (R.phase !== "sent") return;
        R.phase = "running";
        clearTimeout(R.timer);
        hooks.started?.();
      },
      // What it shows once it started; before (what's echoed as it's pasted), kept in case it never starts (a syntax
      // error), as the only word of what happened.
      pre: "",
      text(s) {
        if (R.phase === "running") hooks.output?.(Buffer.from(s, "latin1"));
        else if (R.phase === "sent" && R.pre.length < 65536) R.pre += s;
      },
      finish(how) {
        if (R.phase === "done") return;
        if (R.phase === "sent" && R.pre) hooks.output?.(Buffer.from(R.pre, "latin1"));
        R.phase = "done";
        clearTimeout(R.timer);
        clearTimeout(R.kill);
        if (T.run === R) T.run = null;
        hooks.end?.(how);
      },
      // Stop: Ctrl-C, as you'd press it; then, if it's still going, what it runs is killed (not the shell).
      stop() {
        if (R.phase === "done") return;
        tell(T, "I", "\x03");
        R.kill = setTimeout(() => R.phase !== "done" && tell(T, "K"), KILL_MS);
        R.kill.unref?.();
      },
    };
    T.run = R;
    return R;
  }

  return {
    start,
    run,
    resume,
    adopt,
    // Signed again (term.lease): what's typed in it is taken for another while. -> whether it's open.
    renew(tid) {
      const T = open.get(tid);
      if (T) T.until = Date.now() + LEASE_MS;
      return !!T;
    },
    // agentbook-cli connected to its server: the line goes now, if it's waiting to.
    wake: () => !ws && open.size && connect(),
    open: () => open.size,
    has: (post) => !!forPost(post),
  };
}
