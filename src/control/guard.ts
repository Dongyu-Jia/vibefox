import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Body } from '../core/body.ts';
import { logEvent } from '../core/log.ts';
import type { SecretStore } from '../core/secrets.ts';
import { onRead, onSecret, onWrite } from '../core/writes.ts';
import type { Resources } from '../resources/store.ts';

/**
 * Identities and resources are read-only for workers. The API enforces that;
 * this guard covers the shell: workers run as the same macOS user, so one could
 * edit or delete the files or the keychain entries directly. The guard keeps the
 * last copy the daemon itself wrote, checks a file right before the daemon reads
 * it (so a read-modify-write cannot launder an outside edit), restores anything
 * changed or removed behind the daemon's back, keeps the altered version as
 * evidence, and tells the parent. It detects and repairs; it does not isolate
 * (that needs a separate macOS user).
 */

const AGENT_SECRETS = ['openrouter_api_key', 'anthropic_api_key', 'deepseek_api_key', 'telegram_bot_token', 'agentmail_api_key', 'agentphone_api_key', 'agentphone_webhook_secret', 'daemon_token'];

export interface GuardOptions {
  body: Body;
  /** The raw store (not the watched one): the guard's own restores are not "daemon writes". */
  secrets: SecretStore;
  resources: Resources;
  notify: (text: string) => void;
  fileIntervalMs?: number;
  secretIntervalMs?: number;
}

export class Guard {
  private o: GuardOptions;
  private good = new Map<string, string | null>();
  /** name → the value the daemon last set (undefined: the daemon removed it). */
  private secretValues = new Map<string, string | undefined>();
  private timers: NodeJS.Timeout[] = [];
  private offs: (() => void)[] = [];
  private evidenceDir: string;
  private warned = new Set<string>();

  constructor(o: GuardOptions) {
    this.o = o;
    const p = o.body.paths;
    for (const f of [p.identity, p.mandate, p.workers, p.config, p.resources]) this.good.set(f, null);
    this.evidenceDir = path.join(o.body.root, 'tampered');
  }

  start(): void {
    for (const f of this.good.keys()) this.good.set(f, readOrNull(f));
    this.offs.push(
      onWrite((file, content) => {
        if (this.good.has(file)) this.good.set(file, content);
      }),
      onRead((file) => {
        if (this.good.has(file)) this.safely(() => this.checkFile(file));
      }),
      onSecret((name, value) => this.secretValues.set(name, value)),
    );
    for (const name of this.protectedSecretNames()) {
      const v = this.o.secrets.get(name);
      if (v !== undefined) this.secretValues.set(name, v);
    }
    this.timers.push(setInterval(() => this.safely(() => this.checkFiles()), this.o.fileIntervalMs ?? 2000));
    this.timers.push(setInterval(() => this.safely(() => this.checkSecrets()), this.o.secretIntervalMs ?? 30_000));
    for (const t of this.timers) t.unref();
  }

  stop(): void {
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.offs.splice(0).forEach((off) => off());
  }

  /** Restores every protected file that changed behind the daemon's back. Returns what it restored. */
  checkFiles(): string[] {
    const restored: string[] = [];
    for (const file of this.good.keys()) {
      try {
        if (this.checkFile(file)) restored.push(path.basename(file));
      } catch (err) {
        this.report(file, err);
      }
    }
    return restored;
  }

  /** Puts back credentials that disappeared from, or were changed in, the keychain behind the daemon's back. */
  checkSecrets(): string[] {
    const restored: string[] = [];
    for (const name of this.protectedSecretNames()) {
      if (!this.secretValues.has(name)) continue;
      const good = this.secretValues.get(name);
      try {
        const now = this.o.secrets.get(name);
        if (now === good) continue;
        if (good === undefined) this.o.secrets.delete(name);
        else this.o.secrets.set(name, good);
        restored.push(name);
        logEvent('guard.secret.restored', { name, what: now === undefined ? 'deleted' : good === undefined ? 'created' : 'changed' });
      } catch (err) {
        this.report(name, err);
      }
    }
    if (restored.length) this.o.notify(`🛡 我钥匙串里的 ${restored.length} 个凭证被我以外的进程改了或删了，我已经放回原样。凭证只有你能在控制台里换。`);
    return restored;
  }

  private checkFile(file: string): boolean {
    const good = this.good.get(file) ?? null;
    let now: string | null;
    let unreadable = false;
    try {
      now = readOrNull(file);
    } catch {
      now = null;
      unreadable = true; // chmod 000, a directory in its place…
    }
    if (now === good && !unreadable) return false;
    const name = path.basename(file);
    const what = unreadable ? 'made unreadable' : now === null ? 'deleted' : good === null ? 'created' : 'modified';
    if (now !== null) this.keepEvidence(name, now);
    fs.rmSync(file, { recursive: true, force: true });
    if (good !== null) {
      const tmp = `${file}.guard-${process.pid}`;
      fs.writeFileSync(tmp, good, { mode: 0o600 });
      fs.renameSync(tmp, file);
    }
    logEvent('guard.restored', { file: name, what });
    this.o.notify(`🛡 有我以外的进程${what === 'deleted' ? '删了' : '改了'}我的 ${name}（可能是某个 worker）。我已经恢复原样${now !== null ? '，被改的版本留在 tampered/ 里' : ''}。身份和资源只有你能在控制台里改。`);
    return true;
  }

  private protectedSecretNames(): string[] {
    let res: string[] = [];
    try {
      res = this.o.resources.list().flatMap((r) => r.secretFields.map((f) => `res.${r.id}.${f}`));
    } catch {}
    return [...AGENT_SECRETS, ...res, ...[...this.secretValues.keys()].filter((n) => n.startsWith('res.'))];
  }

  private keepEvidence(name: string, content: string): void {
    try {
      if (fs.existsSync(this.evidenceDir) && !fs.statSync(this.evidenceDir).isDirectory()) fs.rmSync(this.evidenceDir, { force: true });
      fs.mkdirSync(this.evidenceDir, { recursive: true, mode: 0o700 });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 8);
      fs.writeFileSync(path.join(this.evidenceDir, `${stamp}-${hash}-${name}`), content, { mode: 0o600 });
    } catch (err) {
      this.report('evidence', err);
    }
  }

  /** The guard must never take the daemon down: a failed check is logged, and the parent hears once. */
  private safely(fn: () => unknown): void {
    try {
      fn();
    } catch (err) {
      this.report('guard', err);
    }
  }

  private report(what: string, err: unknown): void {
    logEvent('guard.error', { what: path.basename(what), error: String((err as Error)?.message ?? err).slice(0, 200) });
    if (this.warned.has(what)) return;
    this.warned.add(what);
    this.o.notify(`🛡 我没能检查或恢复 ${path.basename(what)}：${String((err as Error)?.message ?? err).slice(0, 120)}。可能有进程在动我的文件夹。`);
  }
}

function readOrNull(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, 'utf8');
}
