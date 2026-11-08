// What tells a repo apart wherever it's checked out, and how to clone it. Pure: both sides use them.

// What tells a repo apart wherever it's checked out: "github.com/acme/core-api", from any way of writing it
// (git@github.com:acme/core-api.git, https://github.com/acme/core-api, github.com/acme/core-api, or acme/core-api
// for GitHub). Null when it doesn't name a repo.
export function repoKey(input) {
  const s = String(input || "").trim();
  let host;
  let p;
  let m;
  if ((m = s.match(/^[\w.-]+@([\w.-]+):(?!\/\/)(.+)$/))) [host, p] = [m[1], m[2]];
  else if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      [host, p] = [u.hostname || u.protocol.replace(/:$/, ""), decodeURIComponent(u.pathname)];
    } catch {
      return null;
    }
  } else if ((m = s.match(/^([\w-]+(?:\.[\w-]+)+)\/(.+)$/))) [host, p] = [m[1], m[2]];
  else if (/^[\w-]+\/[\w.-]+$/.test(s)) [host, p] = ["github.com", s];
  else return null;
  p = p.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  return p.includes("/") ? `${host}/${p}`.toLowerCase() : null;
}
// The URL to clone a repo from: a URL as it's given, and acme/core-api or github.com/acme/core-api over https.
export function cloneUrl(input) {
  const s = String(input || "").trim();
  if (!repoKey(s)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^[\w.-]+@[\w.-]+:/.test(s)) return withoutSecrets(s);
  const bare = s.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  return `https://${bare.split("/")[0].includes(".") ? "" : "github.com/"}${bare}.git`;
}

// A URL without the password or token some remotes carry (https://me:token@host/…): it gets shown and stored.
export function withoutSecrets(url) {
  if (!url || !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
  try {
    const u = new URL(url);
    u.password = "";
    if (/^https?:$/.test(u.protocol)) u.username = "";
    return u.toString();
  } catch {
    return url;
  }
}
