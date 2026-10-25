import fs from 'node:fs';
import path from 'node:path';

/**
 * Every call vibefox makes to the outside world goes through `loggedFetch`, which
 * appends the full request and response (with secrets redacted) to
 * `<body>/logs/api/<date>.jsonl`. Router decisions and task transitions go to
 * `<body>/logs/events-<date>.jsonl`. Together they are the agent's audit trail.
 * Polls that come back empty (nothing new) are not logged.
 */

let logsDir: string | undefined = process.env.VF_LOGS_DIR;

export function configureLogs(dir: string): void {
  logsDir = dir;
  fs.mkdirSync(path.join(dir, 'api'), { recursive: true });
}

export function getLogsDir(): string | undefined {
  return logsDir;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function append(file: string, entry: unknown): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch {
    // Logging must never break the agent.
  }
}

// ---------- redaction ----------

const SECRET_KEY =
  /^(authorization|x-api-key|api[-_]?key|apikey|key|token|bot_token|secret|webhook_secret|password|cvc|cvv|code_verifier|access_token|refresh_token|client_secret|id_token|private[-_]token|x-figma-token|xi-api-key|x-goog-api-key|x-shopify-access-token|x-amz-security-token|accessjwt|refreshjwt|assertion|private_key|secret_access_key|app_password)$/i;

/** Provider token formats, so a key pasted into any text (a URL, an error, a task) never reaches a log. */
const TOKEN_PATTERNS: [RegExp, string][] = [
  [/\b(gh[pousr]_)[A-Za-z0-9]{20,}/g, '$1<redacted>'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_<redacted>'],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, 'glpat-<redacted>'],
  [/\bhf_[A-Za-z0-9]{20,}/g, 'hf_<redacted>'],
  [/\bnpm_[A-Za-z0-9]{30,}/g, 'npm_<redacted>'],
  [/\bpypi-[A-Za-z0-9_-]{40,}/g, 'pypi-<redacted>'],
  [/\b(xox[abprs]-)[A-Za-z0-9-]{10,}/g, '$1<redacted>'],
  [/\b((?:sk|rk)_(?:live|test)_)[A-Za-z0-9]{10,}/g, '$1<redacted>'],
  [/\bAIza[0-9A-Za-z_-]{35}/g, 'AIza<redacted>'],
  [/\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, '$1<redacted>'],
  [/\b(sbp_|dckr_pat_|lin_api_|ntn_|figd_|shp(?:at|ca|pa|ss)_)[A-Za-z0-9_-]{16,}/g, '$1<redacted>'],
];

function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export function redactString(s: string): string {
  let out = s
    // PEM private keys (service-account JSON, SSH keys); an unterminated block is cut to the end.
    .replace(/-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g, '-----BEGIN $1PRIVATE KEY-----<redacted>-----END $1PRIVATE KEY-----')
    .replace(/-----BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY-----(?!<redacted>)[\s\S]*/g, '-----BEGIN $1PRIVATE KEY-----<redacted>');
  for (const [re, to] of TOKEN_PATTERNS) out = out.replace(re, to);
  return out
    .replace(/bot\d{5,}:[A-Za-z0-9_-]{20,}/g, 'bot<redacted>')
    .replace(/\b(sk-(?:or-v1-|ant-)?[A-Za-z0-9_-]{8})[A-Za-z0-9_-]{8,}/g, '$1…<redacted>')
    .replace(/\b(am_|ap_|agentmail_|agentphone_)[A-Za-z0-9_-]{12,}/g, '$1<redacted>')
    .replace(/(?<![+\d])\d{15,19}(?!\d)/g, (m) => (luhn(m) ? '•••• ' + m.slice(-4) : m));
}

export function redact(value: unknown, parentKey = ''): unknown {
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, parentKey));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(k) && v != null && v !== '') out[k] = '[REDACTED]';
      else if (k === 'number' && parentKey === 'card' && typeof v === 'string') out[k] = '•••• ' + v.slice(-4);
      else out[k] = redact(v, k);
    }
    return out;
  }
  return value;
}

function headersToObject(h: HeadersInit | Headers | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  new Headers(h).forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

function parseMaybeJson(text: string): unknown {
  if (!text) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text.length > 20000 ? text.slice(0, 20000) + `…[truncated ${text.length - 20000} chars]` : text;
  }
}

function describeBody(body: BodyInit | null | undefined): unknown {
  if (body == null) return undefined;
  if (typeof body === 'string') return parseMaybeJson(body);
  if (body instanceof URLSearchParams) return Object.fromEntries(body.entries());
  if (body instanceof FormData) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of body.entries()) out[k] = typeof v === 'string' ? v : `<file ${(v as File).name} ${(v as File).size} bytes>`;
    return out;
  }
  return `<${Object.prototype.toString.call(body)}>`;
}

export interface LoggedFetchOptions {
  /** Return false to skip logging (e.g. empty long-poll responses). */
  logIf?: (status: number, body: string) => boolean;
  taskId?: string;
}

/** `logIf` for list polls: skip a 200 whose `field` is an empty array (nothing new). */
export function unlessEmpty(field: string): NonNullable<LoggedFetchOptions['logIf']> {
  const empty = new RegExp(`"${field}"\\s*:\\s*\\[\\s*\\]`);
  return (status, text) => status !== 200 || !empty.test(text);
}

export async function loggedFetch(
  service: string,
  url: string | URL,
  init: RequestInit = {},
  opts: LoggedFetchOptions = {},
): Promise<Response> {
  const started = Date.now();
  const method = (init.method ?? 'GET').toUpperCase();
  const urlStr = String(url);
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    writeApiLog({
      ts: new Date(started).toISOString(),
      service,
      taskId: opts.taskId,
      method,
      url: redactString(urlStr),
      request: { headers: redact(headersToObject(init.headers)), body: redact(describeBody(init.body)) },
      error: String((err as Error)?.message ?? err),
      durationMs: Date.now() - started,
    });
    throw err;
  }
  const text = await res.clone().text().catch(() => '<unreadable>');
  if (!opts.logIf || opts.logIf(res.status, text)) {
    writeApiLog({
      ts: new Date(started).toISOString(),
      service,
      taskId: opts.taskId,
      method,
      url: redactString(urlStr),
      request: { headers: redact(headersToObject(init.headers)), body: redact(describeBody(init.body)) },
      response: { status: res.status, headers: pickHeaders(res.headers), body: redact(parseMaybeJson(text)) },
      durationMs: Date.now() - started,
    });
  }
  return res;
}

function pickHeaders(h: Headers): Record<string, string> {
  const keep = ['content-type', 'x-request-id', 'request-id', 'x-ratelimit-remaining', 'retry-after'];
  const out: Record<string, string> = {};
  for (const k of keep) {
    const v = h.get(k);
    if (v) out[k] = v;
  }
  return out;
}

export function writeApiLog(entry: Record<string, unknown>): void {
  if (!logsDir) return;
  append(path.join(logsDir, 'api', `${today()}.jsonl`), entry);
}

export function logEvent(type: string, data: Record<string, unknown> = {}): void {
  const entry = { ts: new Date().toISOString(), type, ...(redact(data) as Record<string, unknown>) };
  if (process.env.VF_DEBUG) process.stderr.write(`[vf] ${type} ${JSON.stringify(data)}\n`);
  if (!logsDir) return;
  append(path.join(logsDir, `events-${today()}.jsonl`), entry);
}

export function log(...args: unknown[]): void {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  process.stderr.write(`${new Date().toISOString()} ${redactString(line)}\n`);
}
