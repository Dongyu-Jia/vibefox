import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { shortId } from '../core/store.ts';

/**
 * What every local HTTP server of vibefox enforces (the daemon API and the
 * setup server behind `vf init`): only this Mac may talk to it, under its own
 * name, with a bearer token — never a cookie, so there is nothing to forge.
 */

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const MAX_BODY_BYTES = 1_000_000;

/**
 * Host must be our own 127.0.0.1/localhost port (a DNS-rebound evil.com is
 * same-origin but sends its own Host), and a browser Origin must be ours too.
 * Returns false after answering when the request is refused.
 */
export function gate(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const port = req.socket.localPort;
  const ours = [`127.0.0.1:${port}`, `localhost:${port}`];
  const refuse = (status: number, error: string) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error }));
    return false;
  };
  if (!ours.includes(String(req.headers.host ?? ''))) return refuse(421, 'wrong host');
  const origin = req.headers.origin;
  if (origin && !ours.map((h) => `http://${h}`).includes(origin)) return refuse(403, 'cross-origin request');
  if (req.method === 'OPTIONS') return refuse(405, 'no CORS here');
  return true;
}

export async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'request too large');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error();
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'invalid json');
  }
}

export function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data ?? null));
}

/** Constant-time compare of a presented bearer token with the expected one. */
export function sameToken(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export function bearer(req: http.IncomingMessage): string | undefined {
  const m = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''));
  return m?.[1];
}

// ---------- the UI's static files ----------

const UI_DIR = path.join(import.meta.dirname, '..', 'ui');
const UI_FILES: Record<string, [string, string]> = {
  '/ui/': ['index.html', 'text/html; charset=utf-8'],
  '/ui/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/ui/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/ui/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/ui/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};

export const UI_HEADERS = {
  'content-security-policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

/** Serves `/` and the fixed list of UI files (never a path built from the URL). True when it answered. */
export function serveUi(req: http.IncomingMessage, res: http.ServerResponse, pathname: string): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (pathname === '/' || pathname === '/ui') {
    res.writeHead(302, { location: '/ui/', ...UI_HEADERS });
    res.end();
    return true;
  }
  const entry = UI_FILES[pathname];
  if (!entry) return false;
  const file = path.join(UI_DIR, entry[0]);
  if (!fs.existsSync(file)) return false;
  res.writeHead(200, { 'content-type': entry[1], ...UI_HEADERS });
  res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(file));
  return true;
}

// ---------- parent sessions ----------

/**
 * One-time codes (from `vf ui`, which proves it runs as the parent's CLI) are
 * exchanged by the page for a session token that only lives in this process.
 */
export class Sessions {
  private codes = new Map<string, number>();
  private tokens = new Map<string, number>();
  private codeTtlMs: number;
  private sessionTtlMs: number;

  constructor(opts: { codeTtlMs?: number; sessionTtlMs?: number } = {}) {
    this.codeTtlMs = opts.codeTtlMs ?? 120_000;
    this.sessionTtlMs = opts.sessionTtlMs ?? 12 * 3600_000;
  }

  issueCode(): string {
    const code = crypto.randomBytes(18).toString('base64url');
    this.codes.set(code, Date.now() + this.codeTtlMs);
    return code;
  }

  exchange(code: string): string | undefined {
    const until = this.codes.get(code);
    this.codes.delete(code);
    if (!until || until < Date.now()) return undefined;
    const token = crypto.randomBytes(32).toString('base64url');
    this.tokens.set(token, Date.now() + this.sessionTtlMs);
    return token;
  }

  check(token: string | undefined): boolean {
    if (!token) return false;
    for (const [t, until] of this.tokens) {
      if (until < Date.now()) this.tokens.delete(t);
      else if (sameToken(token, t)) return true;
    }
    return false;
  }
}

// ---------- long operations the UI polls ----------

export interface OpView {
  status: 'running' | 'done' | 'error';
  result?: unknown;
  error?: string;
  notes: string[];
}

/** Like the daemon's ops, but notes accumulate so a slow poller (or a second tab) misses nothing. */
export class Ops {
  private ops = new Map<string, OpView & { at: number }>();

  start(fn: (note: (s: string) => void) => Promise<unknown>): { opId: string } {
    const opId = shortId('op_');
    const op: OpView & { at: number } = { status: 'running', notes: [], at: Date.now() };
    this.ops.set(opId, op);
    fn((s) => op.notes.push(s))
      .then((r) => {
        op.status = 'done';
        op.result = r;
      })
      .catch((e: Error) => {
        op.status = 'error';
        op.error = e.message;
      });
    for (const [id, o] of this.ops) if (o.status !== 'running' && Date.now() - o.at > 3600_000) this.ops.delete(id);
    return { opId };
  }

  get(id: string): OpView {
    const op = this.ops.get(id);
    if (!op) throw new HttpError(404, 'no such operation');
    return { status: op.status, result: op.result, error: op.error, notes: op.notes };
  }
}
