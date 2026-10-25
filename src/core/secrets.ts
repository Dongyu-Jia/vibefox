import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

/**
 * Secrets live in the macOS login keychain (service `vibefox.<slug>`), never in
 * the body folder's JSON files. Tests and non-macOS machines use a 0600 file.
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

export function openSecrets(slug: string, secretsFile: string): SecretStore {
  const mode = process.env.VF_SECRETS ?? (process.platform === 'darwin' ? 'keychain' : 'file');
  return mode === 'file' ? new FileStore(secretsFile) : new KeychainStore(slug);
}
