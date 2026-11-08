// Secrets stay on the machine: what agentbook-cli sends its server (a thread's messages, steps and diffs, what its
// machine knows, the answers to its reads, what its agents write on pages and tasks) has the secrets in it replaced
// with [redacted] on the way (uplink.mjs). Its own database keeps them as they were, readable only by its person
// (cli-folder.mjs, keepPrivate), and its agents get what they're sent as it is.
//
// What counts as a secret: a token whose shape says what it is (a GitHub, Anthropic, OpenAI, AWS, Slack, Stripe,
// Google… key, a private key, a JWT), and a value a name says is one (`DB_PASSWORD=…`, `password: …`, `"api_key": "…"`,
// a password in a URL, a command's `--password`, `mysql -p…` or `curl -u`, a cookie, an Authorization header). Not a
// long random-looking string on its own: ids and hashes look like that too. A diff's hunks are read as the text they
// are, since a private key runs across lines, and across hunks. It's a net, not a proof: a secret with no name and no
// shape goes through, so what's up there is still its server's to read.
//
// A machine's gate.json can turn it off (`"redact": false`), for a server that is the machine itself.

import path from "node:path";

export const MARK = "[redacted]";

// Values that only stand in for a secret: an example, a placeholder, a variable.
const PLACEHOLDER = /^(?:x{3,}|\*{3,}|•{3,}|\.{3,}|<[^>]*>|\[[^\]]*\]|\{\{?[^}]*\}\}?|\$.*|%[A-Za-z_]+%|your[-_ ]?\w*|changeme|change[-_]me|replace[-_]?me|example\w*|sample\w*|placeholder\w*|dummy\w*|fake\w*|test(?:ing)?|secret|password|passw(?:or)?d|token|redacted|none|null|undefined|true|false|process\.env\.\w+|os\.environ.*|env\(.*|getenv\(.*)$/i;
// (Nor a number, a path, or a name: `ACCESS_TOKEN_KEY = "access_token"`.)
const real = (v) => !PLACEHOLDER.test(v) && !/^\d+$/.test(v) && !/^[\/~.]/.test(v) && !/^[a-z]+(?:[_-][a-z]+)+$/.test(v);

// The words that say a value is a secret, in any case. What comes before one is free (`db_password`, `clientSecret`,
// `aws_secret_access_key`); what comes after it isn't (`tokens`, `token_count`, `password_min`, `secretName`). `pass`
// and `pwd` count only as the end of a longer name (`db_pass`): on their own they're a test's result and a folder.
const SECRET_WORDS = "pass(?:word|wd|phrase|code)|secret(?:[_-]?key(?:[_-]?base)?)?|token|api[_-]?key|apikey|private[_-]?key|access[_-]?key|auth[_-]?key|client[_-]?key|signing[_-]?key|encryption[_-]?key|account[_-]?key|credentials?|(?<=[_.-])pass|(?<=[_.-])pwd";
// What a program writes where a value goes: a call, a member, a type, a list, an address. `password: string`, `token =
// user.token`, `secret: Secret<T>`.
const CODE = /[(\[{<>]|=>|->|::|^[A-Za-z_$][\w$]*\.[A-Za-z_$]|^\w+:\/\//;
// A value with no quotes around it: a word of letters alone is a variable or a type, so it takes a digit or a sign.
const plainSecret = (v) => v.length >= 6 && real(v) && !CODE.test(v) && /[^A-Za-z_-]/.test(v);
// One in quotes: `password: "Too short"` is a program's words, unless the name says it's a phrase.
const quotedSecret = (v, pre) => v.length >= (/pass|pwd/i.test(pre) ? 4 : 6) && real(v) && (!/\s/.test(v) || /passphrase/i.test(pre));
// `secret by its name`: what's before the secret and the secret itself, or null when the value isn't one.
function byName([pre, dq, dv, sq, sv, plain]) {
  const v = dv ?? sv;
  if (v != null) return quotedSecret(v, pre) ? [pre + (dq ?? sq), v] : null;
  return plainSecret(plain) ? [pre, plain] : null;
}

// [what it is, pattern, which group is the secret (0: all of it), or a function of the groups that says]. Order
// matters: a more particular shape before a more general one that would match it too.
const RULES = [
  ["private key", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]{0,20000}?-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|[A-Za-z0-9+/=\s:,-]*)/g, 0],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}/g, 0],
  ["OpenAI key", /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}|\bsk-[A-Za-z0-9]{32,}\b/g, 0],
  // OpenRouter's sk-or-v1-…, Langfuse's sk-lf-… and the like; Groq's, xAI's, Perplexity's, Replicate's.
  ["AI service key", /\bsk-[a-z]{2,12}-[A-Za-z0-9_-]{32,}|\b(?:gsk_[A-Za-z0-9]{40,}|xai-[A-Za-z0-9]{40,}|pplx-[A-Za-z0-9]{40,}|r8_[A-Za-z0-9]{32,})\b/g, 0],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g, 0],
  ["GitLab token", /\bgl(?:pat|dt|rt|soat|ptt|ft|imt|agent)-[A-Za-z0-9_-]{20,}/g, 0],
  ["Devin key", /\bcog_[A-Za-z0-9_-]{20,}/g, 0],
  ["Slack token", /\bxox[abposre]-[A-Za-z0-9-]{10,}|\bxapp-\d-[A-Za-z0-9-]{10,}/g, 0],
  ["Slack webhook", /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/]{20,}/g, 0],
  ["AWS access key", /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g, 0],
  ["Stripe key", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b|\bwhsec_[A-Za-z0-9]{24,}\b/g, 0],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g, 0],
  ["Google OAuth secret", /\bGOCSPX-[A-Za-z0-9_-]{28}(?![0-9A-Za-z_-])/g, 0],
  ["npm token", /\bnpm_[A-Za-z0-9]{36}\b/g, 0],
  ["Hugging Face token", /\bhf_[A-Za-z0-9]{34,}\b/g, 0],
  ["SendGrid key", /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}(?![0-9A-Za-z_-])/g, 0],
  ["Google OAuth token", /\bya29\.[A-Za-z0-9_-]{30,}/g, 0],
  ["Discord webhook", /https:\/\/(?:\w+\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{20,}/g, 0],
  ["Telegram bot token", /\b\d{8,12}:AA[A-Za-z0-9_-]{32,}/g, 0],
  ["age key", /\bAGE-SECRET-KEY-1[0-9A-Z]{50,}/g, 0],
  // Linear, Notion, Sentry, PostHog, Databricks, DigitalOcean, Vault, Docker Hub, PyPI, Supabase, Shopify, Figma, Fly,
  // Atlassian, Twilio, Mailgun, Pulumi, Doppler, Terraform Cloud.
  ["service token", /\b(?:lin_(?:api|oauth)_[A-Za-z0-9]{32,}|ntn_[A-Za-z0-9]{40,}|sntry[a-z]_[A-Za-z0-9_-]{32,}|phx_[A-Za-z0-9]{32,}|dapi[a-f0-9]{32}|do[opr]_v1_[a-f0-9]{64}|hv[sb]\.[A-Za-z0-9_-]{24,}|dckr_pat_[A-Za-z0-9_-]{20,}|pypi-[A-Za-z0-9_-]{50,}|sbp_[a-f0-9]{40}|shp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}|figd_[A-Za-z0-9_-]{32,}|fm[12]_[A-Za-z0-9+/=_-]{40,}|ATATT[A-Za-z0-9_=-]{40,}|SK[0-9a-f]{32}|key-[0-9a-f]{32}|pul-[a-f0-9]{40}|dp\.(?:pt|st|sa|ct)\.[A-Za-z0-9]{40,}|[A-Za-z0-9]{14}\.atlasv1\.[A-Za-z0-9_-]{60,})/g, 0],
  ["JWT", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, 0],
  // postgres://me:hunter22@db…, redis://:hunter22@cache…: the password.
  ["password in a URL", /\b([a-z][a-z0-9+.-]{1,20}:\/\/[^\s:/@"'<>]{0,200}:)([^\s@/"'<>]{3,200})(?=@)/gi, 2],
  ["authorization header", /\b((?:proxy-)?authorization["']?\s*[:=]\s*["']?(?:bearer|basic|token|bot)\s+)([A-Za-z0-9._~+/=-]{12,})/gi, 2],
  ["API key header", /\b((?:x-api-key|api-key|x-auth-token|x-access-token|private-token)["']?\s*[:=]\s*["']?)([A-Za-z0-9._~+/=-]{12,})/gi, 2],
  // …?access_token=…, X-Amz-Signature=… (a URL's).
  ["secret in a URL's query", /([?&](?:access_token|refresh_token|id_token|token|api_?key|apikey|key|secret|client_secret|password|passwd|sig|signature|x-amz-signature|x-amz-security-token|x-goog-signature)=)([^&\s#"'<>]{12,})/gi, 2],
  // DB_PASSWORD=…, export GITHUB_TOKEN="…", STRIPE_SECRET: … (an environment's names, in capitals).
  ["secret in the environment", /\b((?:export\s+)?[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|AUTH_?KEY|CLIENT_?KEY|CREDENTIALS?|_PASS(?![A-Z])|_PWD(?![A-Z]))[A-Z0-9_]*\s*[=:]\s*["']?)([^\s"'`#,;]{6,})/g, 2],
  // "api_key": "…", "client_secret": "…" (a JSON object's).
  ["secret in JSON", /("[A-Za-z0-9_.-]*(?:token|secret|password|passwd|passphrase|api[_-]?key|apikey|private[_-]?key|access[_-]?key|credentials?)"\s*:\s*")([^"\\\s]{8,})(?=")/gi, 2],
  // password: hunter22, aws_secret_access_key = …, db_pass='…', "secret" => "…" (a config's or a program's, in any case).
  ["secret by its name", new RegExp(String.raw`((?:${SECRET_WORDS})(?![\w-])\\?["']?[ \t]*(?:=>|:=|[:=])[ \t]*)(?:(\\?")([^"\\\n]{1,500})|(\\?')([^'\\\n]{1,500})|([^\s"'${"`"},;#)\]}]{1,500}))`, "gi"), byName],
  // password: | and the value on the next line (a YAML block).
  ["secret in a YAML block", new RegExp(String.raw`((?:${SECRET_WORDS})(?![\w-])["']?[ \t]*:[ \t]*[|>][-+]?[ \t]*\n[ \t]+)(\S[^\n]{3,500})`, "gi"), 2],
  // --password hunter22, --api-key=…, --token … (a command's flags).
  ["secret in a flag", /(\s--?(?!-|no-)[a-z0-9-]*(?:password|passwd|passphrase|token|secret|api-?key|access-key|private-key|auth-key)(?:=|\s+)["']?)([^\s"'`-][^\s"'`]{3,})/gi, 2],
  // mysql -phunter22, sshpass -p hunter22, redis-cli -a hunter22, docker login -p hunter22, openssl … pass:hunter22.
  // (Each gap is bounded: a word said over and over on one long line would otherwise take quadratic time.)
  ["password on a command line", /(\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^\n|;&]{0,400}?\s-p|\bsshpass\s+-p\s*|\bredis-cli\b[^\n|;&]{0,400}?\s-a\s+|\bdocker\s+login\b[^\n|;&]{0,400}?\s-p\s+|\s-pass(?:in|out)?\s+pass:)([^\s"'-][^\s"']{2,})/g, 2],
  // curl -u <user>:<password>, curl --user <user>:<password>.
  ["password in curl", /(\bcurl\b[^\n|;&]{0,400}?\s(?:-u\s*|--user[ =])["']?[^\s:"']{1,200}:)([^\s"']{2,})/g, 2],
  // Cookie: sid=…; other=…, curl -b 'sid=…': all of it.
  ["cookie", /\b((?:set-)?cookie["']?\s*:\s*["']?|curl\b[^\n|;&]{0,400}?\s(?:-b|--cookie)\s*["']?)([^\s"'=;]{1,200}=[^\n"']{4,})/gi, 2],
];

// A cheap first look: a string with none of these can't hold anything RULES finds.
const MAYBE = /-----BEGIN|sk-|gh[pousr]_|github_pat_|gl[a-z]+-|cog_|xox|xapp-|hooks\.slack|AKIA|ASIA|ABIA|ACCA|_live_|_test_|whsec_|AIza|GOCSPX|ya29\.|npm_|hf_|SG\.|eyJ|gsk_|xai-|pplx-|r8_|lin_|ntn_|sntr|phx_|dapi|_v1_|hv[sb]\.|dckr_|pypi-|sbp_|shp|figd_|fm[12]_|ATATT|\bSK[0-9a-f]|key-|pul-|dp\.|atlasv1|discord|:AA|AGE-SECRET|:\/\/[^\s/]*:[^\s/]*@|authorization|api-key|auth-token|access-token|private-token|SECRET|TOKEN|PASS|PWD|cookie|mysql|mariadb|curl|sshpass|redis-cli|docker\s+login|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|AUTH_?KEY|CLIENT_?KEY|SIGNING_?KEY|ENCRYPTION_?KEY|ACCOUNT_?KEY|CREDENTIAL|key"|[?&][\w-]*(?:token|key|secret|passw|sig)/i;

// A string with its secrets replaced, and what was found: { text, found: [what it is] }. `lines`: the text keeps as
// many lines as it had, a secret across lines leaving a mark on each.
export function redactText(s, { lines = false } = {}) {
  if (typeof s !== "string" || s.length < 8 || !MAYBE.test(s)) return { text: s, found: [] };
  const found = [];
  const mark = (secret) => (lines ? secret.split("\n").map(() => MARK).join("\n") : MARK);
  let out = s;
  for (const [what, re, group] of RULES) {
    out = out.replace(re, (m, ...g) => {
      if (!group) {
        found.push(what);
        return mark(m);
      }
      if (typeof group === "function") {
        const said = group(g);
        if (!said) return m;
        found.push(what);
        return said[0] + mark(said[1]);
      }
      const secret = g[group - 1];
      if (typeof secret !== "string" || !real(secret.replace(/["']$/, ""))) return m;
      found.push(what);
      return g.slice(0, group - 1).join("") + mark(secret);
    });
  }
  return { text: out, found };
}
export const redact = (s) => redactText(s).text;

// Bytes as base64 (a file's, a picture's): long, one word, and nothing to read in it.
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const opaque = (s) => s.length >= 256 && BASE64.test(s.slice(0, 256)) && BASE64.test(s.slice(-256));

// A diff's hunks, read as one text with their signs off, so what runs across lines and hunks is found (a private key
// comes a line at a time, and an edit can split it). Each line stays a line, so the hunks still add up. Null when a
// line has a line in it, and so can't be put back.
const isHunks = (v) => v.length > 0 && v.every((h) => Array.isArray(h?.lines) && h.lines.every((l) => typeof l === "string"));
function redactHunks(hunks) {
  const lines = hunks.flatMap((h) => h.lines);
  const out = redactText(lines.map((l) => l.slice(1)).join("\n"), { lines: true }).text.split("\n");
  if (out.length !== lines.length) return null;
  let n = 0;
  let changed = false;
  const next = hunks.map((h) => ({
    ...h,
    lines: h.lines.map((l) => {
      const now = out[n++];
      if (now === l.slice(1)) return l;
      changed = true;
      return l[0] + (now.length >= l.length ? now.slice(0, Math.max(l.length - 1, 1)) : now);
    }),
  }));
  return changed ? next : hunks;
}

// A value with the secrets in its strings replaced, at any depth; the same value when there were none. A string that
// would come out longer than it went in (a short secret, a longer mark) is cut to its length, so it still fits
// wherever it fit before.
export function redactDeep(v, seen = 0) {
  if (typeof v === "string") {
    if (opaque(v)) return v;
    const out = redact(v);
    return out.length > v.length ? out.slice(0, v.length) : out;
  }
  if (!v || typeof v !== "object" || seen > 64) return v;
  if (Array.isArray(v)) {
    const hunks = isHunks(v) ? redactHunks(v) : null;
    if (hunks) return hunks;
    let changed = null;
    for (let i = 0; i < v.length; i++) {
      const x = redactDeep(v[i], seen + 1);
      if (x !== v[i]) (changed ||= v.slice())[i] = x;
    }
    return changed || v;
  }
  if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return v;
  let changed = null;
  for (const k of Object.keys(v)) {
    const x = redactDeep(v[k], seen + 1);
    if (x !== v[k]) (changed ||= { ...v })[k] = x;
  }
  return changed || v;
}

// Files that are secrets as a whole, by their name or where they are: a read never sends one to the server.
// (`.env.example` and the like are what one looks like, without the secrets.)
const SECRET_NAMES = /^(?:\.env(?:\.(?!example$|sample$|template$|dist$|defaults?$)[\w.-]+)?|\.envrc|\.netrc|_netrc|\.authinfo|\.npmrc|\.yarnrc\.yml|\.pypirc|\.pgpass|\.my\.cnf|\.mylogin\.cnf|\.git-credentials|\.htpasswd|\.dockercfg|\.vault-token|\.boto|\.s3cfg|\.databrickscfg|\.sentryclirc|\.terraformrc|\.claude\.json(?:\.backup)?|\.secrets?|secrets?\.(?:ya?ml|json|toml|env)|id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?|credentials(?:\.(?:json|toml|db))?|credentials\.tfrc\.json|application_default_credentials\.json|access_tokens\.db|client_secrets?(?:_[\w.-]+)?\.json|service[-_]account[\w.-]*\.json|kubeconfig|claude_desktop_config\.json|\.?mcp(?:[-_](?:config|settings|servers))?\.json|cline_mcp_settings\.json|\.aider\.conf\.ya?ml|wallet\.dat|[\w.-]*\.(?:pem|key|p12|p8|pfx|jks|keystore|ppk|kdbx|kubeconfig|keychain(?:-db)?|ovpn|tfvars|tfstate(?:\.backup)?|asc|gpg|token))$/i;
// What a shell or a prompt kept of what was typed, passwords and tokens on command lines among it.
const HISTORY = /^(?:\.[\w-]*hist(?:ory|file)?|fish_history|\.lesshst|\.viminfo)$/i;
const SECRET_DIRS = new Set([".ssh", ".aws", ".gnupg", ".gcloud", ".azure", ".kube", ".docker", ".password-store", ".agentbook", ".oci", ".terraform.d", ".vault", ".op", ".1password", ".tsh", ".pulumi", ".fly", ".vercel", ".wrangler", ".ngrok2", ".mozilla", ".thunderbird"]);
// The same two folders down: the logins other tools keep, a browser's profile, the conversations agents kept.
const SECRET_PLACES = /(?:^|\/)(?:\.config\/(?:gh|hub|gcloud|op|doctl|rclone|sops|fly|flyctl|netlify|configstore|ngrok|github-copilot|google-chrome|chromium|BraveSoftware|goose|amp|opencode)|\.local\/share\/(?:keyrings|atuin|opencode)|\.openclaw\/credentials|\.continue\/mcpServers|Library\/(?:Keychains|Cookies|Application Support\/(?:Google\/Chrome|Firefox|BraveSoftware|Microsoft Edge))|\.claude\/(?:projects|sessions|shell-snapshots)|\.codex\/(?:sessions|archived_sessions))\//i;
// Agents' settings, which name their MCP servers with the tokens those take (env values, headers), or keep
// their logins: Claude Code's settings.json and settings.local.json (and the managed one), Codex's config.toml,
// Gemini's, Hermes', Continue's, OpenClaw's (and its backups), Zed's.
const AGENT_CONFIGS = /(?:^|\/)(?:\.claude\/settings(?:\.local)?\.json|managed-settings\.json|\.codex\/(?:[^/]+\/)*config\.toml|\.gemini\/(?:[^/]+\/)*(?:settings|oauth_creds|google_accounts|mcp-oauth-tokens)\.json|\.hermes\/(?:[^/]+\/)*(?:config\.ya?ml|auth\.json)|\.continue\/(?:[^/]+\/)*config\.(?:json|ya?ml|ts)|\.openclaw\/(?:[^/]+\/)*(?:openclaw\.json[\w.-]*|auth-profiles\.json|service-env)|\.config\/zed\/settings\.json)$/i;
// -> why a file is kept on the machine, or null.
export function secretFile(p) {
  const parts = String(p || "").split(/[\\/]+/).filter(Boolean);
  const name = parts.at(-1) || "";
  if ((SECRET_NAMES.test(name) || HISTORY.test(name)) && !/\.pub$/i.test(name)) return `${name} holds secrets`;
  const dir = parts.slice(0, -1).find((d) => SECRET_DIRS.has(d.toLowerCase()));
  if (dir) return `it's in ${dir}, which holds secrets`;
  if (SECRET_PLACES.test(`${parts.join("/")}`)) return `it's where ${parts.includes(".claude") || parts.includes(".codex") ? "an agent keeps its conversations" : "a tool keeps its login"}`;
  if (parts.includes(".claude") && /^(?:\.?credentials\.json|history\.jsonl)$/i.test(name)) return `${name} holds secrets`;
  if ((parts.includes(".codex") || parts.includes(".composer")) && /^(?:auth\.json|history\.jsonl)$/i.test(name)) return `${name} holds secrets`;
  if (AGENT_CONFIGS.test(parts.join("/"))) return `${name} holds an agent's logins or its MCP servers' tokens`;
  return null;
}
export const secretFileRefusal = (p) => {
  const why = secretFile(p);
  return why ? `agentbook doesn't send ${path.basename(String(p))} to its server: ${why}.` : null;
};
