/**
 * Live check against the REAL services and tools on this Mac. Writes
 * evidence/live/LIVE-CHECK.md plus the raw request/response log.
 *
 * Without keys it still proves the wiring: real endpoints answer (with auth
 * errors), the real link-cli runs, real OpenCode / Claude Code are driven
 * through vibefox's harnesses, and a real launchd service starts the agent.
 * With keys in env (VF_SECRET_OPENROUTER_API_KEY, VF_SECRET_TELEGRAM_BOT_TOKEN,
 * VF_SECRET_AGENTMAIL_API_KEY, VF_SECRET_AGENTPHONE_API_KEY) it makes real
 * authenticated calls too.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureLogs, loggedFetch } from '../src/core/log.ts';
import { PROJECT_ROOT } from '../src/core/paths.ts';
import { Body } from '../src/core/body.ts';
import { ScriptedPrompter } from '../src/onboarding/prompter.ts';
import { runWizard } from '../src/onboarding/wizard.ts';
import { detectHarnesses } from '../src/onboarding/detect.ts';
import { LinkWallet } from '../src/wallet/link.ts';
import { startDaemon } from '../src/daemon/daemon.ts';
import * as launchd from '../src/onboarding/launchd.ts';
import { setupKeys } from '../src/cli/keys.ts';

const OUT = path.join(PROJECT_ROOT, 'evidence', 'live');
fs.mkdirSync(OUT, { recursive: true });
// Keys typed with `vf keys` (Keychain). Only the model key is handed to this throwaway agent:
// it must never poll the parent's real Telegram bot (two pollers steal each other's messages).
const preset = setupKeys();
const key = (k: string) => process.env[`VF_SECRET_${k.toUpperCase()}`] ?? preset.get(k);
if (key('openrouter_api_key')) process.env.VF_SECRET_OPENROUTER_API_KEY = key('openrouter_api_key');
delete process.env.VF_SECRET_TELEGRAM_BOT_TOKEN;
process.env.VF_BROWSER_RECORD = '1';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibefox-live-'));
process.env.VF_HOME = home;
process.env.VF_SECRETS = 'file';
delete process.env.VF_AGENT;
const md: string[] = [`# Live check — ${new Date().toISOString()}`, '', `Machine: ${os.hostname()} · macOS ${os.release()} · Node ${process.version}`, ''];
const section = (t: string) => md.push('', `## ${t}`, '');
const line = (s: string) => {
  md.push(s);
  console.log(s);
};

// A real (blank) agent body for this check.
const body: Body = await runWizard({ prompter: new ScriptedPrompter({ name: 'Fox Live', parent_name: 'Dongyu', soul: 'curious' }, true), steps: ['birth'] });
configureLogs(body.paths.logs);

section('1. Real service endpoints');
const probes: [string, string, Record<string, string>][] = [
  ['openrouter', 'https://openrouter.ai/api/v1/models', {}],
  ['openrouter', 'https://openrouter.ai/api/v1/key', { authorization: `Bearer ${key('openrouter_api_key') ?? 'sk-or-v1-not-a-real-key'}` }],
  ['telegram', `https://api.telegram.org/bot${key('telegram_bot_token') ?? '0:not-a-real-token'}/getMe`, {}],
  ['agentmail', 'https://api.agentmail.to/v0/inboxes?limit=1', { authorization: `Bearer ${key('agentmail_api_key') ?? 'not-a-real-key'}` }],
  ['agentphone', 'https://api.agentphone.ai/v1/numbers?limit=1&offset=0', { authorization: `Bearer ${key('agentphone_api_key') ?? 'not-a-real-key'}` }],
];
line('| service | request | status | what it said |');
line('|---|---|---|---|');
for (const [svc, url, headers] of probes) {
  try {
    const res = await loggedFetch(svc, url, { headers });
    const text = await res.text();
    let said = text.slice(0, 140).replace(/\s+/g, ' ');
    if (svc === 'openrouter' && url.endsWith('/models') && res.ok) {
      const ids = (JSON.parse(text).data as { id: string }[]).map((m) => m.id);
      said = `${ids.length} models; has ${['deepseek/deepseek-v4.1-flash', 'anthropic/claude-sonnet-5.5', 'anthropic/claude-opus-5.5', 'anthropic/claude-haiku-5.5'].filter((m) => ids.includes(m)).join(', ')}`;
    }
    line(`| ${svc} | \`GET ${url.replace(/bot[^/]+/, 'bot<token>')}\` | ${res.status} | ${said.replace(/\|/g, '\\|')} |`);
  } catch (err) {
    line(`| ${svc} | \`GET ${url}\` | error | ${(err as Error).message} |`);
  }
}

section('2. Real Stripe Link CLI');
const wallet = new LinkWallet();
const st = await wallet.authStatus();
line(`- \`link-cli auth status\` → authenticated: **${st.authenticated}**${st.authenticated ? '' : ' (the parent connects the wallet once with `link-cli auth login` and approves in the Link app)'}`);
if (st.authenticated) {
  const info = await wallet.userInfo();
  line(`- \`link-cli user-info retrieve\` → ${JSON.stringify(info).slice(0, 300)}`);
}

section('3. Harnesses detected on this Mac');
const det = detectHarnesses();
line(`- Claude Code: installed **${det.claude.installed}**, logged in **${det.claude.loggedIn}** (${det.claude.detail ?? ''})`);
line(`- OpenCode: installed **${det.opencode.installed}**, providers: ${det.opencode.providers.join(', ') || '—'}`);
line(`- Codex: installed **${det.codex.installed}**, runs **${det.codex.works}**`);
line(`- DeepSeek Harness (official dsh): installed **${det.dsh.installed}**`);
line(`- Codewhale (third-party): installed **${det.codewhale.installed}**`);

section('4. Real harness runs through vibefox: real model, real website, the agent’s own browser');
body.saveWorkers([
  { id: 'builtin-deepseek', label: 'builtin · deepseek-v4.1-flash (OpenRouter)', harness: 'builtin', model: 'openrouter:deepseek/deepseek-v4.1-flash', tier: 1, description: 'vibefox loop', enabled: true },
  { id: 'deepseek-harness', label: 'DeepSeek Harness（官方 dsh）· deepseek-v4.1-flash (OpenRouter)', harness: 'dsh', model: 'openrouter/deepseek/deepseek-v4.1-flash', tier: 1, description: 'official DeepSeek harness', enabled: true },
  { id: 'opencode-deepseek', label: 'OpenCode · deepseek-v4.1-flash (OpenRouter)', harness: 'opencode', model: 'openrouter/deepseek/deepseek-v4.1-flash', tier: 1, description: 'real OpenCode', enabled: true },
  { id: 'claude-code', label: 'Claude Code (Opus)', harness: 'claude-code', model: 'opus', tier: 3, description: 'real Claude Code', enabled: true },
]);
const d = await startDaemon({ port: 0 });
const BROWSER_TASK = 'Use your own browser through the shell: run `vf browser open https://news.ycombinator.com`, read the snapshot, then click the "new" link at the top (use its [ref] with `vf browser click <ref>`) and read the newest story title. Finish with `vf report --status done --summary "<top 3 front-page titles, then the newest story title>"`. Use only the vf commands for the browser.';
fs.mkdirSync(path.join(PROJECT_ROOT, 'evidence', 'videos'), { recursive: true });
for (const spec of body.workers()) {
  const task = d.store.createTask({ title: `live ${spec.id}`, description: BROWSER_TASK, kind: 'browser' });
  const run = d.manager.dispatch(task, spec);
  const started = Date.now();
  while (d.manager.isRunning(run.id) && Date.now() - started < 180_000) await new Promise((r) => setTimeout(r, 1000));
  const r = d.store.run(run.id)!;
  const tr = r.transcript && fs.existsSync(r.transcript) ? fs.readFileSync(r.transcript, 'utf8') : '';
  fs.writeFileSync(path.join(OUT, `transcript-${spec.id}.jsonl`), tr);
  const events = d.store.events(task.id).map((e) => `${e.type}${e.data.reason ? ': ' + String(e.data.reason).slice(0, 200) : e.data.summary ? ': ' + String(e.data.summary).slice(0, 200) : ''}`);
  line(`### ${spec.label}`);
  line(`- run ${r.id}: status **${r.status}**, exit ${r.exit_code}, session ${r.session_id ?? '—'}, ${Math.round((Date.now() - started) / 1000)}s`);
  line(`- task events: ${events.join(' → ')}`);
  const report = d.store.events(task.id).filter((e) => e.type === 'report').pop();
  if (report) line(`- report: ${String(report.data.summary ?? '').replace(/\n/g, ' ').slice(0, 600)}`);
  const browserCalls = d.store.events(task.id).filter((e) => e.type === 'progress' && /browser/.test(String(e.data.text))).length;
  line(`- browser actions seen: ${browserCalls}`);
  const errLine = tr.split('\n').find((l) => /"type":"error"|guardrail|Failed to authenticate/i.test(l));
  if (errLine) line(`- what the real tool said: \`${errLine.slice(0, 400).replace(/`/g, "'")}\``);
  const vids = await d.browser.close();
  for (const v of vids) {
    const dst = path.join(PROJECT_ROOT, 'evidence', 'videos', `live-${spec.id}-browser.mp4`);
    spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', v, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', dst]);
    line(`- recording of its browser: [videos/${path.basename(dst)}](../videos/${path.basename(dst)})`);
  }
  line('');
}
await d.stop();

section('5. Real launchd service (24/7)');
const inst = launchd.install(body);
line(`- wrote ${inst.plist}, bootstrap ok: **${inst.loaded}** ${inst.out}`);
let health = '';
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  if (fs.existsSync(body.paths.daemonJson)) {
    try {
      const info = JSON.parse(fs.readFileSync(body.paths.daemonJson, 'utf8')) as { url: string; pid: number };
      const res = await fetch(`${info.url}/v1/health`);
      health = `pid ${info.pid}, GET /v1/health → ${res.status} ${await res.text()}`;
      break;
    } catch {}
  }
}
const s1 = launchd.status(body.slug);
line(`- launchctl: state **${s1.detail}**, pid ${s1.pid ?? '—'}; daemon ${health || 'did not answer'}`);
fs.copyFileSync(inst.plist, path.join(OUT, path.basename(inst.plist)));
launchd.uninstall(body.slug);
await new Promise((r) => setTimeout(r, 1500));
const s2 = launchd.status(body.slug);
line(`- after \`vf uninstall\`: installed **${s2.installed}**, state ${s2.detail}`);

// Raw request/response log of everything above.
for (const f of fs.readdirSync(body.paths.apiLogs)) fs.copyFileSync(path.join(body.paths.apiLogs, f), path.join(OUT, `api-${f}`));
fs.writeFileSync(path.join(OUT, 'LIVE-CHECK.md'), md.join('\n') + '\n');
console.log(`\nwrote ${path.join(OUT, 'LIVE-CHECK.md')}`);
fs.rmSync(home, { recursive: true, force: true });
process.exit(0);
