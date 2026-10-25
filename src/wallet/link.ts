import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../core/paths.ts';
import { redact, writeApiLog } from '../core/log.ts';

/**
 * Stripe Link agent wallet, driven through the official open-source `link-cli`.
 * Card credentials are written straight to a 0600 file by link-cli itself;
 * stdout (and therefore our logs) only ever carries brand + last4.
 */

export interface LinkResult<T = Record<string, unknown>> {
  code: number;
  data: T;
  /** Everything link-cli printed, parsed (a list when the command yields several objects). */
  parsed: unknown;
  stdout: string;
  stderr: string;
}

export interface LoginStart {
  /** Link already trusts this Mac; nothing for the parent to approve. */
  already: boolean;
  verificationUrl?: string;
  /** The words the parent checks in the Link app before approving. */
  phrase?: string;
}

export function defaultLinkCli(): string {
  return process.env.VF_LINK_CLI ?? path.join(PROJECT_ROOT, 'node_modules', '.bin', 'link-cli');
}

export interface SpendRequest {
  id: string;
  status: string;
  approval_url?: string;
  amount?: number;
  currency?: string;
  merchant_name?: string;
  card?: { brand?: string; last4?: string; exp_month?: number; exp_year?: number };
  card_output_file?: string;
  status_details?: unknown;
}

function unwrap<T>(parsed: unknown): T {
  // link-cli emits either one object or a list of yielded objects; the last one is the final state.
  if (Array.isArray(parsed)) return (parsed[parsed.length - 1] ?? {}) as T;
  return parsed as T;
}

/** JSON from link-cli's stdout, even when a notice or warning line got printed before it. */
export function parseLinkOutput(stdout: string): unknown {
  const text = stdout.trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {}
  // The trailing lines that parse on their own are the JSON document (or the last JSONL record).
  const lines = text.split('\n');
  for (let i = lines.length - 1; i > 0; i--) {
    try {
      return JSON.parse(lines.slice(i).join('\n'));
    } catch {}
  }
  return { raw: text };
}

