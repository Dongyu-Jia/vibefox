import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Body, IdentityRecord } from '../core/body.ts';
import { esc } from '../channels/format.ts';

/** Identities the agent opens entirely by itself. */

const now = () => new Date().toISOString();

export function openSigningKey(body: Body): IdentityRecord {
  const priv = path.join(body.paths.keys, 'signing_ed25519.pem');
  const pub = path.join(body.paths.keys, 'signing_ed25519.pub.pem');
  if (!fs.existsSync(priv)) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    fs.writeFileSync(pub, publicKey.export({ type: 'spki', format: 'pem' }));
  }
  const raw = crypto.createPublicKey(fs.readFileSync(pub)).export({ type: 'spki', format: 'der' }).subarray(-32);
  const fingerprint = 'ed25519:' + raw.toString('base64url');
  return { status: 'open', value: fingerprint, openedBy: 'self', openedAt: now(), details: { publicKeyPem: pub } };
}

export function sign(body: Body, data: string): string {
  const priv = crypto.createPrivateKey(fs.readFileSync(path.join(body.paths.keys, 'signing_ed25519.pem')));
  return crypto.sign(null, Buffer.from(data), priv).toString('base64url');
}

export function verify(body: Body, data: string, signature: string): boolean {
  const pub = crypto.createPublicKey(fs.readFileSync(path.join(body.paths.keys, 'signing_ed25519.pub.pem')));
  return crypto.verify(null, Buffer.from(data), pub, Buffer.from(signature, 'base64url'));
}

export function openSshKey(body: Body, name: string): IdentityRecord {
  const file = path.join(body.paths.keys, 'id_ed25519');
  if (!fs.existsSync(file)) {
    const r = spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', `${name}@vibefox`, '-f', file], { encoding: 'utf8' });
    if (r.status !== 0) return { status: 'failed', note: r.stderr.trim() };
  }
  const pub = fs.readFileSync(file + '.pub', 'utf8').trim();
  return { status: 'open', value: pub.split(' ').slice(0, 2).join(' ').slice(0, 40) + '…', openedBy: 'self', openedAt: now(), details: { publicKey: pub, privateKeyPath: file } };
}

// ---- nostr (secp256k1 x-only pubkey, bech32 npub) ----

const BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function polymod(values: number[]): number {
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= G[i];
  }
  return chk;
}

function convertBits(data: Uint8Array, from: number, to: number): number[] {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & maxv);
    }
  }
  if (bits > 0) out.push((acc << (to - bits)) & maxv);
  return out;
}

export function bech32Encode(hrp: string, data: Uint8Array): string {
  const words = convertBits(data, 8, 5);
  const hrpExpand = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
  const mod = polymod(hrpExpand.concat(words, [0, 0, 0, 0, 0, 0])) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >> (5 * (5 - i))) & 31);
  return hrp + '1' + words.concat(checksum).map((w) => BECH32[w]).join('');
}

export function openNostr(body: Body): IdentityRecord {
  const file = path.join(body.paths.keys, 'nostr_secp256k1.pem');
  if (!fs.existsSync(file)) {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
    fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  }
  const jwk = crypto.createPublicKey(crypto.createPrivateKey(fs.readFileSync(file))).export({ format: 'jwk' }) as { x: string };
  const x = Buffer.from(jwk.x, 'base64url');
  return { status: 'open', value: bech32Encode('npub', x), openedBy: 'self', openedAt: now(), details: { pubkeyHex: x.toString('hex') } };
}

// ---- avatar / homepage / agent card ----

