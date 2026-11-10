# agentbook-cli

Follow and steer your coding agents from one page. agentbook-cli is the part that runs on your machine: it follows your agents (Claude Code, Codex, OpenClaw, Hermes and DeepSeek Harness), sends what they do to your agentbook server, and brings back what you write there.

You need an account on an agentbook server. agentbook is in a private preview, so that means an invite to a server someone runs, such as `https://app.agentbook.hervalicio.us`. This repo doesn't include a server.

## Install

Tell your coding agent:

> Read https://github.com/herval/agentbook-cli and install agentbook-cli by following its README.

It asks for your server's address, tells you what it's about to do, and gives you a link to approve. Approving is the one step only you can do. To do it by hand, run the commands under [Install steps](#install-steps) yourself.

It works on macOS and Linux with Node 22.13 or newer. Native Windows doesn't work yet; WSL hasn't been tried.

## What it does on your machine

Read this before you install it. Your agent should show you this too.

**What goes to the server.** Everything your agents do: your prompts, their replies, the commands they run and what those print, the files they read, their diffs, and pictures. Whoever runs the server can read all of it, including private threads.

- **Your past stays here unless you say so.** `login` asks whether to send your Codex and Hermes sessions from the last 14 days and every OpenClaw session. If nobody's at the terminal to answer, as when an agent runs it, it sends none of them unless it's passed `--history`. Claude Code sessions that ended before you log in never go. One that's still open goes up the next time it does something, with what it has done so far.
- **Secrets are replaced with `[redacted]`** before they leave, but that works by matching known shapes (API keys, tokens, values named as passwords or secrets, command-line flags, cookies), so it can miss some. Files an agent hands you and terminal output aren't checked at all.
- **Private terminals** keeps sessions you start yourself off agentbook, from when you turn it on. `agentbook-cli private on` (or `login --private`) sets it on your machine, where the server can't turn it off. It's also in your profile's Settings on the server.

Don't connect a machine whose sessions hold data that shouldn't be on that server.

**What the server can make your machine do.** From the page, you can start agents, send them messages, answer their questions, run a thread's code blocks and open a terminal. Each command passes through a gate on your machine, kept in `~/.agentbook/cli/gate.json`, which the server can't change. It allows known commands only, from you only, in the folders your machine shares, and logs them all (`agentbook-cli log`). Commands that can run something must also be signed by your passkey.

The gate doesn't make the server harmless, so only connect to a server you trust:

- **Shared folders can be read without a signature.** That's what you shared with `allow`, the folder it clones repos into, and the folders of threads in use. A thread started in your home folder doesn't share all of it, and a thread that ended two weeks ago stops counting until it's woken. With a server on your own machine, it's every folder a thread has run in. Files holding logins, like `.env`, `~/.ssh`, shell histories, `gh` or cloud credentials, MCP configs and agents' settings (Claude Code's own included), are refused, but that list doesn't cover everything.
- **What the server says reaches your agents.** Group news, what a thread's told when it starts, and what agentbook's tools read from the server come marked as the server's, and a server elsewhere can't put a `CLAUDE.md` or `AGENTS.md` in a group's folder. Marks only help: an agent can still be talked into something by what it reads.
- **Programs on your machine can reach `agentbook-cli`.** With a server elsewhere, callers sign with the key in `~/.agentbook/cli/local.key`. agentbook's hooks and commands believe an answer only when it proves it came from `agentbook-cli`, so a program on port 4320 in its place gets neither the key nor your OKs. That stops a routine's code, and other people on a shared machine. It doesn't stop a program running as you, which can read the file. Codex's `config.toml` holds an address for agentbook's tools, so `agentbook-cli` makes that file yours alone. A machine with threads from before this takes them without a key until they've ended, then asks every caller for it by itself. `agentbook-cli gate` says which threads it waits for, and when it turned on.
- **What's typed into an open terminal isn't signed.** Opening one is, and your machine takes what's typed only for 30 minutes after a signature. Inside those 30 minutes, a broken-into server could type in it. Close a terminal when you're done with it.
- **The page that asks for your passkey comes from the server.** A broken-into server could ask you to sign something other than what you clicked.

**What it changes outside its own folder.**

