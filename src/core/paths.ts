import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');
export const VF_BIN = path.join(PROJECT_ROOT, 'bin', 'vf.ts');
export const PROJECT_BIN_DIR = path.join(PROJECT_ROOT, 'bin');

/** Root of all vibefox state. One machine can hold several agent bodies. */
export function vfRoot(): string {
  return process.env.VF_HOME ?? path.join(os.homedir(), '.vibefox');
}

export function agentsDir(): string {
  return path.join(vfRoot(), 'agents');
}

export function currentAgentSlug(): string | undefined {
  if (process.env.VF_AGENT) return process.env.VF_AGENT;
  const file = path.join(vfRoot(), 'current');
  if (!fs.existsSync(file)) return undefined;
  const slug = fs.readFileSync(file, 'utf8').trim();
  return slug || undefined;
}

export function setCurrentAgent(slug: string): void {
  fs.mkdirSync(vfRoot(), { recursive: true });
  fs.writeFileSync(path.join(vfRoot(), 'current'), slug + '\n');
}

export function bodyRoot(slug?: string): string {
  const s = slug ?? currentAgentSlug();
  if (!s) throw new Error('No agent yet. Run `vf init` to give birth to one.');
  return path.join(agentsDir(), s);
}

/** The agent *is* this folder: identity, soul, permissions, memory, journal, tasks. */
export interface BodyPaths {
  root: string;
  identity: string;
  soul: string;
  mandate: string;
  routing: string;
  routingHistory: string;
  workers: string;
  config: string;
  onboarding: string;
  db: string;
  memory: string;
  journal: string;
  workspace: string;
  logs: string;
  apiLogs: string;
  browserProfile: string;
  recordings: string;
  wallet: string;
  keys: string;
  secretsFile: string;
  daemonJson: string;
}

export function bodyPaths(root: string): BodyPaths {
  return {
    root,
    identity: path.join(root, 'identity.json'),
    soul: path.join(root, 'SOUL.md'),
    mandate: path.join(root, 'mandate.json'),
    routing: path.join(root, 'routing.md'),
    routingHistory: path.join(root, 'routing.history'),
    workers: path.join(root, 'workers.json'),
    config: path.join(root, 'config.json'),
    onboarding: path.join(root, 'onboarding.json'),
    db: path.join(root, 'tasks.db'),
    memory: path.join(root, 'memory'),
    journal: path.join(root, 'journal'),
    workspace: path.join(root, 'workspace'),
    logs: path.join(root, 'logs'),
    apiLogs: path.join(root, 'logs', 'api'),
    browserProfile: path.join(root, 'browser', 'profile'),
    recordings: path.join(root, 'recordings'),
    wallet: path.join(root, 'wallet'),
    keys: path.join(root, 'keys'),
    secretsFile: path.join(root, 'secrets.json'),
    daemonJson: path.join(root, 'daemon.json'),
  };
}

export function ensureBodyDirs(p: BodyPaths): void {
  for (const dir of [p.root, p.routingHistory, p.memory, p.journal, p.workspace, p.logs, p.apiLogs, p.browserProfile, p.recordings, p.wallet, p.keys]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function slugify(name: string): string {
  const s = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'agent';
}
