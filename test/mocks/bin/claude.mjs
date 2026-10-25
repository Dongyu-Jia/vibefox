// Fake Claude Code for tests: speaks stream-json and does the work through the real `vf` CLI on PATH.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === 'auth' && args[1] === 'status') { console.log(JSON.stringify({ loggedIn: true, authMethod: 'fake' })); process.exit(0); }
const prompt = args[args.indexOf('-p') + 1] ?? '';
const resume = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : undefined;
const session = resume ?? 'fake-session-' + process.pid;
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
emit({ type: 'system', subtype: 'init', session_id: session, model: args[args.indexOf('--model') + 1], mcp_servers: [{ name: 'vibefox', status: 'connected' }] });
const vf = (...a) => {
  emit({ type: 'assistant', session_id: session, message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'vf ' + a.join(' ') } }] } });
  return execFileSync('vf', a, { encoding: 'utf8', env: process.env });
};
const shop = /(http:\/\/127\.0\.0\.1:\d+)/.exec(fs.existsSync('TASK.md') ? fs.readFileSync('TASK.md', 'utf8') : prompt)?.[1];
let summary = 'done';
if (shop) {
  const snap = vf('browser', 'open', shop + '/order');
  const ref = (re) => snap.split('\n').find((l) => re.test(l))?.match(/^\[(e\d+)\]/)?.[1];
  vf('browser', 'type', ref(/name=name/), 'Fox via Claude Code');
  vf('browser', 'type', ref(/name=email/), 'fox@example.com');
  vf('browser', 'select', ref(/name=item/), 'croissant');
  vf('browser', 'type', ref(/name=quantity/), '6');
  const after = vf('browser', 'click', ref(/button "Place order"/));
  const order = /(FB-\d+)/.exec(after)?.[1];
  summary = `Claude Code 下好单了：6 个黄油可颂，订单号 ${order}。`;
}
vf('report', '--status', 'done', '--summary', summary);
emit({ type: 'assistant', session_id: session, message: { content: [{ type: 'text', text: summary }] } });
emit({ type: 'result', subtype: 'success', is_error: false, result: summary, session_id: session, total_cost_usd: 0.0123 });