| Where | What | Undone by |
|---|---|---|
| `~/.agentbook/` | Its database, log, login token and settings. Only you can read them. | `agentbook-cli uninstall --purge` |
| Claude Code | The plugin: hooks that run on every session, an MCP server with the `ab_*` tools, and a skill. | `agentbook-cli uninstall` |
| `~/.claude.json` | Marks a folder as trusted when you add it as a workspace or press **Trust and retry**. A trusted folder's own settings and hooks take effect. | Claude Code's trust prompt or settings. `agentbook-cli` won't remove it. |
| `~/.codex/config.toml` | If you agree at login, adds `[mcp_servers.agentbook]` with its tools approved. | `agentbook-cli uninstall`. Without your OK, it's never written. |
| Codex | Once you're logged in, starts Codex's app server, to follow your Codex sessions. | `AGENTBOOK_CODEX=0` turns Codex off here. |

It runs as one background process, on `127.0.0.1:4320`, and keeps running until you stop it or remove the plugin. Until you log in it does nothing: it doesn't read your sessions or start anything, and a session is told how to log in. After that it reads your agents' session files and asks them what's running: Claude Code every few seconds while a background thread is awake, and every 10 minutes otherwise. Apart from your server, it only connects to what your own setup points it at: git remotes, an OpenClaw gateway you paired, and Anthropic's or Devin's API if you gave it a key.

## Install steps

These are written for the agent doing the install. If that's you, run the commands yourself rather than asking the person to, and follow these rules:

- **Stop at a failed check.** Say what failed. Don't work around it, and don't install Node, Claude Code or anything else that isn't listed here unless the person says to.
- **Only the person approves the login.** Show them the link. Never open it as them, ask for their password or passkey, or try to approve it.
- **Change nothing else.** Don't edit `gate.json`, share extra folders, or touch their agents' settings.

### 1. Get the OK and the server's address

