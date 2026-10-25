// Fake OpenCode for tests: emits `opencode run --format json` style events and uses `vf`.
import { execFileSync } from 'node:child_process';
const args = process.argv.slice(2);
const session = 'ses_fake' + process.pid;
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const vf = (...a) => {
  emit({ type: 'tool_use', sessionID: session, part: { type: 'tool', tool: 'bash', sessionID: session, state: { status: 'running', input: { command: 'vf ' + a.join(' ') } } } });
  return execFileSync('vf', a, { encoding: 'utf8', env: process.env });
};
const prompt = args[args.length - 1];
const shop = /(http:\/\/127\.0\.0\.1:\d+)/.exec(prompt)?.[1];
let text = 'OpenCode finished.';
if (shop) {
  const snap = vf('browser', 'open', shop + '/events');
  const kids = snap.split('\n').filter((l) => /Yes$/.test(l) && /Sat|Sun/.test(l)).length;
  text = `OpenCode 看了 ${shop}/events：这周末有 ${kids} 个适合孩子的活动。`;
}
vf('report', '--status', 'done', '--summary', text);
emit({ type: 'text', sessionID: session, part: { type: 'text', text, sessionID: session } });
emit({ type: 'step_finish', sessionID: session, part: { type: 'step-finish', cost: 0.0004, sessionID: session } });
