/** Builds evidence/API-SAMPLES.md: one real request/response pair per endpoint, from the recorded logs. */
import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from '../src/core/paths.ts';

const EV = path.join(PROJECT_ROOT, 'evidence');
const read = (dir: string, filter: (f: string) => boolean) =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir).filter(filter).flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>))
    : [];
const demo = read(path.join(EV, 'demo-logs', 'logs', 'api'), (f) => f.endsWith('.jsonl'));
const live = read(path.join(EV, 'live'), (f) => f.startsWith('api-') && f.endsWith('.jsonl'));

const key = (e: Record<string, any>) => {
  const u = String(e.url).replace(/^https?:\/\/[^/]+/, '').replace(/bot<redacted>\//, 'bot<token>/').replace(/\?.*$/, '');
  return `${e.service} ${e.method} ${u.replace(/\/(lsrq|call|num|agt|msg|r|t)_[\w-]+/g, '/:id').replace(/%3C[^/]+%3E/g, ':id').replace(/\/[\w.+-]+@agentmail\.to/, '/:inbox')}`;
};
const pick = (entries: Record<string, any>[]) => {
  const seen = new Map<string, Record<string, any>>();
  for (const e of entries) if (!seen.has(key(e))) seen.set(key(e), e);
  return [...seen.entries()];
};
const trunc = (v: unknown) => {
  const s = JSON.stringify(v, null, 2) ?? '';
  return s.length > 2500 ? s.slice(0, 2500) + '\n… (truncated)' : s;
};
const out = ['# API request/response samples', '', 'Every outside call vibefox makes goes through `loggedFetch` and lands in `<body>/logs/api/<date>.jsonl` with secrets redacted (keys, tokens, card numbers). Below is one sample per endpoint.', ''];
for (const [title, entries] of [['Live calls to the real services (scripts/live-check.ts)', live], ['End-to-end demo against local stand-ins (scripts/record-demo.ts)', demo]] as const) {
  out.push(`## ${title}`, '', `${entries.length} calls logged.`, '');
  for (const [k, e] of pick(entries)) {
    out.push(`### \`${k}\``, '', `${e.ts} · ${e.durationMs} ms · status ${e.response?.status ?? e.error}`, '', '<details><summary>request / response</summary>', '', '```json', trunc({ url: e.url, request: e.request, response: e.response }), '```', '', '</details>', '');
  }
}
fs.mkdirSync(EV, { recursive: true });
fs.writeFileSync(path.join(EV, 'API-SAMPLES.md'), out.join('\n'));
console.log(`wrote evidence/API-SAMPLES.md (${live.length} live + ${demo.length} demo calls)`);
