import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

/**
 * An agent's own secrets live in the macOS login keychain (service `vibefox.<slug>`),
 * never in the body folder's JSON files; tests and non-macOS machines use a 0600 file.
 * The parent's keys (`vf keys`) live in a local key file, see KeyFileStore.
 * `VF_SECRET_<NAME>` environment variables always win, which keeps CI simple.
 */
export interface SecretStore {
  get(name: string): string | undefined;
  set(name: string, value: string): void;
  delete(name: string): void;
  kind: 'keychain' | 'file';
}

export const SECRET_NAMES = [
  'openrouter_api_key',
  'anthropic_api_key',
  'deepseek_api_key',
  'telegram_bot_token',
  'agentmail_api_key',
  'agentphone_api_key',
  'agentphone_webhook_secret',
  'daemon_token',
] as const;

function envOverride(name: string): string | undefined {
  return process.env[`VF_SECRET_${name.toUpperCase()}`] || undefined;
}

class KeychainStore implements SecretStore {
  kind = 'keychain' as const;
  service: string;
  constructor(slug: string) {
    this.service = `vibefox.${slug}`;
  }
  get(name: string): string | undefined {
    const env = envOverride(name);
    if (env) return env;
    const r = spawnSync('security', ['find-generic-password', '-s', this.service, '-a', name, '-w'], { encoding: 'utf8' });
    if (r.status !== 0) return undefined;
    return r.stdout.replace(/\n$/, '') || undefined;
  }
  set(name: string, value: string): void {
    // `security -i` reads the command from stdin so the secret never shows up in `ps`.
    const quoted = (s: string) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    const cmd = `add-generic-password -U -s ${quoted(this.service)} -a ${quoted(name)} -w ${quoted(value)}\n`;
    const r = spawnSync('security', ['-i'], { input: cmd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`keychain write failed for ${name}: ${r.stderr}`);
  }
  delete(name: string): void {
    spawnSync('security', ['delete-generic-password', '-s', this.service, '-a', name], { encoding: 'utf8' });
  }
}

class FileStore implements SecretStore {
  kind = 'file' as const;
  file: string;
  constructor(file: string) {
    this.file = file;
  }
  private read(): Record<string, string> {
    if (!fs.existsSync(this.file)) return {};
    return JSON.parse(fs.readFileSync(this.file, 'utf8')) as Record<string, string>;
  }
  get(name: string): string | undefined {
    return envOverride(name) ?? this.read()[name];
  }
  set(name: string, value: string): void {
    const data = this.read();
    data[name] = value;
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2), { mode: 0o600 });
  }
  delete(name: string): void {
    const data = this.read();
    delete data[name];
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2), { mode: 0o600 });
  }
}

/**
 * A dotenv key file (`OPENROUTER_API_KEY=sk-or-…`, one per line; `#` comments kept).
 * Always written 0600, and tightened to 0600 if found looser. It must be gitignored.
 */
export class KeyFileStore implements SecretStore {
  kind = 'file' as const;
  file: string;
  constructor(file: string) {
    this.file = file;
  }
  private lines(): string[] {
    if (!fs.existsSync(this.file)) return [];
    if (fs.statSync(this.file).mode & 0o077) fs.chmodSync(this.file, 0o600);
    return fs.readFileSync(this.file, 'utf8').split('\n');
  }
  private write(lines: string[]): void {
    fs.writeFileSync(this.file, lines.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
    fs.chmodSync(this.file, 0o600);
  }
  get(name: string): string | undefined {
    const env = envOverride(name);
    if (env) return env;
    for (const line of this.lines()) {
      const m = KEY_LINE.exec(line);
      if (m && m[1] === name.toUpperCase()) return unquote(m[2]) || undefined;
    }
    return undefined;
  }
  set(name: string, value: string): void {
    const key = name.toUpperCase();
    const entry = `${key}=${/[\s#'"\\]/.test(value) ? JSON.stringify(value) : value}`;
    const lines = this.lines();
    const at = lines.findIndex((l) => KEY_LINE.exec(l)?.[1] === key);
    if (at >= 0) lines[at] = entry;
    else lines.splice(lines.length && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length, 0, entry);
    this.write(lines);
  }
  delete(name: string): void {
    this.write(this.lines().filter((l) => KEY_LINE.exec(l)?.[1] !== name.toUpperCase()));
  }
}

const KEY_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

function unquote(v: string): string {
  if (/^".*"$/.test(v)) return JSON.parse(v) as string;
  if (/^'.*'$/.test(v)) return v.slice(1, -1);
  return v.replace(/\s+#.*$/, '');
}

export function openSecrets(slug: string, secretsFile: string): SecretStore {
  const mode = process.env.VF_SECRETS ?? (process.platform === 'darwin' ? 'keychain' : 'file');
  return mode === 'file' ? new FileStore(secretsFile) : new KeychainStore(slug);
}