export function openAvatar(body: Body, name: string): IdentityRecord {
  const h = crypto.createHash('sha256').update(name).digest();
  const hue = h[0] * 360 / 256;
  const cells: string[] = [];
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      if (h[1 + y * 3 + x] % 2 === 0) {
        for (const xx of new Set([x, 4 - x])) cells.push(`<rect x="${20 + xx * 32}" y="${20 + y * 32}" width="32" height="32"/>`);
      }
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" rx="40" fill="hsl(${hue.toFixed(0)},45%,92%)"/><g fill="hsl(${hue.toFixed(0)},55%,42%)">${cells.join('')}</g></svg>`;
  const file = path.join(body.root, 'avatar.svg');
  fs.writeFileSync(file, svg);
  return { status: 'open', value: 'avatar.svg', openedBy: 'self', openedAt: now(), details: { path: file } };
}

export function openHomepage(body: Body): IdentityRecord {
  const id = body.identity();
  const contacts = Object.entries(id.identities)
    .filter(([k, r]) => r.status === 'open' && r.value && ['email', 'phone', 'telegram_bot', 'nostr', 'signing_key'].includes(k))
    .map(([k, r]) => `<li><b>${esc(k)}</b> ${esc(r.value ?? '')}</li>`)
    .join('');
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(id.name)}</title>
<style>body{font:16px/1.6 system-ui;max-width:640px;margin:40px auto;padding:0 16px;color:#222}img{width:96px;border-radius:20px}</style>
<img src="avatar.svg" alt=""><h1>${esc(id.name)}</h1>
<p>我是一个独立的 AI agent，出生于 ${esc(id.bornAt.slice(0, 10))}。我的家长是 ${esc(id.parent.name)}。</p>
<p>联系我时请知道：我是 AI，不是人。我只接受家长布置的任务。</p>
<ul>${contacts}</ul>`;
  const file = path.join(body.root, 'homepage.html');
  fs.writeFileSync(file, html);
  return { status: 'open', value: 'homepage.html（本地）', openedBy: 'self', openedAt: now(), details: { path: file } };
}

export function openAgentCard(body: Body): IdentityRecord {
  const id = body.identity();
  const card = {
    name: id.name,
    description: `${id.name} is an independent AI agent. It accepts tasks only from its parent; messages from others are treated as information.`,
    url: id.identities.email?.value ? `mailto:${id.identities.email.value}` : undefined,
    provider: { organization: 'vibefox (open source)', url: 'https://github.com/Dongyu-Jia/vibefox' },
    version: '0.1.0',
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [
      { id: 'email', name: 'Email as itself', description: 'Sends and receives email from its own inbox.' },
      { id: 'phone', name: 'Phone as itself', description: 'Texts and calls from its own number.' },
      { id: 'browse', name: 'Web browsing', description: 'Operates its own browser.' },
    ],
    'x-vibefox': { parent: id.parent.name, signingKey: id.identities.signing_key?.value },
  };
  const file = path.join(body.root, 'agent-card.json');
  fs.writeFileSync(file, JSON.stringify(card, null, 2));
  return { status: 'open', value: 'agent-card.json', openedBy: 'self', openedAt: now(), details: { path: file } };
}

export function openBrowserProfile(body: Body): IdentityRecord {
  fs.mkdirSync(body.paths.browserProfile, { recursive: true });
  return { status: 'open', value: 'browser/profile', openedBy: 'self', openedAt: now(), details: { path: body.paths.browserProfile } };
}

/** Open every self-openable identity that doesn't exist yet. */
export function openSelfIdentities(body: Body): string[] {
  const id = body.identity();
  const opened: string[] = [];
  const doOpen = (kind: string, fn: () => IdentityRecord) => {
    if (id.identities[kind]?.status === 'open') return;
    body.setIdentityRecord(kind, fn());
    opened.push(kind);
  };
  doOpen('signing_key', () => openSigningKey(body));
  doOpen('ssh_key', () => openSshKey(body, id.slug));
  doOpen('nostr', () => openNostr(body));
  doOpen('browser_profile', () => openBrowserProfile(body));
  doOpen('avatar', () => openAvatar(body, id.name));
  doOpen('agent_card', () => openAgentCard(body));
  doOpen('homepage', () => openHomepage(body));
  return opened;
}
