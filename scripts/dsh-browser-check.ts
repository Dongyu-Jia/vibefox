/**
 * Can the official DeepSeek Harness (dsh) really use and operate a browser?
 * Real dsh, real DeepSeek v4.1 flash (OpenRouter), real websites, the agent's own
 * Chromium. Each scenario is judged by what the browser itself did — the daemon's
 * browser log and the page it ends on — not by what the model says it did.
 * Writes evidence/dsh-browser/REPORT.md, one JSON + transcript per scenario, and a
 * recording of the agent's browser per scenario (evidence/videos/dsh-*.mp4).
 *
 *   node scripts/dsh-browser-check.ts [--out evidence/dsh-browser/run-2] [scenarioId ...]
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configureLogs } from '../src/core/log.ts';
import { PROJECT_ROOT } from '../src/core/paths.ts';
import type { WorkerSpec } from '../src/core/body.ts';
import { ScriptedPrompter } from '../src/onboarding/prompter.ts';
import { runWizard } from '../src/onboarding/wizard.ts';
import { startDaemon } from '../src/daemon/daemon.ts';
import { setupKeys } from '../src/cli/keys.ts';
import { startShop, type Order } from '../test/fixtures/shop.ts';

const argv = process.argv.slice(2);
const outAt = argv.indexOf('--out');
const OUT = outAt >= 0 ? path.resolve(argv.splice(outAt, 2)[1]) : path.join(PROJECT_ROOT, 'evidence', 'dsh-browser');
const VIDEOS = outAt >= 0 ? path.join(OUT, 'videos') : path.join(PROJECT_ROOT, 'evidence', 'videos');
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(VIDEOS, { recursive: true });

// Only the model key goes to this throwaway agent; it never touches the parent's real Telegram bot.
const orKey = process.env.VF_SECRET_OPENROUTER_API_KEY ?? setupKeys().get('openrouter_api_key');
if (!orKey) throw new Error('No OpenRouter key: run `vf keys` first.');
process.env.VF_SECRET_OPENROUTER_API_KEY = orKey;
delete process.env.VF_SECRET_TELEGRAM_BOT_TOKEN;
process.env.VF_BROWSER_RECORD = '1';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vibefox-dsh-browser-'));
process.env.VF_HOME = home;
process.env.VF_SECRETS = 'file';
delete process.env.VF_AGENT;

type Route = 'shell' | 'mcp' | 'free';
interface Call {
  tool: string;
  input: Record<string, unknown>;
}
interface Ctx {
  summary: string;
  finalUrl: string;
  finalSnapshot: string;
  browser: { type: string; [k: string]: unknown }[];
  calls: Call[];
  workspace: string;
  orders: Order[];
}
interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}
interface Scenario {
  id: string;
  route: Route;
  what: string;
  prompt: (shop: string) => string;
  checks: (c: Ctx) => Check[];
}

const SHELL = 'Use the shell commands `vf browser open|snapshot|click|type|select|press|back|screenshot` (run them with your bash tool) — not curl and not your web fetch tool.';
const MCP = 'Use your native browser tools mcp__vibefox__browser_open / _snapshot / _click / _type / _select / _press / _back / _screenshot — not curl, not `vf` in the shell, and not your web fetch tool.';
const has = (c: Ctx, type: string, pred: (e: Record<string, unknown>) => boolean = () => true) => c.browser.filter((e) => e.type === type && pred(e)).length;
const check = (name: string, ok: boolean, detail?: string): Check => ({ name, ok, detail });

const SCENARIOS: Scenario[] = [
  {
    id: 'hn-click',
    route: 'shell',
    what: 'read a real page, click a link, read the new page',
    prompt: () => `Open https://news.ycombinator.com in your browser, click the "new" link at the top, and report the title of the newest story. ${SHELL}`,
    checks: (c) => {
      const nav = /^(Hacker News|new|past|comments|ask|show|jobs|submit|login|hide|More|Guidelines|FAQ|Lists|API|Security|Legal|Apply to YC|Contact)$/i;
      const titles = [...c.finalSnapshot.matchAll(/^\[e\d+\] link "([^"]{5,})"/gm)].map((m) => m[1]).filter((t) => !nav.test(t) && !/^\d+ (minutes?|hours?) ago$|^\d+\s*comments?$/.test(t));
      const quoted = titles.find((t) => c.summary.toLowerCase().includes(t.toLowerCase()));
      return [
        check('browser opened news.ycombinator.com', has(c, 'browser.open', (e) => String(e.url).includes('news.ycombinator.com')) > 0),
        check('browser clicked through to /newest', has(c, 'browser.click', (e) => String(e.url).includes('/newest')) > 0),
        check('ends on /newest', c.finalUrl.includes('/newest'), c.finalUrl),
        check('the reported title is on that page', Boolean(quoted), quoted ?? c.summary.slice(0, 160)),
      ];
    },
  },
  {
    id: 'wiki-search',
    route: 'mcp',
    what: 'type into a search box and submit',
    prompt: () => `Open https://en.wikipedia.org/wiki/Main_Page, search for "Alan Turing" with the search box on the page (type it and submit), and from his article report his date of birth. ${MCP}`,
    checks: (c) => [
      check('browser typed into the page', has(c, 'browser.type') > 0),
      check('ends on the Alan Turing article', /\/wiki\/Alan_Turing/.test(c.finalUrl), c.finalUrl),
      check('reports 23 June 1912', /23 June 1912|June 23,? 1912|1912年6月23日|1912-06-23/.test(c.summary), c.summary.slice(0, 200)),
    ],
  },
  {
    id: 'form-submit',
    route: 'mcp',
    what: 'fill a real form: text fields, a radio, two checkboxes, a textarea; submit',
    prompt: () =>
      `Open https://httpbin.org/forms/post and fill the pizza order form: customer name "Vibefox Fox", telephone "4155550100", e-mail "fox@example.com", size Medium, toppings Bacon and Onion, delivery instructions "dsh browser test". Press "Submit order" and report what the server echoes back in its "form" field. ${MCP}`,
    checks: (c) => {
      const t = c.finalSnapshot;
      return [
        check('browser typed ≥ 4 fields', has(c, 'browser.type') >= 4, `${has(c, 'browser.type')} typed`),
        check('browser clicked radio/checkboxes/submit (≥ 4 clicks)', has(c, 'browser.click') >= 4, `${has(c, 'browser.click')} clicks`),
        check('ends on httpbin /post (form was submitted)', c.finalUrl.startsWith('https://httpbin.org/post'), c.finalUrl),
        check('server got custname = Vibefox Fox', /"custname":\s*"Vibefox Fox"/.test(t)),
        check('server got size = medium', /"size":\s*"medium"/.test(t)),
        check('server got toppings bacon + onion', /"topping":\s*\[[^\]]*"bacon"[^\]]*"onion"/.test(t) || /"topping":\s*\[[^\]]*"onion"[^\]]*"bacon"/.test(t)),
        check('server got the instructions', /"comments":\s*"dsh browser test"/.test(t)),
      ];
    },
  },
  {
    id: 'dropdown',
    route: 'shell',
    what: 'choose an option in a <select>',
    prompt: () => `Open https://the-internet.herokuapp.com/dropdown, choose "Option 2" in the dropdown (vf browser select), and report which option is selected. ${SHELL}`,
    checks: (c) => [
      check('browser selected an option', has(c, 'browser.select') > 0),
      check('the page’s select now has value 2', /\bselect\b[^\n]*value="2"/.test(c.finalSnapshot), (c.finalSnapshot.match(/^\[e\d+\] select[^\n]*/m) ?? [''])[0]),
      check('reports Option 2', /Option 2/.test(c.summary)),
    ],
  },
  {
    id: 'key-press',
    route: 'mcp',
    what: 'focus an input and press a key',
    prompt: () => `Open https://the-internet.herokuapp.com/key_presses, click into the input box, press the key Q with the press tool, and report exactly what the page then says below the box. ${MCP}`,
    checks: (c) => [
      check('browser pressed a key (or typed it)', has(c, 'browser.press') + has(c, 'browser.type') > 0, `press ${has(c, 'browser.press')}, type ${has(c, 'browser.type')}`),
      check('the page shows "You entered: Q"', /You entered: Q/.test(c.finalSnapshot)),
      check('reports it', /You entered:?\s*Q/i.test(c.summary)),
    ],
  },
  {
    id: 'js-wait',
    route: 'mcp',
    what: 'click a button and wait for JavaScript to render content',
    prompt: () => `Open https://the-internet.herokuapp.com/dynamic_loading/2, click "Start", wait until the loading finishes, and report the text that appeared. ${MCP}`,
    checks: (c) => [
      check('browser clicked Start', has(c, 'browser.click', (e) => String(e.url).includes('dynamic_loading/2')) > 0),
      check('the rendered page shows "Hello World!"', /Hello World!/.test(c.finalSnapshot)),
      check('reports Hello World', /Hello World/i.test(c.summary)),
    ],
  },
  {
    id: 'back-screenshot',
    route: 'shell',
    what: 'follow a link, go back, save a screenshot',
    prompt: () =>
      `Open https://example.com, click its "Learn more" link, then go back (vf browser back), save a screenshot with \`vf browser screenshot shot.png\`, and report the main heading of the page you are on after going back. ${SHELL}`,
    checks: (c) => {
      const shot = path.join(c.workspace, 'shot.png');
      const png = fs.existsSync(shot) && fs.readFileSync(shot).subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      return [
        check('browser clicked the link', has(c, 'browser.click') > 0),
        check('browser went back', has(c, 'browser.back') > 0),
        check('ends on example.com', /^https:\/\/example\.com\/?$/.test(c.finalUrl), c.finalUrl),
        check('shot.png is a real PNG in its workspace', png, shot),
        check('reports "Example Domain"', /Example Domain/.test(c.summary)),
      ];
    },
  },
  {
    id: 'shop-order',
    route: 'free',
    what: 'place an order on a site whose server records it (no tool named)',
    prompt: (shop) => `在 ${shop}/order 用浏览器下一单：Butter croissant 2 个，名字 Vibefox Fox，邮箱 fox@example.com，备注 dsh browser test。下完告诉我订单号。`,
    checks: (c) => {
      const o = c.orders.find((x) => x.name === 'Vibefox Fox');
      return [
        check('the shop’s server received the order', Boolean(o), o ? JSON.stringify(o) : `${c.orders.length} orders`),
        check('2 × croissant, right email and note', Boolean(o && o.item === 'croissant' && o.quantity === 2 && o.email === 'fox@example.com' && /dsh browser test/.test(o.note))),
        check('submitted through the browser (not curl)', has(c, 'browser.click', (e) => String(e.url).includes('/order')) > 0 && has(c, 'browser.type') >= 2),
        check('reports the order number', Boolean(o && c.summary.includes(o.id)), o?.id),
      ];
    },
  },
  {
    id: 'free-choice',
    route: 'free',
    what: 'no tool named — does it pick the browser by itself?',
    prompt: () => `去 https://the-internet.herokuapp.com/dynamic_loading/2 点 Start，告诉我加载完以后页面上出现的文字。`,
    checks: (c) => [
      check('answer is right (Hello World!)', /Hello World/i.test(c.summary)),
      check('it chose the browser on its own', has(c, 'browser.click', (e) => String(e.url).includes('dynamic_loading/2')) > 0, routeOf(c.calls)),
    ],
  },
];

