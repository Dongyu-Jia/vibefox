import crypto from 'node:crypto';

/**
 * Two-step verification codes (RFC 6238 TOTP over RFC 4226 HOTP). With the base32
 * secret a site shows under "can't scan the QR code?", the agent computes the same
 * digits as the parent's authenticator app, so a login never waits for a phone.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32. Tolerates spaces, dashes, lowercase and missing or extra `=` padding. */
export function base32Decode(s: string): Buffer {
  const clean = s.replace(/[\s=-]/g, '').toUpperCase();
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error(`not a base32 secret (bad character "${ch}")`);
    value = ((value << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

const ALGORITHMS = new Set(['sha1', 'sha256', 'sha512']);

/**
 * The code for `at` (ms since epoch). Also accepts a whole `otpauth://totp/…` link
 * (what a QR code holds); its `digits`, `period` and `algorithm` then win.
 */
export function totp(secretBase32: string, at = Date.now(), digits = 6, step = 30): string {
  let secret = secretBase32.trim();
  let algorithm = 'sha1';
  if (/^otpauth:\/\//i.test(secret)) {
    const u = new URL(secret);
    secret = u.searchParams.get('secret') ?? '';
    digits = Number(u.searchParams.get('digits')) || digits;
    step = Number(u.searchParams.get('period')) || step;
    algorithm = (u.searchParams.get('algorithm') ?? 'SHA1').toLowerCase();
    if (!ALGORITHMS.has(algorithm)) throw new Error(`unsupported TOTP algorithm ${algorithm}`);
  }
  const key = base32Decode(secret);
  if (!key.length) throw new Error('empty TOTP secret');
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / step)));
  const mac = crypto.createHmac(algorithm, key).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}
