import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Body } from '../../src/core/body.ts';
import { configureLogs, redact, redactString } from '../../src/core/log.ts';
import type { SecretStore } from '../../src/core/secrets.ts';
import { base32Decode, totp } from '../../src/core/totp.ts';
import { publicKind, RESOURCE_GROUPS, RESOURCE_KINDS, resourceKind } from '../../src/resources/catalog.ts';
import { generatePassword, ResourceError, Resources } from '../../src/resources/store.ts';
import { githubMissingScopes, GITHUB_FULL_SCOPES, sigV4 } from '../../src/resources/verify.ts';

// ---------- helpers ----------

const LOGS = fs.mkdtempSync(path.join(os.tmpdir(), 'vf-res-logs-'));
configureLogs(LOGS);
const auditLog = () => fs.readdirSync(path.join(LOGS, 'api')).map((f) => fs.readFileSync(path.join(LOGS, 'api', f), 'utf8')).join('');

class MemSecrets implements SecretStore {
  kind = 'file' as const;
  map = new Map<string, string>();
  get(name: string) {
    return this.map.get(name);
  }
  set(name: string, value: string) {
    this.map.set(name, value);
  }
  delete(name: string) {
    this.map.delete(name);
  }
}

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}
interface Reply {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

/** A tiny stand-in for a provider's API. */
async function provider(handler: (req: Seen) => Reply): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const s = { method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers, body };
      seen.push(s);
      const r = handler(s);
      const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {});
      res.writeHead(r.status ?? 200, { 'content-type': typeof r.body === 'string' ? 'text/xml' : 'application/json', ...(r.headers ?? {}) });
      res.end(text);
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, seen, close: () => new Promise<void>((ok) => server.close(() => ok())) };
}

async function deadUrl(): Promise<string> {
  const p = await provider(() => ({}));
  await p.close();
  return p.url;
}

const envName = (kind: string) => `VF_API_${kind.toUpperCase()}`;

