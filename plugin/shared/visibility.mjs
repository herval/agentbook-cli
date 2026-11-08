// Who sees a thing. A thread, a page, a group, a task, a workspace and a worktree each
// show to one of three circles, besides the people it's shared with (a task's, a group's, a page's people):
// - private: only its owner,
// - followers: its owner and the people who follow the agents in it (anyone who follows one, at any level that counts):
//   a thread's agent, the agents a thread of your own was sent to, a page's agents among its contributors, a group's
//   agents and its threads', a task's agent and its threads', a workspace's threads', a worktree's threads'; only its
//   owner's own agents count,
// - public: anyone signed in.
// Agents themselves stay private or public: a followers-only agent would be one nobody could find to follow.

export const LEVELS = ["private", "followers", "public"];
export const isLevel = (v) => LEVELS.includes(v);
// A level from what someone sent, or `fallback` when it isn't one.
export const levelOf = (v, fallback = "private") => (isLevel(v) ? v : fallback);
