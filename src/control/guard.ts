import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Body } from '../core/body.ts';
import { logEvent } from '../core/log.ts';
import type { SecretStore } from '../core/secrets.ts';
import { onWrite } from '../core/writes.ts';
import type { Resources } from '../resources/store.ts';

/**
 * Identities and resources are read-only for workers. The API enforces that;
 * this guard covers the shell: workers run as the same macOS user, so one could
 * edit or delete the files or the keychain entries directly. The guard keeps the
 * last copy the daemon itself wrote, restores it when anything else changes or
 * removes it, keeps the altered version as evidence, and tells the parent.
 * It detects and repairs; it does not isolate (that needs a separate macOS user).
 */

const AGENT_SECRETS = ['openrouter_api_key', 'anthropic_api_key', 'deepseek_api_key', 'telegram_bot_token', 'agentmail_api_key', 'agentphone_api_key', 'agentphone_webhook_secret', 'daemon_token'];

export interface GuardOptions {
  body: Body;
  secrets: SecretStore;
  resources: Resources;
  notify: (text: string) => void;
  fileIntervalMs?: number;
  secretIntervalMs?: number;
}

export class Guard {
  private o: GuardOptions;
  private files: string[];
  private good = new Map<string, string | null>();
  private secretValues = new Map<string, string>();
  private timers: NodeJS.Timeout[] = [];
  private off?: () => void;
  private evidenceDir: string;

  constructor(o: GuardOptions) {
    this.o = o;
    const p = o.body.paths;
    this.files = [p.identity, p.mandate, p.workers, p.config, p.resources].filter(Boolean);
    this.evidenceDir = path.join(o.body.root, 'tampered');
  }

  start(): void {
    for (const f of this.files) this.good.set(f, fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
    this.off = onWrite((file, content) => {
      if (!this.good.has(file)) return;
      this.good.set(file, content);
      // A resource the parent just added: start protecting its credentials right away.
      if (file === this.o.body.paths.resources) this.refreshSecrets();
    });
    this.refreshSecrets();
    this.timers.push(setInterval(() => this.checkFiles(), this.o.fileIntervalMs ?? 2000));
    this.timers.push(setInterval(() => this.checkSecrets(), this.o.secretIntervalMs ?? 30_000));
    for (const t of this.timers) t.unref();
  }

  stop(): void {
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.off?.();
  }

  /** Restores any protected file that changed behind the daemon's back. Returns what it restored. */
  checkFiles(): string[] {
    const restored: string[] = [];
    for (const [file, good] of this.good) {
      const now = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      if (now === good) continue;
      const name = path.basename(file);
      const what = now === null ? 'deleted' : good === null ? 'created' : 'modified';
      if (now !== null) this.keepEvidence(name, now);
      if (good === null) fs.rmSync(file, { force: true });
      else fs.writeFileSync(file, good, { mode: fs.existsSync(file) ? undefined : 0o600 });
      restored.push(name);
      logEvent('guard.restored', { file: name, what });
      this.o.notify(`🛡 有我以外的进程${what === 'deleted' ? '删了' : '改了'}我的 ${name}（可能是某个 worker）。我已经恢复原样${now !== null ? '，被改的版本留在 tampered/ 里' : ''}。身份和资源只有你能在控制台里改。`);
    }
    if (restored.length) this.refreshSecrets();
    return restored;
  }

  /** Puts back credentials that disappeared from the keychain while their resource still exists. */
  checkSecrets(): string[] {
    const restored: string[] = [];
    for (const name of this.protectedSecretNames()) {
      const v = this.o.secrets.get(name);
      if (v) this.secretValues.set(name, v);
      else if (this.secretValues.has(name)) {
        this.o.secrets.set(name, this.secretValues.get(name)!);
        restored.push(name);
        logEvent('guard.secret.restored', { name });
      }
    }
    if (restored.length) this.o.notify(`🛡 我的钥匙串里有 ${restored.length} 个凭证被我以外的进程删了，我已经放回去了。`);
    return restored;
  }

  private protectedSecretNames(): string[] {
    const res = this.o.resources.list().flatMap((r) => r.secretFields.map((f) => `res.${r.id}.${f}`));
    return [...AGENT_SECRETS, ...res];
  }

  private refreshSecrets(): void {
    const names = new Set(this.protectedSecretNames());
    for (const n of [...this.secretValues.keys()]) if (!names.has(n)) this.secretValues.delete(n);
    for (const n of names) {
      const v = this.o.secrets.get(n);
      if (v) this.secretValues.set(n, v);
    }
  }

  private keepEvidence(name: string, content: string): void {
    fs.mkdirSync(this.evidenceDir, { recursive: true, mode: 0o700 });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 8);
    fs.writeFileSync(path.join(this.evidenceDir, `${stamp}-${hash}-${name}`), content, { mode: 0o600 });
  }
}
