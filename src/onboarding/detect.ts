import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { which, workerEnv } from '../workers/harness/types.ts';

/** What the parent already has on this Mac, so the agent can use it. */

export interface HarnessDetection {
  claude: { installed: boolean; loggedIn: boolean; detail?: string };
  opencode: { installed: boolean; providers: string[] };
  codex: { installed: boolean; works: boolean };
  codewhale: { installed: boolean };
  dsh: { installed: boolean };
}

export function detectHarnesses(): HarnessDetection {
  const env = workerEnv({});
  const claudeInstalled = Boolean(which('claude'));
  let loggedIn = false;
  let detail: string | undefined;
  if (claudeInstalled) {
    const r = spawnSync('claude', ['auth', 'status', '--json'], { encoding: 'utf8', env, timeout: 20_000 });
    try {
      const j = JSON.parse(r.stdout) as { loggedIn?: boolean; authMethod?: string };
      loggedIn = Boolean(j.loggedIn);
      detail = j.authMethod;
    } catch {
      detail = r.stderr.trim().slice(0, 200);
    }
  }
  const opencodeInstalled = Boolean(which('opencode'));
  const providers = opencodeInstalled ? Object.keys(readOpencodeAuth() ?? {}) : [];
  const codexInstalled = Boolean(which('codex'));
  const codexWorks = codexInstalled && spawnSync('codex', ['--version'], { encoding: 'utf8', env, timeout: 15_000 }).status === 0;
  return {
    claude: { installed: claudeInstalled, loggedIn, detail },
    opencode: { installed: opencodeInstalled, providers },
    codex: { installed: codexInstalled, works: codexWorks },
    codewhale: { installed: Boolean(which('codewhale')) },
    dsh: { installed: Boolean(which('dsh')) },
  };
}

function opencodeAuthPath(): string {
  return path.join(process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'), 'opencode', 'auth.json');
}

/** Provider names only — reading a key needs the parent's explicit consent (see importOpencodeKey). */
export function readOpencodeAuth(): Record<string, { type: string }> | undefined {
  const file = opencodeAuthPath();
  if (!fs.existsSync(file)) return undefined;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, { type: string }>;
    return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, { type: v.type }]));
  } catch {
    return undefined;
  }
}

/** Only called after the parent said yes in onboarding. */
export function importOpencodeKey(provider: string): string | undefined {
  const file = opencodeAuthPath();
  if (!fs.existsSync(file)) return undefined;
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, { type: string; key?: string }>;
  const entry = data[provider];
  return entry?.type === 'api' ? entry.key : undefined;
}
