// Names both sides use.

// A machine's name, as agentbook-server knows it: lowercase letters, digits and dashes ("mac-mini", "laptop-alice").
// The birds threads are named after (a thread's is its process's: bird() in plugin/lib/common.mjs).
export const BIRDS = ["osprey", "wren", "kite", "heron", "finch", "swift", "tern", "lark", "robin", "egret", "plover", "jay", "owl", "crane", "ibis", "rook", "gull", "petrel", "dove", "hawk", "raven", "swallow", "starling", "sparrow"];

// A person's seat on a shared machine is a Linux user named as they are on agentbook, when that can be one: lowercase
// letters, digits, - and _, starting with a letter, and not a name Linux machines have for themselves.
export const SEAT_RESERVED = ["root", "nobody", "user", "ubuntu", "debian", "admin", "agents", "daemon", "bin", "sys", "www-data", "sshd", "git"];
export const seatNameOk = (name) => /^[a-z][a-z0-9_-]{0,31}$/.test(String(name || "")) && !SEAT_RESERVED.includes(name);
export const machineName = (name) => String(name || "machine").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "") || "machine";