function routeOf(calls: Call[]): string {
  const n = { mcp: 0, shell: 0, curl: 0, web: 0, other: 0 };
  for (const c of calls) {
    // Look at what each shell segment runs, not at text inside arguments (a report may say "no curl").
    const heads = String(c.input.command ?? '')
      .split(/[;&|\n]+/)
      .map((seg) => seg.trim().split(/\s+/).slice(0, 2).join(' '));
    if (c.tool.startsWith('mcp__vibefox__browser')) n.mcp++;
    else if (heads.some((h) => h.startsWith('vf browser'))) n.shell++;
    else if (heads.some((h) => /^(curl|wget)\b/.test(h))) n.curl++;
    else if (/web/i.test(c.tool)) n.web++;
    else n.other++;
  }
  return `MCP browser tools ${n.mcp} · shell vf browser ${n.shell} · curl/wget ${n.curl} · dsh web tools ${n.web} · other ${n.other}`;
}

function readEvents(logs: string, since: string): { type: string; ts: string; [k: string]: unknown }[] {
  return fs
    .readdirSync(logs)
    .filter((f) => f.startsWith('events-'))
    .flatMap((f) => fs.readFileSync(path.join(logs, f), 'utf8').trim().split('\n').filter(Boolean))
    .map((l) => JSON.parse(l))
    .filter((e) => e.ts >= since);
}

