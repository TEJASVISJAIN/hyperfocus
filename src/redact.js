import { basename } from 'node:path';

const REDACTED = '[redacted]';

// Token formats with a recognisable shape. Checked before the generic "name = value" rule.
const TOKEN_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, // Anthropic, OpenAI
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWT
];

// `"apiKey": "…"`, `client_secret: '…'`: an identifier, then a quoted value (spaces allowed).
const QUOTED_ASSIGNMENT = /(?<![A-Za-z0-9_])([A-Za-z_][A-Za-z0-9_-]*)(["']?\s*[:=]\s*)(["'])([^"'\n]{6,})\3/g;
// `DB_PASSWORD=…` and `export API_TOKEN=…`: env-file style, unquoted.
const ENV_ASSIGNMENT = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)=([^\s"']{6,})/gm;
// `Authorization: Bearer …`, `--password=…`, `mysql -p"…"`.
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g;
const PASSWORD_FLAG = /(--(?:password|passwd|token|secret|api-key|access-token)[= ])(["']?)([^\s"']{4,})\2/gi;
const MYSQL_PASSWORD = /(\s-p)(["'])([^"']{4,})\2/g;

// A name is secret when its last word is: `clientSecret`, `DB_PASSWORD`, `api_key`, but not
// `author`, `authDomain`, `tokenizer` or `tokenCount`.
const SECRET_WORDS = new Set(['password', 'passwd', 'pwd', 'secret', 'token', 'credential', 'credentials']);
const KEY_QUALIFIERS = new Set(['api', 'access', 'private', 'secret', 'signing', 'encryption']);
function isSecretName(name) {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
  const last = words.at(-1);
  if (SECRET_WORDS.has(last)) return true;
  return (last === 'key' && KEY_QUALIFIERS.has(words.at(-2))) || last === 'apikey';
}

/** Hides credentials in text hyperfocus is about to show or send to the quiz model. */
export function redactSecrets(text) {
  let result = String(text);
  for (const pattern of TOKEN_PATTERNS) result = result.replace(pattern, REDACTED);
  result = result.replace(BEARER, (match, scheme) => `${scheme} ${REDACTED}`);
  result = result.replace(PASSWORD_FLAG, (match, flag, quote) => flag + quote + REDACTED + quote);
  result = result.replace(MYSQL_PASSWORD, (match, flag, quote) => flag + quote + REDACTED + quote);
  result = result.replace(QUOTED_ASSIGNMENT, (match, name, separator, quote, value) =>
    isSecretName(name) && value !== REDACTED ? name + separator + quote + REDACTED + quote : match,
  );
  return result.replace(ENV_ASSIGNMENT, (match, prefix, name, value) => (isSecretName(name) && value !== REDACTED ? `${prefix}${name}=${REDACTED}` : match));
}

const SENSITIVE_FILE = /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.pgpass|credentials(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|.*\.(?:pem|key|p12|pfx|keystore|jks))$/i;

/** Files whose whole point is holding secrets: hyperfocus names them but never reads their contents. */
export const isSensitivePath = (path) => SENSITIVE_FILE.test(basename(path));