function withApis(kinds: string[], url: string): () => void {
  const saved = kinds.map((k) => [envName(k), process.env[envName(k)]] as const);
  for (const k of kinds) process.env[envName(k)] = url;
  return () => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

function base32Encode(buf: Buffer): string {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += A[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits) out += A[(value << (5 - bits)) & 31];
  return out;
}

function tempBody(): Body {
  const body = Body.create(fs.mkdtempSync(path.join(os.tmpdir(), 'vf-res-')));
  body.saveIdentity({ name: 'Fox', slug: 'fox', bornAt: new Date().toISOString(), parent: { name: 'P' }, identities: {} });
  return body;
}

const { privateKey: RSA_PRIVATE, publicKey: RSA_PUBLIC } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const SERVICE_ACCOUNT = {
  type: 'service_account',
  project_id: 'fox-project',
  private_key_id: 'kid123',
  private_key: RSA_PRIVATE,
  client_email: 'fox@fox-project.iam.gserviceaccount.com',
  token_uri: 'https://oauth2.googleapis.com/token',
};

/** A value for every field any verifier reads. */
const EVERY_FIELD: Record<string, string> = {
  token: 'tok_' + 'x'.repeat(30),
  username: 'fox',
  email: 'fox@agentmail.to',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  json: JSON.stringify(SERVICE_ACCOUNT),
  instance: 'https://mastodon.example',
  shop: 'fox-shop',
  handle: 'fox.bsky.social',
  appPassword: 'abcd-efgh-ijkl-mnop',
  domain: 'fox.example.com',
};

// ---------- catalog ----------

describe('resource catalog', () => {
  const groups = new Set(RESOURCE_GROUPS.map((g) => g.id));

  it('has about forty kinds, each complete and consistent', () => {
    assert.ok(RESOURCE_KINDS.length >= 40, `only ${RESOURCE_KINDS.length} kinds`);
    assert.equal(new Set(RESOURCE_KINDS.map((k) => k.id)).size, RESOURCE_KINDS.length, 'ids are unique');
    assert.equal(groups.size, RESOURCE_GROUPS.length, 'group ids are unique');
    for (const k of RESOURCE_KINDS) {
      assert.ok(groups.has(k.group), `${k.id}: group ${k.group}`);
      assert.ok(k.label, `${k.id}: label`);
      assert.ok(k.unlocks.length > 0, `${k.id}: unlocks`);
      assert.ok(k.methods.length > 0, `${k.id}: methods`);
      assert.ok([null, 'signup', 'legal', 'money', 'key'].includes(k.human), `${k.id}: human`);
      const allFields = new Set<string>();
      for (const m of k.methods) {
        const fields = k.fields[m];
        assert.ok(fields, `${k.id}: fields for ${m}`);
        const ids = fields.map((f) => f.id);
        assert.equal(new Set(ids).size, ids.length, `${k.id}.${m}: field ids unique`);
        for (const f of fields) {
          allFields.add(f.id);
          assert.ok(f.label, `${k.id}.${m}.${f.id}: label`);
        }
      }
      for (const m of Object.keys(k.fields)) assert.ok(k.methods.includes(m as never), `${k.id}: fields for unlisted method ${m}`);
      for (const [env, field] of Object.entries(k.workerEnv ?? {})) {
        assert.match(env, /^[A-Z][A-Z0-9_]*$/, `${k.id}: env name ${env}`);
        assert.ok(allFields.has(field), `${k.id}: workerEnv ${env} -> unknown field ${field}`);
      }
      for (const u of [k.signupUrl, k.loginUrl, k.tokenUrl]) if (u) assert.match(u, /^https:\/\//, `${k.id}: ${u}`);
      const needsCredential = (['token', 'file'] as const).some((m) => k.fields[m]?.some((f) => f.secret && !f.optional));
      if (needsCredential) assert.ok(k.tokenUrl || k.fullPowerHint, `${k.id}: says where the credential is made`);
    }
  });

  it('covers the platforms the parent is asked about', () => {
    const want = 'google microsoft apple stripe openai gemini replicate elevenlabs huggingface github gitlab npm pypi dockerhub gcp aws cloudflare vercel netlify flyio digitalocean hetzner supabase neon upstash pinecone notion linear slack discord airtable figma x reddit bluesky mastodon linkedin amazon uber doordash opentable shopify domain custom';
    for (const id of want.split(' ')) assert.ok(resourceKind(id), id);
    assert.equal(resourceKind('nope'), undefined);
  });

  it('marks what only a person can do', () => {
    assert.equal(resourceKind('stripe')!.human, 'legal');
    assert.equal(resourceKind('domain')!.human, 'legal');
    assert.equal(resourceKind('github')!.human, 'signup');
    assert.equal(resourceKind('aws')!.human, 'signup');
    assert.equal(resourceKind('amazon')!.human, 'money');
    assert.equal(resourceKind('openai')!.human, 'key');
    assert.equal(resourceKind('custom')!.human, null);
  });

  it('deep-links to full-power credentials', () => {
    const gh = resourceKind('github')!;
    assert.equal(gh.tokenUrl, 'https://github.com/settings/tokens/new?scopes=repo,workflow,admin:org,admin:repo_hook,admin:public_key,delete_repo,gist,user,write:packages&description=vibefox');
    assert.deepEqual(new URL(gh.tokenUrl!).searchParams.get('scopes')!.split(','), GITHUB_FULL_SCOPES);
    assert.deepEqual(gh.methods, ['token', 'password', 'browser']);
    assert.ok(gh.fields.password!.some((f) => f.id === 'totp' && f.kind === 'totp' && f.optional && f.secret));
    assert.deepEqual(resourceKind('gcp')!.methods[0], 'file');
    assert.match(resourceKind('gcp')!.fullPowerHint!, /Owner/);
    assert.deepEqual(resourceKind('aws')!.fields.token!.map((f) => f.id), ['accessKeyId', 'secretAccessKey', 'region']);
    assert.deepEqual(resourceKind('bluesky')!.fields.token!.filter((f) => !f.optional).map((f) => f.id), ['handle', 'appPassword']);
    assert.ok(resourceKind('mastodon')!.fields.token!.some((f) => f.id === 'instance' && !f.secret));
    assert.ok(resourceKind('shopify')!.fields.token!.some((f) => f.id === 'shop' && !f.secret));
    const custom = resourceKind('custom')!.fields.password!;
    assert.deepEqual(custom.filter((f) => !f.optional).map((f) => f.id), ['name']);
    assert.deepEqual(custom.filter((f) => f.secret).map((f) => f.id), ['password', 'token', 'totp']);
    assert.equal(resourceKind('stripe')!.workerEnv, undefined, 'a payments key is not handed to workers');
  });

  it('publicKind strips verify and says whether there is one', () => {
    const gh = publicKind(resourceKind('github')!);
    assert.equal('verify' in gh, false);
    assert.equal(gh.verifiable, true);
    assert.equal(publicKind(resourceKind('x')!).verifiable, false);
    const all = RESOURCE_KINDS.map(publicKind);
    assert.deepEqual(JSON.parse(JSON.stringify(all)), all, 'plain JSON, no functions');
  });

  it('every verify answers ok:false on 401 and on a dead port, never throws', async () => {
    const kinds = RESOURCE_KINDS.filter((k) => k.verify);
    assert.ok(kinds.length >= 25, `only ${kinds.length} verifiable kinds`);
    const deny = await provider(() => ({ status: 401, body: { error: { message: 'bad credentials' } } }));
    let restore = withApis(kinds.map((k) => k.id), deny.url);
    try {
      for (const k of kinds) {
        const r = await k.verify!(EVERY_FIELD);
        assert.equal(r.ok, false, `${k.id} on 401: ${r.detail}`);
        assert.match(r.detail, /401/, `${k.id}: ${r.detail}`);
      }
      assert.ok(deny.seen.length >= kinds.length);
    } finally {
      restore();
      await deny.close();
    }
    restore = withApis(kinds.map((k) => k.id), await deadUrl());
    try {
      for (const k of kinds) {
        const r = await k.verify!(EVERY_FIELD);
        assert.equal(r.ok, false, k.id);
        assert.match(r.detail, /^连不上/, `${k.id}: ${r.detail}`);
      }
      for (const k of kinds) assert.equal((await k.verify!({})).ok, false, `${k.id} with no fields`);
    } finally {
      restore();
    }
  });
});

// ---------- totp ----------

describe('totp', () => {
  const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

  it('matches the RFC 6238 SHA-1 test vectors', () => {
    assert.equal(RFC_SECRET, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'); // gitleaks:allow (test fixture, not a key)
    const vectors: [number, string][] = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [t, code] of vectors) assert.equal(totp(RFC_SECRET, t * 1000, 8), code, `T=${t}`);
  });

  it('defaults to 6 digits and 30-second steps', () => {
    assert.equal(totp(RFC_SECRET, 59_000), '287082');
    assert.equal(totp(RFC_SECRET, 30_000), totp(RFC_SECRET, 59_999));
    assert.notEqual(totp(RFC_SECRET, 29_999), totp(RFC_SECRET, 30_000));
    assert.match(totp(RFC_SECRET), /^\d{6}$/);
  });

  it('decodes base32 the way people paste it', () => {
    assert.equal(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq').toString(), '12345678901234567890');
    assert.equal(base32Decode('MZXW6===').toString(), 'foo');
    assert.equal(base32Decode('mzxw6').toString(), 'foo');
    assert.equal(base32Decode('MZXW-6YTB').toString(), 'fooba');
    assert.throws(() => base32Decode('not-base32!'), /base32/);
    assert.throws(() => totp(''), /empty/);
  });

  it('accepts a whole otpauth:// link', () => {
    const secret256 = base32Encode(Buffer.from('12345678901234567890123456789012'));
    const uri = `otpauth://totp/Example:fox?secret=${secret256}&issuer=Example&algorithm=SHA256&digits=8&period=30`;
    assert.equal(totp(uri, 59_000), '46119246');
    assert.equal(totp(`otpauth://totp/x?secret=${RFC_SECRET}`, 59_000), '287082');
  });
});

// ---------- store ----------

describe('resources store', () => {
  it('adds a resource: secrets to the secret store, the description to resources.json', () => {
    const body = tempBody();
    const secrets = new MemSecrets();
    const res = new Resources(body, secrets);
    const token = 'ghp_' + 'A'.repeat(36);
    const r = res.add({ kind: 'github', method: 'token', fields: { token } });
    assert.equal(r.id, 'github');
    assert.equal(r.label, 'GitHub');
    assert.equal(r.status, 'unverified');
    assert.equal(r.origin, 'parent');
    assert.equal(r.addedBy, 'parent');
    assert.equal(r.access, 'unknown');
    assert.deepEqual(r.secretFields, ['token']);
    assert.equal(r.fields, undefined);
    assert.equal(secrets.get('res.github.token'), token);
    assert.equal(res.secret('github', 'token'), token);
    assert.deepEqual(res.get('github'), r);
    assert.equal(res.list().length, 1);
    const file = fs.readFileSync(body.paths.resources, 'utf8');
    assert.ok(!file.includes(token), 'no secret in resources.json');
    assert.equal(JSON.parse(file).version, 1);
    assert.equal(fs.readdirSync(body.root).filter((f) => f.endsWith('.tmp')).length, 0, 'atomic write leaves no temp file');
  });

  it('picks ids: the kind, then kind:<handle>, then a number', () => {
    const res = new Resources(tempBody(), new MemSecrets());
    assert.equal(res.add({ kind: 'github', method: 'browser' }).id, 'github');
    assert.equal(res.add({ kind: 'github', method: 'password', fields: { username: 'Fox Work', password: 'p' } }).id, 'github:fox-work');
    assert.equal(res.add({ kind: 'github', method: 'password', fields: { username: 'Fox Work', password: 'p' } }).id, 'github:fox-work-2');
    assert.equal(res.add({ kind: 'github', method: 'browser' }).id, 'github:2');
    assert.equal(res.add({ kind: 'custom', fields: { name: '公司内网' } }).label, '公司内网');
    assert.equal(res.add({ kind: 'custom', fields: { name: 'Intranet' } }).id, 'custom:intranet');
    assert.equal(res.add({ kind: 'domain', fields: { domain: 'fox.example.com' } }).handle, 'fox.example.com');
    assert.equal(res.add({ kind: 'supabase', id: 'supabase:fox-site', method: 'none', parent: 'supabase', addedBy: 'agent', fields: { projectRef: 'abcd' } }).origin, 'self');
    assert.throws(() => res.add({ kind: 'github', id: 'github', method: 'browser' }), (e: ResourceError) => e.status === 409);
    assert.throws(() => res.add({ kind: 'github', id: 'Bad Id!', method: 'browser' }), (e: ResourceError) => e.status === 400);
  });

  it('validates kind, method and required fields; a draft may be incomplete', () => {
    const res = new Resources(tempBody(), new MemSecrets());
    assert.throws(() => res.add({ kind: 'nope' }), (e: ResourceError) => e.status === 400 && /不认识/.test(e.message));
    assert.throws(() => res.add({ kind: 'stripe', method: 'password' }), (e: ResourceError) => e.status === 400);
    assert.throws(() => res.add({ kind: 'github', method: 'token', fields: { token: '  ' } }), /还缺/);
    assert.throws(() => res.add({ kind: 'aws', fields: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE' } }), /Secret access key/);
    const password = generatePassword();
    const draft = res.add({ kind: 'github', method: 'password', status: 'pending', fields: { password } });
    assert.equal(draft.status, 'pending');
    assert.equal(res.secret(draft.id, 'password'), password);
  });

  it('never writes a secret into resources.json, even in fields it does not know', () => {
    const body = tempBody();
    const secrets = new MemSecrets();
    const res = new Resources(body, secrets);
    const values = {
      aws: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      awsId: 'AKIAIOSFODNN7EXAMPLE',
      pw: 'correct horse battery staple',
      totp: 'JBSWY3DPEHPK3PXP',
      json: JSON.stringify(SERVICE_ACCOUNT),
      db: 'postgres://fox:hunter2hunter2@db.example.com/fox',
      anon: 'sk_live_' + 'b'.repeat(24),
    };
    res.add({ kind: 'aws', fields: { accessKeyId: values.awsId, secretAccessKey: values.aws, region: 'us-west-2' } });
    res.add({ kind: 'google', method: 'password', fields: { username: 'fox@gmail.com', password: values.pw, totp: values.totp } });
    res.add({ kind: 'gcp', method: 'file', fields: { json: values.json } });
    res.add({ kind: 'supabase', id: 'supabase:fox-site', method: 'none', fields: { projectRef: 'abcd', databaseUrl: values.db, note2: values.anon } });
    const file = fs.readFileSync(body.paths.resources, 'utf8');
    for (const [name, v] of Object.entries(values)) assert.ok(!file.includes(v), `${name} leaked into resources.json`);
    const site = res.get('supabase:fox-site')!;
    assert.deepEqual(site.fields, { projectRef: 'abcd' });
    assert.deepEqual(site.secretFields.sort(), ['databaseUrl', 'note2']);
    assert.deepEqual(res.get('aws')!.fields, { region: 'us-west-2' });
    assert.equal(res.get('google')!.handle, 'fox@gmail.com');
    assert.equal(res.secret('aws', 'region'), 'us-west-2', 'plain fields read the same way');
  });

  it('updates fields and properties, removes with its secrets', () => {
    const secrets = new MemSecrets();
    const res = new Resources(tempBody(), secrets);
    res.add({ kind: 'mastodon', fields: { instance: 'https://mastodon.social', token: 't1' }, note: 'first' });
    let r = res.update('mastodon', { fields: { token: 't2', instance: 'https://hachyderm.io' }, note: '', label: 'Fox on Mastodon', id: 'hijack' });
    assert.equal(r.id, 'mastodon');
    assert.equal(r.note, undefined);
    assert.equal(r.label, 'Fox on Mastodon');
    assert.equal(res.secret('mastodon', 'token'), 't2');
    assert.deepEqual(r.fields, { instance: 'https://hachyderm.io' });
    r = res.update('mastodon', { fields: { token: '' } });
    assert.deepEqual(r.secretFields, []);
    assert.equal(secrets.get('res.mastodon.token'), undefined);
    res.update('mastodon', { fields: { token: 't3' } });
    assert.throws(() => res.update('nope', { label: 'x' }), (e: ResourceError) => e.status === 404);
    res.remove('mastodon');
    assert.equal(res.get('mastodon'), undefined);
    assert.equal(secrets.map.size, 0, 'secrets gone too');
    assert.throws(() => res.remove('mastodon'), (e: ResourceError) => e.status === 404);
  });

  it('computes two-step codes from a stored secret', () => {
    const res = new Resources(tempBody(), new MemSecrets());
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    res.add({ kind: 'custom', method: 'password', fields: { name: 'Intranet', login: 'fox', password: 'p', totp: secret } });
    const now = [totp(secret)];
    const code = res.otp('custom');
    now.push(totp(secret));
    assert.ok(now.includes(code!), 'same code as an authenticator app');
    res.add({ kind: 'github', method: 'browser' });
    assert.equal(res.otp('github'), undefined);
    assert.equal(res.otp('nope'), undefined);
  });

  describe('verify against a provider', () => {
    let gh: Awaited<ReturnType<typeof provider>>;
    let restore: () => void;
    const FULL = 'admin:org, admin:public_key, admin:repo_hook, delete_repo, gist, repo, user, workflow, write:packages';
    const tokens: Record<string, string | null> = {
      ['ghp_' + 'F'.repeat(36)]: FULL,
      ['ghp_' + 'S'.repeat(36)]: 'repo, gist',
      ['github_pat_' + 'G'.repeat(40)]: null,
    };
    before(async () => {
      gh = await provider((req) => {
        const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
        if (req.url !== '/user' || !(token in tokens)) return { status: 401, body: { message: 'Bad credentials' } };
        const scopes = tokens[token];
        const headers: Record<string, string> = scopes == null ? {} : { 'x-oauth-scopes': scopes };
        return { headers, body: { login: 'fox-agent', id: 1 } };
      });
      restore = withApis(['github'], gh.url);
    });
    after(async () => {
      restore();
      await gh.close();
    });

    it('records ok, handle and full access for a full-power classic token', async () => {
      const res = new Resources(tempBody(), new MemSecrets());
      const token = 'ghp_' + 'F'.repeat(36);
      res.add({ kind: 'github', fields: { token } });
      const r = await res.verify('github');
      assert.equal(r.status, 'ok');
      assert.equal(r.handle, 'fox-agent');
      assert.equal(r.access, 'full');
      assert.ok(r.verifiedAt);
      assert.equal(r.lastError, undefined);
      assert.match(r.verifyDetail!, /全部权限/);
      const req = gh.seen.at(-1)!;
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      assert.equal(req.headers['user-agent'], 'vibefox');
      const log = auditLog();
      assert.match(log, /"service":"resource:github"/);
      assert.ok(!log.includes(token), 'token redacted in the audit log');
    });

    it('says which scopes are missing, and that fine-grained tokens are scoped', async () => {
      const res = new Resources(tempBody(), new MemSecrets());
      res.add({ kind: 'github', fields: { token: 'ghp_' + 'S'.repeat(36) } });
      const r = await res.verify('github');
      assert.equal(r.status, 'ok');
      assert.equal(r.access, 'scoped');
      assert.match(r.verifyDetail!, /workflow/);
      res.add({ kind: 'github', id: 'github:fine', fields: { token: 'github_pat_' + 'G'.repeat(40) } });
      assert.equal((await res.verify('github:fine')).access, 'scoped');
      assert.deepEqual(githubMissingScopes(FULL), []);
      assert.deepEqual(githubMissingScopes('repo'), GITHUB_FULL_SCOPES.slice(1));
      assert.equal(githubMissingScopes(null), undefined);
    });

    it('marks a refused or unreachable credential failed, without throwing', async () => {
      const res = new Resources(tempBody(), new MemSecrets());
      res.add({ kind: 'github', fields: { token: 'ghp_' + 'X'.repeat(36) } });
      let r = await res.verify('github');
      assert.equal(r.status, 'failed');
      assert.match(r.lastError!, /401.*Bad credentials/);
      res.update('github', { fields: { token: 'ghp_' + 'F'.repeat(36) } });
      r = await res.verify('github');
      assert.equal(r.status, 'ok');
      assert.equal(r.lastError, undefined, 'a good check clears the old error');
      const back = withApis(['github'], await deadUrl());
      try {
        r = await res.verify('github');
        assert.equal(r.status, 'failed');
        assert.match(r.lastError!, /连不上/);
      } finally {
        back();
      }
      await assert.rejects(res.verify('nope'), (e: ResourceError) => e.status === 404);
    });

    it('does not auto-test a password or a browser login', async () => {
      const res = new Resources(tempBody(), new MemSecrets());
      const requests = gh.seen.length;
      res.add({ kind: 'github', method: 'password', fields: { username: 'fox', password: 'p' } });
      res.add({ kind: 'x', method: 'browser', status: 'ok' });
      assert.equal((await res.verify('github')).status, 'unverified');
      assert.equal((await res.verify('x')).status, 'ok');
      assert.equal(gh.seen.length, requests, 'no request made');
    });
  });

  it('hands workers env from usable resources only, one resource per kind', () => {
    const res = new Resources(tempBody(), new MemSecrets());
    res.add({ kind: 'github', id: 'github:work', fields: { token: 'ghp_work' } });
    res.add({ kind: 'github', fields: { token: 'ghp_main' }, status: 'ok' });
    res.add({ kind: 'vercel', fields: { token: 'vercel_bad' }, status: 'failed' });
    res.add({ kind: 'aws', fields: { accessKeyId: 'AKIAONE', secretAccessKey: 'one' } });
    res.add({ kind: 'aws', id: 'aws:two', fields: { accessKeyId: 'AKIATWO', secretAccessKey: 'two', region: 'eu-west-1' } });
    res.add({ kind: 'x', method: 'password', fields: { username: 'fox', password: 'never-in-env' } });
    res.add({ kind: 'npm', fields: { token: 'npm_pending' }, status: 'pending' });
    const env = res.workerEnv();
    assert.deepEqual(env, { GITHUB_TOKEN: 'ghp_main', GH_TOKEN: 'ghp_main', AWS_ACCESS_KEY_ID: 'AKIAONE', AWS_SECRET_ACCESS_KEY: 'one' });
  });

  it('generates strong passwords', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const p = generatePassword();
      assert.equal(p.length, 20);
      assert.match(p, /[A-Z]/);
      assert.match(p, /[a-z]/);
      assert.match(p, /[0-9]/);
      assert.match(p, /[^A-Za-z0-9]/);
      assert.doesNotMatch(p, /[\s'"\\`]/);
      seen.add(p);
    }
    assert.equal(seen.size, 200);
    assert.equal(generatePassword(32).length, 32);
    assert.equal(generatePassword(4).length, 8, 'never shorter than 8');
  });
});

// ---------- verifiers with their quirks ----------

describe('resource verifiers', () => {
  it('Gemini sends the key in x-goog-api-key, never in the URL', async () => {
    const key = 'AIza' + 'k'.repeat(35);
    const p = await provider(() => ({ body: { models: [{ name: 'models/gemini' }] } }));
    const restore = withApis(['gemini'], p.url);
    try {
      const r = await resourceKind('gemini')!.verify!({ token: key });
      assert.equal(r.ok, true, r.detail);
      assert.equal(p.seen[0].headers['x-goog-api-key'], key);
      assert.equal(p.seen[0].url, '/v1beta/models');
      assert.ok(!p.seen[0].url.includes(key));
    } finally {
      restore();
      await p.close();
    }
  });

  it('Stripe: a secret key is full power; a restricted key that cannot read the account is still real', async () => {
    const p = await provider((req) => {
      const key = String(req.headers.authorization).replace('Bearer ', '');
      if (key.startsWith('rk_')) return { status: 403, body: { error: { message: 'The provided key does not have the required permissions' } } };
      if (key === 'sk_test_' + 'a'.repeat(24)) return { body: { id: 'acct_1', settings: { dashboard: { display_name: 'Fox Shop' } }, charges_enabled: true } };
      return { status: 401, body: { error: { message: 'Invalid API Key provided' } } };
    });
    const restore = withApis(['stripe'], p.url);
    try {
      const v = resourceKind('stripe')!.verify!;
      assert.deepEqual(await v({ token: 'sk_test_' + 'a'.repeat(24) }), { ok: true, handle: 'Fox Shop', access: 'full', detail: '测试环境，能收款' });
      const rk = await v({ token: 'rk_live_' + 'a'.repeat(24) });
      assert.equal(rk.ok, true);
      assert.equal(rk.access, 'scoped');
      assert.equal((await v({ token: 'sk_live_wrong' })).ok, false);
    } finally {
      restore();
      await p.close();
    }
  });

  it('Slack: a 200 with ok:false is a refusal', async () => {
    let good = false;
    const p = await provider(() => ({ body: good ? { ok: true, user: 'fox', team: 'Home' } : { ok: false, error: 'invalid_auth' } }));
    const restore = withApis(['slack'], p.url);
    try {
      const v = resourceKind('slack')!.verify!;
      assert.deepEqual(await v({ token: 'xoxb-1' }), { ok: false, detail: 'Slack 说：invalid_auth' });
      good = true;
      assert.equal((await v({ token: 'xoxb-1' })).handle, 'fox@Home');
      assert.equal(p.seen[0].method, 'POST');
      assert.equal(p.seen[0].url, '/api/auth.test');
    } finally {
      restore();
      await p.close();
    }
  });

  it('Discord uses "Bot <token>", Linear a bare key, Notion a version header', async () => {
    const p = await provider((req) => {
      if (req.url === '/api/v10/users/@me') return req.headers.authorization === 'Bot dtok' ? { body: { username: 'foxbot', bot: true } } : { status: 401 };
      if (req.url === '/graphql') return req.headers.authorization === 'lin_api_x' ? { body: { data: { viewer: { name: 'Fox', email: 'fox@agentmail.to' } } } } : { status: 400, body: { errors: [{ message: 'Authentication required' }] } };
      if (req.url === '/v1/users/me') return req.headers['notion-version'] ? { body: { name: 'Fox', bot: { workspace_name: 'Home' } } } : { status: 400 };
      return { status: 404 };
    });
    const restore = withApis(['discord', 'linear', 'notion'], p.url);
    try {
      assert.equal((await resourceKind('discord')!.verify!({ token: 'Bot dtok' })).handle, 'foxbot');
      assert.equal((await resourceKind('linear')!.verify!({ token: 'lin_api_x' })).handle, 'fox@agentmail.to');
      assert.match(JSON.parse(p.seen[1].body).query, /viewer/);
      assert.match((await resourceKind('notion')!.verify!({ token: 'ntn_x' })).detail, /Home/);
    } finally {
      restore();
      await p.close();
    }
  });

  it('Bluesky opens a session with the handle and app password', async () => {
    const p = await provider((req) => {
      const b = JSON.parse(req.body || '{}');
      return b.identifier === 'fox.bsky.social' && b.password === 'abcd-efgh-ijkl-mnop' ? { body: { did: 'did:plc:x', handle: 'fox.bsky.social', accessJwt: 'jwt' } } : { status: 401, body: { error: 'AuthenticationRequired', message: 'Invalid identifier or password' } };
    });
    const restore = withApis(['bluesky'], p.url);
    try {
      const v = resourceKind('bluesky')!.verify!;
      assert.equal((await v({ handle: '@fox.bsky.social', appPassword: 'abcd-efgh-ijkl-mnop' })).handle, 'fox.bsky.social');
      assert.equal(p.seen[0].url, '/xrpc/com.atproto.server.createSession');
      assert.match((await v({ handle: 'fox.bsky.social', appPassword: 'wrong' })).detail, /Invalid identifier/);
    } finally {
      restore();
      await p.close();
    }
  });

  it('Google Cloud: signs an RS256 JWT, trades it for a token, reads the project and its Owner permission', async () => {
    let assertion = '';
    const p = await provider((req) => {
      if (req.url === '/token') {
        const form = new URLSearchParams(req.body);
        assertion = form.get('assertion') ?? '';
        const [h, c, sig] = assertion.split('.');
        const okSig = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), RSA_PUBLIC, Buffer.from(sig, 'base64url'));
        const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
        const header = JSON.parse(Buffer.from(h, 'base64url').toString());
        const good = okSig && form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:jwt-bearer' && claims.aud === 'https://oauth2.googleapis.com/token' && claims.iss === SERVICE_ACCOUNT.client_email && header.alg === 'RS256' && header.kid === 'kid123';
        return good ? { body: { access_token: 'ya29.mock', expires_in: 3600 } } : { status: 400, body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } };
      }
      if (req.headers.authorization !== 'Bearer ya29.mock') return { status: 401 };
      if (req.url === '/v1/projects/fox-project') return { body: { projectId: 'fox-project', name: 'Fox', lifecycleState: 'ACTIVE' } };
      if (req.url === '/v1/projects/fox-project:testIamPermissions') return { body: { permissions: JSON.parse(req.body).permissions } };
      return { status: 404 };
    });
    const restore = withApis(['gcp'], p.url);
    try {
      const v = resourceKind('gcp')!.verify!;
      const r = await v({ json: JSON.stringify(SERVICE_ACCOUNT) });
      assert.deepEqual(r, { ok: true, handle: SERVICE_ACCOUNT.client_email, access: 'full', detail: '项目 Fox（ACTIVE），Owner 权限' });
      const log = auditLog();
      assert.match(log, /"service":"resource:gcp"/);
      assert.ok(assertion && !log.includes(assertion), 'the signed assertion is redacted in the audit log');
      assert.ok(!log.includes('ya29.mock'), 'the access token is redacted in the audit log');
      const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
      const forged = await v({ json: JSON.stringify({ ...SERVICE_ACCOUNT, private_key: other.privateKey }) });
      assert.equal(forged.ok, false);
      assert.match(forged.detail, /Invalid JWT Signature/);
      assert.match((await v({ json: '{"type":"authorized_user"}' })).detail, /服务账号/);
      assert.match((await v({ json: 'not json' })).detail, /JSON/);
      assert.ok(assertion.length > 100);
    } finally {
      restore();
      await p.close();
    }
  });

  it('AWS: SigV4 matches the AWS test suite and signs STS GetCallerIdentity', async () => {
    const vanilla = sigV4({ method: 'GET', url: 'https://example.amazonaws.com/', headers: {}, body: '', region: 'us-east-1', service: 'service', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', date: new Date('2015-08-30T12:36:00Z') });
    assert.equal(vanilla.authorization, 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
    const secret = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
    const p = await provider((req) => {
      const d = String(req.headers['x-amz-date']);
      const date = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(9, 11)}:${d.slice(11, 13)}:${d.slice(13, 15)}Z`);
      const expect = sigV4({ method: req.method, url: `http://${req.headers.host}${req.url}`, headers: { 'content-type': String(req.headers['content-type']) }, body: req.body, region: 'us-east-1', service: 'sts', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: secret, date });
      if (req.headers.authorization !== expect.authorization || req.body !== 'Action=GetCallerIdentity&Version=2011-06-15') return { status: 403, body: '<ErrorResponse><Error><Code>SignatureDoesNotMatch</Code><Message>The request signature we calculated does not match</Message></Error></ErrorResponse>' };
      return { body: '<GetCallerIdentityResponse><GetCallerIdentityResult><Arn>arn:aws:iam::123456789012:user/fox</Arn><UserId>AIDAEXAMPLE</UserId><Account>123456789012</Account></GetCallerIdentityResult></GetCallerIdentityResponse>' };
    });
    const restore = withApis(['aws'], p.url);
    try {
      const v = resourceKind('aws')!.verify!;
      assert.deepEqual(await v({ accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: secret }), { ok: true, handle: 'arn:aws:iam::123456789012:user/fox', detail: '账号 123456789012' });
      const bad = await v({ accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wrong' });
      assert.equal(bad.ok, false);
      assert.match(bad.detail, /403.*signature/);
    } finally {
      restore();
      await p.close();
    }
  });

  it('domain: looks the name up over DNS-over-HTTPS', async () => {
    const p = await provider((req) => {
      const name = new URL(req.url, 'http://x').searchParams.get('name');
      if (req.headers.accept !== 'application/dns-json') return { status: 400 };
      if (name === 'fox.example.com') return { body: { Status: 0, Question: [{ name: 'fox.example.com.', type: 2 }], Answer: [{ name: 'fox.example.com.', type: 2, data: 'ada.ns.cloudflare.com.' }, { name: 'fox.example.com.', type: 2, data: 'bob.ns.cloudflare.com.' }] } };
      return { body: { Status: 3, Question: [{ name: `${name}.`, type: 2 }] } };
    });
    const restore = withApis(['domain'], p.url);
    try {
      const v = resourceKind('domain')!.verify!;
      assert.deepEqual(await v({ domain: 'https://Fox.Example.com/' }), { ok: true, handle: 'fox.example.com', detail: '域名服务器：ada.ns.cloudflare.com、bob.ns.cloudflare.com（在 Cloudflare 上）' });
      assert.match((await v({ domain: 'nope.example.com' })).detail, /不存在/);
      assert.match((await v({ domain: 'not a domain' })).detail, /不像域名/);
    } finally {
      restore();
      await p.close();
    }
  });

  it('Mastodon and GitLab use the instance the parent typed (or the mock)', async () => {
    const p = await provider((req) => {
      if (req.url === '/api/v1/accounts/verify_credentials') return { body: { acct: 'fox', username: 'fox' } };
      if (req.url === '/api/v4/user') return req.headers['private-token'] === 'glpat-x' ? { body: { username: 'fox' } } : { status: 401 };
      return { status: 404 };
    });
    const restore = withApis(['mastodon'], p.url);
    try {
      assert.equal((await resourceKind('mastodon')!.verify!({ instance: 'hachyderm.io', token: 't' })).handle, '@fox@hachyderm.io');
      // No VF_API_GITLAB: the typed instance is the base.
      assert.equal((await resourceKind('gitlab')!.verify!({ token: 'glpat-x', instance: p.url })).handle, 'fox');
      assert.match((await resourceKind('gitlab')!.verify!({ token: 'glpat-x', instance: 'ftp://nope' })).detail, /不像网址/);
    } finally {
      restore();
      await p.close();
    }
  });
});

// ---------- redaction ----------

describe('audit log redaction of provider tokens', () => {
  const cases: [string, string, string][] = [
    ['GitHub classic', 'ghp_' + 'a1B2'.repeat(9), 'ghp_<redacted>'],
    ['GitHub OAuth', 'gho_' + 'a1B2'.repeat(9), 'gho_<redacted>'],
    ['GitHub user-to-server', 'ghu_' + 'a1B2'.repeat(9), 'ghu_<redacted>'],
    ['GitHub server-to-server', 'ghs_' + 'a1B2'.repeat(9), 'ghs_<redacted>'],
    ['GitHub refresh', 'ghr_' + 'a1B2'.repeat(9), 'ghr_<redacted>'],
    ['GitHub fine-grained', 'github_pat_11ABCDEFG0' + 'x'.repeat(60), 'github_pat_<redacted>'],
    ['GitLab', 'glpat-' + 'Ab3_-xY9zQ'.repeat(2), 'glpat-<redacted>'],
    ['Hugging Face', 'hf_' + 'AbCdEfGhIjKlMnOpQrStUvWxYz0123'.slice(0, 34), 'hf_<redacted>'],
    ['npm', 'npm_' + 'A1b2C3d4E5'.repeat(4).slice(0, 36), 'npm_<redacted>'],
    ['Slack bot', 'xoxb-1234567890-0987654321-AbCdEfGhIjKl', 'xoxb-<redacted>'], // gitleaks:allow (test fixture, not a key)
    ['Slack user', 'xoxp-1234567890-0987654321-AbCdEfGhIjKl', 'xoxp-<redacted>'],
    ['Stripe live secret', 'sk_live_' + 'a'.repeat(24), 'sk_live_<redacted>'],
    ['Stripe test secret', 'sk_test_' + 'a'.repeat(24), 'sk_test_<redacted>'],
    ['Stripe live restricted', 'rk_live_' + 'a'.repeat(24), 'rk_live_<redacted>'],
    ['Stripe test restricted', 'rk_test_' + 'a'.repeat(24), 'rk_test_<redacted>'],
    ['Google API key', 'AIzaSy' + 'A1b2C3d4E5'.repeat(4).slice(0, 33), 'AIza<redacted>'],
    ['AWS access key id', 'AKIAIOSFODNN7EXAMPLE', 'AKIA<redacted>'],
    ['AWS temporary key id', 'ASIAIOSFODNN7EXAMPLE', 'ASIA<redacted>'],
    ['PyPI', 'pypi-AgEIcHlwaS5vcmc' + 'x'.repeat(60), 'pypi-<redacted>'],
    ['Supabase', 'sbp_' + 'a1'.repeat(20), 'sbp_<redacted>'],
  ];
  for (const [name, secret, shown] of cases) {
    it(name, () => {
      const out = redactString(`token=${secret} end`);
      assert.equal(out, `token=${shown} end`);
      assert.ok(!out.includes(secret));
    });
  }

  it('PEM private keys, whole or cut off', () => {
    const pem = RSA_PRIVATE;
    const out = redactString(`key: ${pem} done`);
    assert.equal(out, 'key: -----BEGIN PRIVATE KEY-----<redacted>-----END PRIVATE KEY-----\n done'); // gitleaks:allow (test fixture, not a key)
    const rsa = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
    assert.equal(redactString(rsa), '-----BEGIN RSA PRIVATE KEY-----<redacted>-----END RSA PRIVATE KEY-----'); // gitleaks:allow (test fixture, not a key)
    assert.equal(redactString('{"private_key":"-----BEGIN PRIVATE KEY-----\\nMIIEv'), '{"private_key":"-----BEGIN PRIVATE KEY-----<redacted>');
    const json = JSON.stringify(SERVICE_ACCOUNT);
    assert.ok(!redactString(json).includes(RSA_PRIVATE.split('\n')[1]));
  });

  it('provider auth headers and session fields by name', () => {
    assert.deepEqual(
      redact({ 'private-token': 'a', 'x-figma-token': 'b', 'xi-api-key': 'c', 'x-goog-api-key': 'd', 'x-shopify-access-token': 'e', accessJwt: 'f', refreshJwt: 'g', assertion: 'h', 'api-key': 'i', handle: 'fox' }),
      { 'private-token': '[REDACTED]', 'x-figma-token': '[REDACTED]', 'xi-api-key': '[REDACTED]', 'x-goog-api-key': '[REDACTED]', 'x-shopify-access-token': '[REDACTED]', accessJwt: '[REDACTED]', refreshJwt: '[REDACTED]', assertion: '[REDACTED]', 'api-key': '[REDACTED]', handle: 'fox' },
    );
  });

  it('leaves ordinary text alone', () => {
    const plain = 'the github_pat_ prefix, hf_hub_download, npm_config_cache, sk_live_ docs, AKIA alone, ts 1729771234567';
    assert.equal(redactString(plain), plain);
  });
});
