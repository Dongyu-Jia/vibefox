import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Body } from '../core/body.ts';
import { logEvent, redactString } from '../core/log.ts';
import type { SecretStore } from '../core/secrets.ts';
import { totp } from '../core/totp.ts';
import { resourceKind, type CredentialField, type CredentialMethod, type ResourceKind, type VerifyResult } from './catalog.ts';

/**
 * The agent's resources: `<body>/resources.json` says *what* each one is (kind, handle,
 * who opened it, how much power, whether it checked out); the credential values live
 * only in the agent's secret store as `res.<id>.<field>`. The file is re-read on every
 * call and replaced atomically, so the daemon and `vf` commands can share it.
 */

export interface Resource {
  id: string;
  kind: string;
  label: string;
  handle?: string;
  origin: 'parent' | 'self';
  access: 'full' | 'scoped' | 'read' | 'unknown';
  method: CredentialMethod | 'none';
  parent?: string;
  status: 'ok' | 'unverified' | 'failed' | 'pending';
  verifiedAt?: string;
  lastError?: string;
  /** What the last successful check said (e.g. which scopes a token lacks). */
  verifyDetail?: string;
  /** Names only. */
  secretFields: string[];
  /** Non-secret values (username, instance URL, project id…). */
  fields?: Record<string, string>;
  addedAt: string;
  addedBy: 'parent' | 'agent';
  note?: string;
}

export interface AddResourceInput {
  kind: string;
  id?: string;
  label?: string;
  handle?: string;
  origin?: 'parent' | 'self';
  access?: Resource['access'];
  method?: Resource['method'];
  fields?: Record<string, string>;
  parent?: string;
  note?: string;
  status?: Resource['status'];
  addedBy?: 'parent' | 'agent';
}

/** A request the store refuses; `status` is the HTTP status the API should answer with. */
export class ResourceError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface ResourcesFile {
  version: 1;
  resources: Resource[];
}

/** Only these hand the service something it can check; a password or a browser login is never auto-tested. */
const CHECKABLE = new Set<Resource['method']>(['token', 'file']);
const USABLE = new Set<Resource['status']>(['ok', 'unverified']);
/** Extra fields a spec does not know: treat anything that sounds like a credential as one. */
const SECRETISH = /pass|secret|token|key|totp|otp|credential|private|cookie|session|dsn|connection|database_?url|db_?url/i;
const ID_RE = /^[a-z0-9][a-z0-9._:-]{0,79}$/;
const EDITABLE: (keyof Resource)[] = ['label', 'handle', 'origin', 'access', 'method', 'parent', 'status', 'verifiedAt', 'lastError', 'verifyDetail', 'note', 'addedBy'];

