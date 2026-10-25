// Fake DeepSeek Harness for tests: `dsh --profile headless --json "<task>"`, same event shapes as the real one.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const patch = path.join(process.env.DSH_HOME ?? '', 'profiles', 'headless', 'cordis.patch.yml');
const cfg = fs.existsSync(patch) ? fs.readFileSync(patch, 'utf8') : '';
const model = /model: (\S+)/.exec(cfg.split('agent-default-model')[1] ?? '')?.[1] ?? '?';
if (/OPENROUTER_API_KEY/.test(cfg) && !process.env.OPENROUTER_API_KEY) { process.stderr.write('missing OPENROUTER_API_KEY\n'); process.exit(2); }
if (process.env.DSH_PERMISSION_MODE !== 'danger-full-access') { process.stderr.write('expected full access\n'); process.exit(3); }
const at = args.indexOf('--session-id');
const resumed = at >= 0 ? args[at + 1] : undefined;
emit({ type: 'session', sessionId: resumed ?? 'session-fake-' + process.pid, cwd: process.cwd() });
// Like the real dsh when OpenRouter's connection drops: every retry fails, the turn ends in error.
if (/FLAKY/.test(args[args.length - 1]) && !resumed) {
  // What the fetch trace recorded in the real failure: a TLS alert, then a dead HTTP/2 session on every retry.
  const fail = (code, message) => JSON.stringify({ ts: new Date().toISOString(), url: 'https://openrouter.ai/api/v1/chat/completions', chain: [{ name: 'TypeError', message: 'fetch failed' }, { name: 'Error', message, code }] }) + '\n';
  if (process.env.VF_FETCH_LOG) fs.appendFileSync(process.env.VF_FETCH_LOG, fail('ERR_SSL_SSL/TLS_ALERT_BAD_RECORD_MAC', 'bad record mac') + fail('ERR_HTTP2_INVALID_SESSION', 'The session has been destroyed').repeat(2));
  emit({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'error', error: { message: 'Connection error.', code: 'TRANSPORT' } } });
  process.stderr.write('dsh: TRANSPORT: Connection error.\n');
  process.exit(1);
}
let n = 0;
const vf = (...a) => {
  const callId = 'call-' + ++n;
  emit({ type: 'tool_call', callId, tool: 'bash', input: { command: 'vf ' + a.join(' ') } });
  // Like the real dsh bash sandbox: tools run with a scrubbed environment.
  const out = execFileSync('vf', a, { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  emit({ type: 'tool_result', callId, status: 'completed', result: out.slice(0, 200) });
  return out;
};
const prompt = args[args.length - 1];
const shop = /(http:\/\/127\.0\.0\.1:\d+)/.exec(prompt)?.[1];
let text = 'done';
if (resumed && /connection error/i.test(prompt)) text = `接着会话 ${resumed} 做完了：连接断了以后续上了。`;
if (shop) {
  const snap = vf('browser', 'open', shop + '/events');
  const free = snap.split('\n').filter((l) => /\tFree\t/.test(l)).length;
  text = `DeepSeek Harness（${model}）看了活动页：这周末有 ${free} 个免费活动。`;
}
vf('report', '--status', 'done', '--summary', text);
emit({ type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 8606, outputTokens: 152, totalTokens: 8758 } });
emit({ type: 'status', phase: 'step_end', turn: 1, step: 2, usage: { inputTokens: 334, outputTokens: 523, totalTokens: 9305, cacheReadTokens: 8448 } });
emit({ type: 'text', text });
emit({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } });
emit({ type: 'final', text });
