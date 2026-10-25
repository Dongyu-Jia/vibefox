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
  stdout: string;
  stderr: string;
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
        let parsed: unknown = {};
        try {
          parsed = stdout.trim() ? JSON.parse(stdout) : {};
        } catch {
          parsed = { raw: stdout.trim() };
        }
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
        resolve({ code: code ?? 1, data, stdout, stderr });
      });
    });
  }

  async authStatus(): Promise<{ authenticated: boolean; [k: string]: unknown }> {
    const r = await this.run<{ authenticated: boolean }>(['auth', 'status']);
    return { ...r.data, authenticated: Boolean(r.data?.authenticated) };
  }

  /** Starts the device flow; the parent approves in the Link app. Streams status lines to `onLine`. */
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