/** First string value under one of `keys`, searching nested objects and lists (link-cli's shapes vary by version and format). */
function findString(value: unknown, keys: string[], depth = 0): string | undefined {
  if (depth > 4 || value == null || typeof value !== 'object') return undefined;
  const items = Array.isArray(value) ? [...value].reverse() : [value];
  for (const item of items) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      for (const k of keys) {
        const v = (item as Record<string, unknown>)[k];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
    }
  }
  for (const item of items) {
    const children = item && typeof item === 'object' ? Object.values(item as Record<string, unknown>) : [];
    for (const child of children) {
      const found = findString(child, keys, depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

function errorText(r: LinkResult<unknown>): string {
  return findString(r.parsed, ['message']) ?? (r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`);
}

export class LinkWallet {
  private bin: string;
  private env: Record<string, string>;
  private taskId?: string;

  constructor(opts: { bin?: string; env?: Record<string, string>; taskId?: string } = {}) {
    this.bin = opts.bin ?? defaultLinkCli();
    this.env = opts.env ?? {};
    this.taskId = opts.taskId;
  }

  run<T = Record<string, unknown>>(args: string[], timeoutMs = 120_000): Promise<LinkResult<T>> {
    const started = Date.now();
    const fullArgs = [...args, '--format', 'json'];
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, fullArgs, { env: { ...process.env, LINK_CLI_SKIP_SKILL_INSTALL: '1', ...this.env }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const parsed = parseLinkOutput(stdout);
        const data = unwrap<T>(parsed);
        writeApiLog({
          ts: new Date(started).toISOString(),
          service: 'link-cli',
          taskId: this.taskId,
          method: 'EXEC',
          url: `link-cli ${args.join(' ')}`,
          response: { status: code, body: redact(parsed), stderr: stderr.trim().slice(0, 2000) || undefined },
          durationMs: Date.now() - started,
        });
        resolve({ code: code ?? 1, data, parsed, stdout, stderr });
      });
    });
  }

  async authStatus(): Promise<{ authenticated: boolean; [k: string]: unknown }> {
    const r = await this.run<{ authenticated: boolean }>(['auth', 'status']);
    return { ...r.data, authenticated: Boolean(r.data?.authenticated) };
  }

  /**
   * Starts the device flow and returns at once (`--interval 0`): the parent opens
   * the URL or the Link app, checks the phrase and approves. `authStatus()` then
   * completes the pending login; link-cli keeps it in its own credential store.
   */
  async loginStart(clientName: string): Promise<LoginStart> {
    const r = await this.run(['auth', 'login', '--client-name', clientName, '--interval', '0'], 60_000);
    const authenticated = r.code === 0 && (Array.isArray(r.parsed) ? r.parsed : [r.parsed]).some((o) => (o as { authenticated?: unknown } | null)?.authenticated === true);
    if (authenticated) return { already: true };
    const url = findString(r.parsed, ['verification_url', 'verification_url_complete', 'verificationUrl', 'verification_uri_complete']);
    const phrase = findString(r.parsed, ['phrase', 'user_code', 'userCode']);
    // The page shows this as a link, so only ever an https URL.
    if (r.code !== 0 || !url || !/^https:\/\//i.test(url)) throw new Error(`link-cli auth login failed: ${errorText(r)}`.slice(0, 800));
    return { already: false, verificationUrl: url, phrase };
  }

  async logout(): Promise<void> {
    const r = await this.run(['auth', 'logout']);
    if (r.code !== 0) throw new Error(`link-cli auth logout failed: ${errorText(r)}`.slice(0, 800));
  }

  /** Terminal wizard: starts the device flow and waits for approval. Streams status lines to `onLine`. */
  login(clientName: string, onLine: (line: string) => void): Promise<number> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, ['auth', 'login', '--client-name', clientName, '--interval', '5', '--timeout', '600'], {
        env: { ...process.env, LINK_CLI_SKIP_SKILL_INSTALL: '1', ...this.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const relay = (d: Buffer) => d.toString().split('\n').filter(Boolean).forEach(onLine);
      child.stdout.on('data', relay);
      child.stderr.on('data', relay);
      child.on('error', reject);
      child.on('close', (code) => resolve(code ?? 1));
    });
  }

  async userInfo(): Promise<Record<string, unknown>> {
    return (await this.run(['user-info', 'retrieve'])).data;
  }

  async create(input: { amountCents: number; currency?: string; merchantName: string; merchantUrl: string; context: string; test?: boolean; idempotencyKey?: string }): Promise<SpendRequest> {
    const args = [
      'spend-request', 'create',
      '--amount', String(input.amountCents),
      '--merchant-name', input.merchantName,
      '--merchant-url', input.merchantUrl,
      '--context', input.context,
      '--no-request-approval',
    ];
    if (input.currency) args.push('--currency', input.currency);
    if (input.test) args.push('--test');
    if (input.idempotencyKey) args.push('--idempotency-key', input.idempotencyKey);
    const r = await this.run<SpendRequest>(args);
    if (r.code !== 0 || !r.data?.id) throw new Error(`link-cli create failed: ${r.stderr || r.stdout}`.slice(0, 800));
    return r.data;
  }

  async requestApproval(id: string): Promise<SpendRequest> {
    const r = await this.run<SpendRequest>(['spend-request', 'request-approval', id]);
    if (r.code !== 0) throw new Error(`link-cli request-approval failed: ${r.stderr || r.stdout}`.slice(0, 800));
    return r.data;
  }

  async waitForDecision(id: string, timeoutSec: number, intervalSec = 3): Promise<SpendRequest> {
    const r = await this.run<SpendRequest>(['spend-request', 'retrieve', id, '--interval', String(intervalSec), '--timeout', String(timeoutSec)], (timeoutSec + 30) * 1000);
    if (!r.data?.status) throw new Error(`link-cli retrieve failed: ${r.stderr || r.stdout}`.slice(0, 800));
    return r.data;
  }

  async retrieveCard(id: string, outFile: string): Promise<SpendRequest> {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const r = await this.run<SpendRequest>(['spend-request', 'retrieve', id, '--include', 'card', '--output-file', outFile, '--force']);
    if (r.code !== 0) throw new Error(`link-cli card retrieval failed: ${r.stderr || r.stdout}`.slice(0, 800));
    if (fs.existsSync(outFile)) fs.chmodSync(outFile, 0o600);
    return { ...r.data, card_output_file: outFile };
  }
}