// ---------- run ----------

const body = await runWizard({ prompter: new ScriptedPrompter({ name: 'Fox Browser', parent_name: 'Dongyu', soul: 'curious' }, true), steps: ['birth'] });
configureLogs(body.paths.logs);
// Diagnostics for dsh's bare "Connection error.": every rejected fetch is logged with its cause chain.
const FETCH_LOG = path.join(OUT, 'fetch-failures.jsonl');
fs.rmSync(FETCH_LOG, { force: true });
const spec: WorkerSpec = {
  id: 'deepseek-harness',
  label: 'DeepSeek Harness（官方 dsh）· deepseek-v4.1-flash',
  harness: 'dsh',
  model: 'openrouter/deepseek/deepseek-v4.1-flash',
  tier: 1,
  description: 'official DeepSeek harness',
  enabled: true,
  env: { VF_FETCH_LOG: FETCH_LOG }, // the manager preloads src/workers/harness/fetch-trace.mjs for dsh
};
body.saveWorkers([spec]);
const shop = await startShop();
const d = await startDaemon({ port: 0 });
const dshVersion = spawnSync('dsh', ['--version'], { encoding: 'utf8' }).stdout.trim();
const only = argv;
const results: Record<string, unknown>[] = [];

for (const sc of SCENARIOS.filter((s) => !only.length || only.includes(s.id))) {
  const since = new Date().toISOString();
  const started = Date.now();
  const task = d.store.createTask({ title: `dsh browser: ${sc.id}`, description: sc.prompt(shop.url), kind: 'browser' });
  const run = d.manager.dispatch(task, spec);
  console.log(`▶ ${sc.id} (${sc.route}) run ${run.id}`);
  // Wait for the task, not the first run: the router may resume the session after a dropped connection.
  const busy = () => !['completed', 'failed', 'canceled'].includes(d.store.task(task.id)!.status) || d.store.runsForTask(task.id).some((x) => d.manager.isRunning(x.id));
  while (busy() && Date.now() - started < 300_000) await new Promise((r) => setTimeout(r, 1000));
  for (const x of d.store.runsForTask(task.id)) if (d.manager.isRunning(x.id)) await d.manager.stop(x.id);
  const seconds = Math.round((Date.now() - started) / 1000);
  const runs = d.store.runsForTask(task.id);
  const resumed = d.store.events(task.id).filter((e) => e.type === 'resumed').map((e) => String(e.data.reason ?? ''));

  const finalUrl = d.browser.isOpen() ? await d.browser.url() : '';
  const finalSnapshot = d.browser.isOpen() ? await d.browser.snapshot().catch((e) => `snapshot failed: ${e}`) : '';
  const r = runs[runs.length - 1];
  const transcript = runs.map((x) => (x.transcript && fs.existsSync(x.transcript) ? fs.readFileSync(x.transcript, 'utf8') : '')).join('');
  const costUsd = runs.reduce((s, x) => s + x.cost_usd, 0);
  const lines = transcript.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  const calls: Call[] = lines.filter((e) => e.type === 'tool_call').map((e) => ({ tool: String(e.tool), input: (e.input ?? {}) as Record<string, unknown> }));
  const report = d.store.events(task.id).filter((e) => e.type === 'report').pop();
  const summary = String(report?.data.summary ?? '');
  const browser = readEvents(body.paths.logs, since).filter((e) => e.type.startsWith('browser.') && e.type !== 'browser.started');
  const ctx: Ctx = { summary, finalUrl, finalSnapshot, browser, calls, workspace: d.manager.workspaceFor(task), orders: shop.orders };
  const checks = sc.checks(ctx);
  const pass = checks.every((c) => c.ok);

  const vids = await d.browser.close();
  let video = '';
  if (vids[0]) {
    video = path.join(VIDEOS, `dsh-${sc.id}.mp4`);
    spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', vids[0], '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video]);
  }
  fs.writeFileSync(path.join(OUT, `transcript-${sc.id}.jsonl`), transcript);
  const result = {
    id: sc.id,
    route: sc.route,
    what: sc.what,
    prompt: sc.prompt(shop.url),
    pass,
    checks,
    taskStatus: d.store.task(task.id)!.status,
    runs: runs.map((x) => `${x.id} ${x.status} exit ${x.exit_code} session ${x.session_id ?? '—'}`),
    resumedAfter: resumed,
    runStatus: r.status,
    exitCode: r.exit_code,
    sessionId: r.session_id,
    seconds,
    costUsd,
    routeUsed: routeOf(calls),
    toolCalls: calls.map((c) => `${c.tool} ${JSON.stringify(c.input).slice(0, 160)}`),
    browserLog: browser.map(({ ts, type, ...rest }) => `${ts} ${type} ${JSON.stringify(rest)}`),
    summary,
    finalUrl,
    finalSnapshot: finalSnapshot.slice(0, 6000),
    video: video ? path.relative(PROJECT_ROOT, video) : '',
    transcript: path.relative(PROJECT_ROOT, path.join(OUT, `transcript-${sc.id}.jsonl`)),
  };
  fs.writeFileSync(path.join(OUT, `${sc.id}.json`), JSON.stringify(result, null, 2));
  results.push(result);
  console.log(`  ${pass ? '✅' : '❌'} ${seconds}s $${costUsd.toFixed(4)} · ${runs.length} run(s)${resumed.length ? ' · resumed after: ' + resumed.join(' | ') : ''} · ${result.routeUsed}`);
  for (const c of checks) console.log(`    ${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
}
await d.stop();
await shop.close();

// ---------- report ----------

const md: string[] = [
  `# DeepSeek Harness × 浏览器 — ${new Date().toISOString()}`,
  '',
  `dsh ${dshVersion} · deepseek/deepseek-v4.1-flash（OpenRouter）· ${os.hostname()} · 每个场景都是一次真实的 dsh 运行，操作 agent 自己的 Chromium。`,
  '',
  '判定只看浏览器自己的记录（daemon 的 `browser.*` 日志）和结束时停在的页面，不看模型自己怎么说。',
  '',
  '| 场景 | 测什么 | 走哪条路 | 结果 | 实际用的工具 | 用时 | 花费 | 录屏 |',
  '|---|---|---|---|---|---|---|---|',
];
for (const r of results as any[]) {
  md.push(`| \`${r.id}\` | ${r.what} | ${r.route} | ${r.pass ? '✅' : '❌'} ${r.checks.filter((c: Check) => c.ok).length}/${r.checks.length} | ${r.routeUsed} | ${r.seconds}s | $${Number(r.costUsd).toFixed(4)} | ${r.video ? `[mp4](${path.relative(OUT, path.join(PROJECT_ROOT, r.video))})` : '—'} |`);
}
for (const r of results as any[]) {
  md.push('', `## \`${r.id}\` ${r.pass ? '✅' : '❌'}`, '', `> ${r.prompt}`, '');
  for (const c of r.checks as Check[]) md.push(`- ${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ` — \`${String(c.detail).replace(/`/g, "'").slice(0, 200)}\`` : ''}`);
  md.push('', `任务 ${r.taskStatus} · ${r.runs.join('；')}${r.resumedAfter.length ? ` · 连接断了后续上了原会话（${r.resumedAfter.join('；')}）` : ''} · 结束时的页面：${r.finalUrl || '—'}`, '');
  md.push('<details><summary>浏览器日志（daemon 记录）</summary>', '', '```', ...r.browserLog, '```', '', '</details>', '');
  md.push('<details><summary>dsh 的工具调用</summary>', '', '```', ...r.toolCalls, '```', '', '</details>', '');
  md.push('<details><summary>dsh 的汇报</summary>', '', '```', r.summary.slice(0, 3000), '```', '', '</details>');
}
const failures = fs.existsSync(FETCH_LOG) ? fs.readFileSync(FETCH_LOG, 'utf8').trim().split('\n').filter(Boolean) : [];
md.push('', '## dsh 的 "Connection error." 到底是什么', '', `这次运行里被拒绝的 fetch：${failures.length} 次（\`src/workers/harness/fetch-trace.mjs\` 记录，不含请求内容）。`, '');
if (failures.length) md.push('```', ...failures.slice(0, 20).map((l) => l.slice(0, 600)), '```');
fs.writeFileSync(path.join(OUT, 'REPORT.md'), md.join('\n') + '\n');
const passed = results.filter((r: any) => r.pass).length;
console.log(`\n${passed}/${results.length} passed → ${path.join(OUT, 'REPORT.md')}`);
fs.rmSync(home, { recursive: true, force: true });
process.exit(0);