function slug(s: string | undefined): string {
  return (s ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

function specFor(kind: ResourceKind, method: Resource['method']): CredentialField[] {
  return method === 'none' ? [] : (kind.fields[method] ?? []);
}

export class Resources {
  body: Body;
  secrets: SecretStore;

  constructor(body: Body, secrets: SecretStore) {
    this.body = body;
    this.secrets = secrets;
  }

  private get file(): string {
    return this.body.paths.resources;
  }

  private read(): Resource[] {
    if (!fs.existsSync(this.file)) return [];
    const data = JSON.parse(fs.readFileSync(this.file, 'utf8')) as ResourcesFile | Resource[];
    return Array.isArray(data) ? data : (data.resources ?? []);
  }

  private write(list: Resource[]): void {
    const data: ResourcesFile = { version: 1, resources: list };
    const tmp = path.join(path.dirname(this.file), `.resources.json.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  list(): Resource[] {
    return this.read();
  }

  get(id: string): Resource | undefined {
    return this.read().find((r) => r.id === id);
  }

  private mustGet(list: Resource[], id: string): Resource {
    const r = list.find((x) => x.id === id);
    if (!r) throw new ResourceError(404, `没有这个资源：${id}`);
    return r;
  }

  /** Whether `field` of this resource belongs in the secret store rather than resources.json. */
  private isSecret(kind: ResourceKind, method: Resource['method'], field: string, value: string): boolean {
    const own = specFor(kind, method).find((f) => f.id === field);
    if (own) return own.secret;
    for (const m of kind.methods) {
      const other = kind.fields[m]?.find((f) => f.id === field);
      if (other) return other.secret;
    }
    // Unknown field: anything that sounds like, or looks like, a credential is one.
    return SECRETISH.test(field) || redactString(value) !== value;
  }

  private pickId(kind: ResourceKind, input: AddResourceInput, handle: string | undefined, label: string, list: Resource[]): string {
    const taken = (id: string) => list.some((r) => r.id === id);
    if (input.id) {
      const id = input.id.trim().toLowerCase();
      if (!ID_RE.test(id)) throw new ResourceError(400, `资源 id 只能用小写字母、数字和 . _ : -：${input.id}`);
      if (taken(id)) throw new ResourceError(409, `已经有一个叫 ${id} 的资源了`);
      return id;
    }
    if (!taken(kind.id)) return kind.id;
    const s = slug(handle) || (label !== kind.label ? slug(label) : '');
    const base = s ? `${kind.id}:${s}` : kind.id;
    if (s && !taken(base)) return base;
    for (let n = 2; ; n++) if (!taken(`${base}${s ? '-' : ':'}${n}`)) return `${base}${s ? '-' : ':'}${n}`;
  }

  add(input: AddResourceInput): Resource {
    const kind = resourceKind(input.kind);
    if (!kind) throw new ResourceError(400, `不认识的资源类型：${input.kind}`);
    const method = input.method ?? kind.methods[0] ?? 'none';
    if (method !== 'none' && !kind.methods.includes(method)) throw new ResourceError(400, `${kind.label} 不支持 ${method} 方式`);
    const status = input.status ?? 'unverified';
    const values: Record<string, string> = {};
    for (const [k, v] of Object.entries(input.fields ?? {})) if (typeof v === 'string' && v.trim()) values[k] = k === 'password' || k === 'appPassword' ? v : v.trim();
    // A draft (`pending`: the parent is still signing up) may be missing anything.
    if (status !== 'pending') {
      const lack = specFor(kind, method).filter((f) => !f.optional && !values[f.id]);
      if (lack.length) throw new ResourceError(400, `还缺：${lack.map((f) => f.label).join('、')}`);
    }

    const plain: Record<string, string> = {};
    const secret: Record<string, string> = {};
    for (const [k, v] of Object.entries(values)) (this.isSecret(kind, method, k, v) ? secret : plain)[k] = v;
    const handle = input.handle?.trim() || plain.username || plain.handle || plain.email || plain.domain || plain.shop || plain.login || undefined;
    const label = input.label?.trim() || (kind.id === 'custom' && plain.name) || kind.label;

    const list = this.read();
    const id = this.pickId(kind, input, handle, label, list);
    // Secrets first: if the keychain refuses, nothing half-made is left in resources.json.
    for (const [k, v] of Object.entries(secret)) this.secrets.set(`res.${id}.${k}`, v);
    const addedBy = input.addedBy ?? 'parent';
    const res: Resource = {
      id,
      kind: kind.id,
      label,
      ...(handle ? { handle } : {}),
      origin: input.origin ?? (addedBy === 'agent' ? 'self' : 'parent'),
      access: input.access ?? 'unknown',
      method,
      ...(input.parent ? { parent: input.parent } : {}),
      status,
      secretFields: Object.keys(secret),
      ...(Object.keys(plain).length ? { fields: plain } : {}),
      addedAt: new Date().toISOString(),
      addedBy,
      ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    };
    list.push(res);
    this.write(list);
    logEvent('resource.add', { id, kind: kind.id, method, status, secretFields: res.secretFields });
    return res;
  }

  /** Changes the description; `fields` are merged (an empty value removes that field). `''` clears a text property. */
  update(id: string, patch: Partial<Resource> & { fields?: Record<string, string> }): Resource {
    const list = this.read();
    const r = this.mustGet(list, id);
    const kind = resourceKind(r.kind);
    if (patch.method && patch.method !== 'none' && kind && !kind.methods.includes(patch.method)) throw new ResourceError(400, `${kind.label} 不支持 ${patch.method} 方式`);
    const target = r as unknown as Record<string, unknown>;
    for (const key of EDITABLE) {
      const v = patch[key];
      if (v === undefined) continue;
      if (v === '' || v === null) delete target[key];
      else target[key] = v;
    }
    if (patch.fields) {
      const plain = { ...(r.fields ?? {}) };
      const secretFields = new Set(r.secretFields);
      for (const [k, raw] of Object.entries(patch.fields)) {
        const v = typeof raw === 'string' ? (k === 'password' || k === 'appPassword' ? raw : raw.trim()) : '';
        const isSecret = secretFields.has(k) || (kind ? this.isSecret(kind, r.method, k, v) : SECRETISH.test(k));
        if (isSecret) {
          if (v) {
            this.secrets.set(`res.${id}.${k}`, v);
            secretFields.add(k);
          } else {
            this.secrets.delete(`res.${id}.${k}`);
            secretFields.delete(k);
          }
          delete plain[k];
        } else if (v) plain[k] = v;
        else delete plain[k];
      }
      r.secretFields = [...secretFields];
      if (Object.keys(plain).length) r.fields = plain;
      else delete r.fields;
    }
    this.write(list);
    return r;
  }

  /** Forgets the resource and deletes its secrets. */
  remove(id: string): void {
    const list = this.read();
    const r = this.mustGet(list, id);
    const names = new Set(r.secretFields);
    const kind = resourceKind(r.kind);
    for (const m of kind?.methods ?? []) for (const f of kind?.fields[m] ?? []) if (f.secret) names.add(f.id);
    for (const n of names) this.secrets.delete(`res.${id}.${n}`);
    this.write(list.filter((x) => x.id !== id));
    logEvent('resource.remove', { id, kind: r.kind });
  }

  /** A field's value: secret ones from the secret store (audited), the rest from resources.json. */
  secret(id: string, field: string): string | undefined {
    const r = this.get(id);
    if (!r) return undefined;
    if (r.secretFields.includes(field)) {
      logEvent('resource.secret', { id, field });
      return this.secrets.get(`res.${id}.${field}`);
    }
    return r.fields?.[field];
  }

  /** The current two-step code from the resource's `totp` secret. */
  otp(id: string): string | undefined {
    const r = this.get(id);
    if (!r?.secretFields.includes('totp')) return undefined;
    const s = this.secrets.get(`res.${id}.totp`);
    if (!s) return undefined;
    logEvent('resource.otp', { id });
    return totp(s);
  }

  private values(r: Resource): Record<string, string> {
    const out: Record<string, string> = { ...(r.fields ?? {}) };
    for (const f of r.secretFields) {
      const v = this.secrets.get(`res.${r.id}.${f}`);
      if (v) out[f] = v;
    }
    return out;
  }

  /** Asks the service who this credential belongs to; records status, handle, access and when. */
  async verify(id: string): Promise<Resource> {
    const r = this.get(id);
    if (!r) throw new ResourceError(404, `没有这个资源：${id}`);
    const kind = resourceKind(r.kind);
    if (!kind?.verify || !CHECKABLE.has(r.method)) return r;
    let result: VerifyResult;
    try {
      result = await kind.verify(this.values(r));
    } catch (err) {
      result = { ok: false, detail: `验证出错：${(err as Error).message}` };
    }
    // Provider text is kept in resources.json, so it goes through the same redaction as the logs.
    const detail = redactString(result.detail || (result.ok ? '' : '验证失败'));
    logEvent('resource.verify', { id, ok: result.ok, detail });
    if (!result.ok) return this.update(id, { status: 'failed', lastError: detail });
    return this.update(id, {
      status: 'ok',
      handle: result.handle || r.handle,
      access: result.access ?? r.access,
      verifiedAt: new Date().toISOString(),
      verifyDetail: detail,
      lastError: '',
    });
  }

  /** Env for workers: per kind, the first usable resource (the one named after the kind first). */
  workerEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    const kindsDone = new Set<string>();
    const list = this.read()
      .filter((r) => USABLE.has(r.status))
      .sort((a, b) => Number(b.id === b.kind) - Number(a.id === a.kind));
    const handed: string[] = [];
    for (const r of list) {
      const kind = resourceKind(r.kind);
      if (!kind?.workerEnv || kindsDone.has(kind.id)) continue;
      const values = this.values(r);
      const mine: Record<string, string> = {};
      for (const [name, field] of Object.entries(kind.workerEnv)) if (values[field] && !(name in env)) mine[name] = values[field];
      if (!Object.keys(mine).length) continue;
      Object.assign(env, mine);
      kindsDone.add(kind.id);
      handed.push(`${r.id}: ${Object.keys(mine).join(',')}`);
    }
    if (handed.length) logEvent('resource.worker_env', { handed });
    return env;
  }
}

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%^&*-_=+?';

/** A strong password most sign-up forms accept: always upper, lower, digit and symbol; no look-alikes. */
export function generatePassword(length = 20): string {
  const n = Math.max(8, Math.floor(length));
  const all = UPPER + LOWER + DIGITS + SYMBOLS;
  const pick = (set: string) => set[crypto.randomInt(set.length)];
  const chars = [pick(UPPER), pick(LOWER), pick(DIGITS), pick(SYMBOLS)];
  while (chars.length < n) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
