// Why something couldn't start, in words that say what to do about it, from what the tool underneath said (git's
// "could not read Username for 'https://github.com': terminal prompts disabled", Codex's "unexpected status 401
// Unauthorized: Missing bearer or basic authentication in header, url: …"). What isn't known here is said as it came.
// `machine`: the machine's name, since the fix is made there.

// git clone: `message` is git's last line, without its "fatal: ".
export function cloneWhy(url, message, machine = "this machine") {
  const said = String(message || "").trim();
  const host = (String(url).match(/^(?:https?:\/\/|ssh:\/\/(?:[^@/]+@)?|[^@/]+@)([^/:]+)/) || [])[1] || "its host";
  const where = /github\.com$/i.test(host) ? "GitHub" : host;
  let why = said;
  if (/could not read (Username|Password)|terminal prompts disabled|Authentication failed|Invalid username or (password|token)|HTTP Basic: Access denied/i.test(said)) why = `${machine} isn't signed in to ${where}, so git can't read this repo there (a private one, or one ${where} doesn't have). Sign git in on ${machine}${where === "GitHub" ? " (gh auth login, then gh auth setup-git)" : ""}, or start in a folder it already has.`;
  else if (/Permission denied \(publickey\)|Host key verification failed|Could not read from remote repository/i.test(said)) why = `${machine} has no SSH key that ${where} takes for this repo. Add its key there, or start in a folder it already has.`;
  else if (/Repository not found|not found$|does not appear to be a git repository/i.test(said)) why = `${where} has no such repo, or ${machine}'s sign-in there can't see it.`;
  else if (/Could not resolve host|unable to access|Connection (timed out|refused)|Network is unreachable/i.test(said)) why = `${machine} can't reach ${where} (${said.replace(/\.$/, "")}).`;
  else if (/No space left on device/i.test(said)) why = `${machine}'s disk is full.`;
  return `Couldn't clone ${url}: ${why}`;
}

// A Codex turn that stopped: `message` is what Codex's app-server said of it.
export function codexWhy(message, machine = "this machine") {
  const said = String(message || "").trim();
  if (/401 Unauthorized|Missing bearer or basic authentication|Not logged in|not signed in|refresh token|token (is )?expired|invalid_api_key|Incorrect API key/i.test(said)) return `Codex isn't signed in on ${machine}, so it can't answer. Sign it in there (codex login), or give it an OPENAI_API_KEY, then send your message again.`;
  if (/usage limit|rate limit reached|quota/i.test(said)) return `Codex's plan on ${machine} is out of usage for now: ${said}`;
  return said;
}