Tell the person, in a few lines, what [What it does on your machine](#what-it-does-on-your-machine) says: what goes to the server, what the server can ask of the machine, and what changes. Ask whether to go ahead, and for their server's address unless they gave it. If they have no account on a server yet, stop: they need an invite first.

Ask two more things, for step 4:

- Should their past sessions go too: Codex and Hermes from the last 14 days, and every OpenClaw session? Without a yes, only what happens from now on goes up.
- If they use Codex, should agentbook's tools be added to it, with no approval needed for them? That writes to `~/.codex/config.toml`.

### 2. Check this machine

```sh
uname -s
node --version
git --version
claude --version
```

- `uname -s` must say `Darwin` or `Linux`. On anything else, stop.
- Node must be 22.13 or newer.
- `claude` is Claude Code. Use step 3a if it's there. If it isn't, but `codex --version` works, use step 3b. If neither is there, stop: there's nothing to follow.

### 3a. With Claude Code: install the plugin

```sh
claude plugin marketplace add herval/agentbook-cli
claude plugin install agentbook@agentbook
AB="$HOME/.claude/plugins/marketplaces/agentbook/bin/agentbook-cli"
"$AB" status
```

The install says `Successfully installed plugin: agentbook@agentbook`, and `status` says `agentbook-cli isn't running`, which is right at this point. Go to step 4.

### 3b. With Codex only: get the code

```sh
git clone --depth 1 https://github.com/herval/agentbook-cli "$HOME/.agentbook-cli"
AB="$HOME/.agentbook-cli/bin/agentbook-cli"
"$AB" status
```

`status` says `agentbook-cli isn't running`, which is right at this point.

### 4. Log this machine in

`login` waits until the person approves, for up to 10 minutes, and prints the link first. So start it in the background, with its output in a file you can read while it waits. Use the address the person gave you for `SERVER`, and their answers from step 1: `--history` and `--codex-tools` are a yes, and `--no-history` and `--no-codex-tools` a no.

```sh
AB="$HOME/.claude/plugins/marketplaces/agentbook/bin/agentbook-cli"; [ -x "$AB" ] || AB="$HOME/.agentbook-cli/bin/agentbook-cli"
SERVER="https://agentbook.example"
nohup "$AB" login "$SERVER" --no-history --no-codex-tools > "${TMPDIR:-/tmp}/agentbook-login.log" 2>&1 &
sleep 3
cat "${TMPDIR:-/tmp}/agentbook-login.log"
```

The file shows a link like `https://agentbook.example/#/connect?code=ABCD-EFGH`. If it shows an error instead, stop and tell the person. `isn't HTTPS` means the address must start with `https://`, unless it's on this machine or a tailnet.

Give the person the link and ask them to open it, signed in, and approve this machine. It's the same as entering the code under **Settings → Agents → Add a machine**. The page asks for their passkey, and makes one if they have none.

When they say it's done, or every 15 seconds for up to 10 minutes, look at the file:

```sh
cat "${TMPDIR:-/tmp}/agentbook-login.log"
```

It's finished when the file has `Logged in to`. If it has `Nobody approved it in time`, run this step again.

### 5. Check it

```sh
AB="$HOME/.claude/plugins/marketplaces/agentbook/bin/agentbook-cli"; [ -x "$AB" ] || AB="$HOME/.agentbook-cli/bin/agentbook-cli"
"$AB" status
rm -f "${TMPDIR:-/tmp}/agentbook-login.log"
```

It must say `Connected to` followed by the server's address. The lines under it list each agent: `not connected` is normal for agents this machine doesn't have.

### 6. Tell the person

- agentbook is on. **New sessions** show up on their page. This session doesn't: the plugin loads when a session starts.
- Their machine is on the **Machines** tab of their profile. If it shows **Sign it**, they should press it within a day of logging in. After that it's refused, and they log in again on the machine, which brings their passkeys. Until then, the machine takes nothing that can run something, so starting a thread from the page won't work.
- It shares the folders their agents have worked in, and the folder it clones repos into (`~/dev`). `agentbook-cli allow <folder>` shares another, and `agentbook-cli deny <folder>` keeps one out.
- On a machine with only Codex, nothing brings `agentbook-cli` back after a reboot: they run `agentbook-cli up`. With Claude Code, the next session starts it.

## Using it

The full path is `~/.claude/plugins/marketplaces/agentbook/bin/agentbook-cli` with Claude Code, or `~/.agentbook-cli/bin/agentbook-cli` without it. A session with the plugin has neither on its path, so use the full path, or add a line to your shell's profile:

```sh
alias agentbook-cli="$HOME/.claude/plugins/marketplaces/agentbook/bin/agentbook-cli"
```

| Command | What it does |
|---|---|
| `agentbook-cli status` | Whether it's running, which server it's connected to, and what's waiting to go up |
| `agentbook-cli login <server>` | Log this machine in. `--name <name>` names it. `--history` and `--codex-tools` agree to what it asks, each with a `--no-` form, and a later login keeps your answers. `--private` turns on Private terminals. |
| `agentbook-cli logout` | Revoke this machine's token, and stop |
| `agentbook-cli uninstall` | Log out, stop, and take it out of Codex and Claude Code. `--purge` removes `~/.agentbook` too. |
| `agentbook-cli private [on\|off]` | Keep sessions you start yourself off agentbook, on this machine, where the server can't change it |
| `agentbook-cli up`, `down` | Start or stop the background process |
| `agentbook-cli gate` | What this machine lets its server do |
| `agentbook-cli allow <folder>`, `deny <folder>` | Share a folder, or keep one out |
| `agentbook-cli approve [id] [--no]` | Let through, or refuse, a command waiting for an OK here |
| `agentbook-cli log [n]` | The last commands it took or refused |
| `agentbook-cli keys` | The passkeys it accepts. `keys export` and `keys import` copy them to another machine. |
| `agentbook-cli openclaw pair <code>` | Pair with an OpenClaw gateway |
| `agentbook-cli remote connect claude-agent` | Connect a cloud agent. `devin` is the other kind. The key comes in on stdin. |
| `agentbook-cli help`, `--version` | All of its commands, and which version this is. Neither needs it running or logged in. |

Your messages reach a Claude Code session at the end of its turn, or at its next step. To have them arrive between turns, start it with `agentbook-cli claude`, which turns on Claude Code's channels. That's a research preview: Claude Code shows a warning first and asks you to confirm, and it needs a claude.ai or Console login.

Settings come from the environment that starts it:

| Variable | Default | |
|---|---|---|
| `AGENTBOOK_HOME` | `~/.agentbook` | Its data |
| `AGENTBOOK_PORT` | `4320` | Its port, on loopback |
| `AGENTBOOK_MACHINE` | Your host name | This machine's name on the server |
| `AGENTBOOK_CLONE_DIR` | `~/dev` | Where it clones repos |
| `AGENTBOOK_CODEX`, `AGENTBOOK_OPENCLAW`, `AGENTBOOK_HERMES`, `AGENTBOOK_DSH`, `AGENTBOOK_MANAGED` | On | `0` turns that agent off here |
| `AGENTBOOK_CODEX_MCP` | On | `0` leaves `~/.codex/config.toml` alone |
| `AGENTBOOK_NOTIFY` | On | `0` turns off macOS notifications |

## Update

Claude Code doesn't update this plugin on its own unless you turn that on, in `/plugin`, under Marketplaces. If your server says a newer version is out, a line says so each time you start Claude Code, and `agentbook-cli status` says it too. Whoever runs the server sets that, and nothing else is asked: it makes no connection of its own to find out.

```sh
claude plugin marketplace update agentbook
claude plugin update agentbook@agentbook
```

The next session you start replaces the running `agentbook-cli` with the new version. Sessions already running stay on the old one until they restart.

Without Claude Code:

```sh
git -C ~/.agentbook-cli pull
~/.agentbook-cli/bin/agentbook-cli down
~/.agentbook-cli/bin/agentbook-cli up
```

## Uninstall

```sh
AB="$HOME/.claude/plugins/marketplaces/agentbook/bin/agentbook-cli"; [ -x "$AB" ] || AB="$HOME/.agentbook-cli/bin/agentbook-cli"
"$AB" uninstall
```

`uninstall` revokes this machine's token on the server, stops `agentbook-cli`, takes its entry out of `~/.codex/config.toml`, and removes the Claude Code plugin and its marketplace. Your threads stay on the server.

- **`~/.agentbook`**, your local copy of everything it followed, stays. `uninstall --purge` removes it too.
- **Without Claude Code**, run `rm -rf ~/.agentbook-cli` afterwards. It's the folder `uninstall` runs from, so it stays.
- **If you removed the plugin with `claude plugin uninstall`**, `agentbook-cli` stops by itself, but the machine stays logged in on the server. Press **Disconnect** on the **Machines** tab of your profile.

## If something's wrong

- **Its log** is `~/.agentbook/cli/cli.log`.
- **`Can't reach` in `status`**: the server is down, or the address is wrong. What your agents do waits on your machine and goes up once it's back.
- **`isn't logged in` in `status`, or from a session**: run `agentbook-cli login <server>`. Until then it follows nothing.
- **`stopped taking this machine's login` in `status`, or from a session**: its token was revoked, or something in front of your server refused it. It stops trying, but for once more as each new thread starts, and `status` says when it last tried. If something in front only refused it for a while, the next thread to start brings everything back. If it keeps refusing, run `agentbook-cli login <server>`. What your agents do waits on your machine and goes up then.
- **`too old for this server` in `status`, or on the page**: [update it](#update).
- **`didn't take this machine's threads` in `status`**: nothing is lost. It stays on your machine, and it's offered again every 5 minutes. Tell whoever runs your server, with the reason `status` gives.
- **`changes wait on the server` in `status`**: your server is older than this CLI. It keeps them, and takes them once it's updated.
- **`too big for its server` in `status`**: one change couldn't go up even alone, so it stays on your machine and everything after it went. The page goes without it. If this comes up often, a proxy in front of your server probably has a small body limit (nginx's default is 1 MB).
- **`It kept going after an error` in `status`**: it logged the error and stayed up. The stack is in its log, and it's worth reporting.
- **`It can't save to its database` in `status`**: usually a full disk. Make room and it carries on by itself. Until then, what it hasn't saved is lost if it stops.
- **`Its database couldn't be read` in `status`**: it was corrupt, so it was moved aside and a new one started. What your server has is safe, and only what hadn't reached it is in the copy. Keep the `-wal` and `-shm` beside the copy with it, and delete all three once you don't need them. A database that's only locked is never moved.
- **`needs Node 22.13 or newer`**: install or update Node, then try again.
- **`agentbook-cli can't start` from a session**: the reason, or where its log is, is in what it says.
- **`Something other than this machine's agentbook-cli answers on port 4320`**, from `status`, `up` or a session: something else of yours has its port (a dev server, say). Stop it, or set `AGENTBOOK_PORT` in your shell's profile, so sessions and the CLI agree.
- **A session doesn't show up**: only sessions started after the install do. `claude plugin list` should show `agentbook@agentbook` enabled.

## Security

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## License

agentbook-cli is source-available, not open source: you may install it and use it with an agentbook server, at work too, but not share copies of it, change it, or build on it. It is the PolyForm Strict License 1.0.0 with one permission added, in [LICENSE.md](LICENSE.md).
