/**
 * Collects evidence from the REAL agent on this Mac (~/.vibefox): its API
 * request/response logs (redacted), decisions, identities, tasks, journal and
 * recordings of its own browser → evidence/live-real/.
 *
 *   node scripts/collect-live-evidence.ts
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Body } from '../src/core/body.ts';
import { PROJECT_ROOT, vfRoot } from '../src/core/paths.ts';

const OUT = path.join(PROJECT_ROOT, 'evidence', 'live-real');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(path.join(PROJECT_ROOT, 'evidence', 'videos'), { recursive: true });
const body = Body.open();
const copy = (from: string, to: string) => fs.existsSync(from) && fs.cpSync(from, to, { recursive: true });

copy(body.paths.logs, path.join(OUT, 'logs'));
copy(path.join(vfRoot(), 'setup-logs'), path.join(OUT, 'setup-logs'));
for (const f of ['identity.json', 'mandate.json', 'workers.json', 'routing.md', 'SOUL.md', 'agent-card.json', 'homepage.html', 'avatar.svg', 'onboarding.json']) copy(path.join(body.root, f), path.join(OUT, 'body', f));
copy(body.paths.journal, path.join(OUT, 'body', 'journal'));
copy(body.paths.memory, path.join(OUT, 'body', 'memory'));
fs.rmSync(path.join(OUT, 'logs', 'daemon.err.log'), { force: true });

// Recordings of the agent's own browser.
const videos: string[] = [];
if (fs.existsSync(body.paths.recordings)) {
  const webms = fs.readdirSync(body.paths.recordings).filter((f) => f.endsWith('.webm')).sort();
  webms.forEach((f, i) => {
    const dst = path.join(PROJECT_ROOT, 'evidence', 'videos', `live-agent-browser-${i + 1}.mp4`);
    const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(body.paths.recordings, f), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', dst]);
    if (r.status === 0) videos.push(path.basename(dst));
  });
}

const readJsonl = (dir: string) =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>))
    : [];
const api = [...readJsonl(path.join(vfRoot(), 'setup-logs', 'api')), ...readJsonl(body.paths.apiLogs)].sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
const events = fs.readdirSync(body.paths.logs).filter((f) => f.startsWith('events-')).flatMap((f) => fs.readFileSync(path.join(body.paths.logs, f), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>));

const db = new DatabaseSync(body.paths.db, { readOnly: true });
const tasks = db.prepare('SELECT id,title,status,worker_id,attempts,cost_usd,created_at,finished_at FROM tasks ORDER BY created_at').all() as Record<string, unknown>[];
const runs = db.prepare('SELECT id,task_id,worker_id,harness,model,status,exit_code,cost_usd,session_id FROM runs ORDER BY started_at').all() as Record<string, unknown>[];
const spend = db.prepare('SELECT id,merchant_name,amount_cents,status,test,last4,created_at FROM spend ORDER BY created_at').all() as Record<string, unknown>[];
db.close();

const id = body.identity();
const md: string[] = [`# 真实环境运行 — ${new Date().toISOString()}`, '', `agent：**${id.name}**，出生于 ${id.bornAt}，家长：${id.parent.name}`, ''];
md.push('## 身份（真实开出来的）', '', '| 身份 | 状态 | 值 | 谁开的 |', '|---|---|---|---|');
for (const [k, r] of Object.entries(id.identities)) md.push(`| ${k} | ${r.status} | ${String(r.value ?? '').replace(/\|/g, '\\|').slice(0, 60)} | ${r.openedBy ?? ''} |`);

md.push('', '## 对真实服务的调用', '', '| 服务 | 次数 | 状态码 |', '|---|---|---|');
const byService = new Map<string, Map<string, number>>();
for (const e of api) {
  const m = byService.get(e.service) ?? new Map<string, number>();
  const st = String(e.response?.status ?? (e.error ? 'error' : '?'));
  m.set(st, (m.get(st) ?? 0) + 1);
  byService.set(e.service, m);
}
for (const [svc, m] of byService) md.push(`| ${svc} | ${[...m.values()].reduce((a, b) => a + b, 0)} | ${[...m.entries()].map(([s, n]) => `${s}×${n}`).join(' ')} |`);

md.push('', '## 任务', '', '| 任务 | 标题 | 状态 | worker | 尝试 | 花费 |', '|---|---|---|---|---|---|');
for (const t of tasks) md.push(`| ${t.id} | ${String(t.title).replace(/\|/g, '\\|')} | ${t.status} | ${t.worker_id ?? ''} | ${t.attempts} | $${Number(t.cost_usd).toFixed(4)} |`);
md.push('', '## worker 运行', '', '| run | 任务 | worker | harness | 模型 | 状态 | exit | 花费 |', '|---|---|---|---|---|---|---|---|');
for (const r of runs) md.push(`| ${r.id} | ${r.task_id} | ${r.worker_id} | ${r.harness} | ${r.model ?? ''} | ${r.status} | ${r.exit_code ?? ''} | $${Number(r.cost_usd).toFixed(4)} |`);
if (spend.length) {
  md.push('', '## 钱', '', '| spend request | 商户 | 金额 | 状态 | 测试 | 尾号 |', '|---|---|---|---|---|---|');
  for (const s of spend) md.push(`| ${s.id} | ${s.merchant_name} | $${(Number(s.amount_cents) / 100).toFixed(2)} | ${s.status} | ${s.test ? '是' : '否'} | ${s.last4 ?? ''} |`);
}
md.push('', '## router 的决定（events）', '', '```');
for (const e of events.filter((x) => /^(router\.(bound|classified|answered|feedback|stranger|notify)|task\.|worker\.(dispatched|report|exit|ask)|pay\.|mail\.|sms\.|call\.)/.test(x.type)).slice(-80)) {
  md.push(`${e.ts} ${e.type} ${JSON.stringify({ ...e, ts: undefined, type: undefined }).slice(0, 220)}`);
}
md.push('```');

md.push('', '## 每个接口一组真实的请求/响应', '');
const seen = new Set<string>();
for (const e of api) {
  const k = `${e.service} ${e.method} ${String(e.url).replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '').replace(/bot<redacted>/, 'bot<token>')}`;
  if (seen.has(k)) continue;
  seen.add(k);
  const body = JSON.stringify({ url: e.url, request: e.request, response: e.response, error: e.error }, null, 2);
  md.push(`### \`${k}\``, '', `${e.ts} · ${e.durationMs} ms · ${e.response?.status ?? e.error}`, '', '<details><summary>request / response</summary>', '', '```json', body.length > 3000 ? body.slice(0, 3000) + '\n… (truncated)' : body, '```', '', '</details>', '');
}
if (videos.length) md.push('', '## agent 自己浏览器的录屏', '', ...videos.map((v) => `- [videos/${v}](../videos/${v})`));
fs.writeFileSync(path.join(OUT, 'LIVE-RUN.md'), md.join('\n') + '\n');
console.log(`wrote ${path.join(OUT, 'LIVE-RUN.md')}: ${api.length} real API calls, ${tasks.length} tasks, ${videos.length} videos`);
