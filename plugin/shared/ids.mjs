// Names both sides use.

// A machine's name, as agentbook-server knows it: lowercase letters, digits and dashes ("mac-mini", "laptop-alice").
// The birds threads are named after (a thread's is its process's: bird() in plugin/lib/common.mjs).
export const BIRDS = ["osprey", "wren", "kite", "heron", "finch", "swift", "tern", "lark", "robin", "egret", "plover", "jay", "owl", "crane", "ibis", "rook", "gull", "petrel", "dove", "hawk", "raven", "swallow", "starling", "sparrow"];

export const machineName = (name) => String(name || "machine").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "") || "machine";
