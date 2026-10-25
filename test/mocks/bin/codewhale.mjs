// Fake Codewhale for tests: `codewhale --provider p --model m exec --auto --output-format stream-json "<prompt>"`.
import { execFileSync } from 'node:child_process';
const args = process.argv.slice(2);
const emit = (o) => process.stdout.write(JSON.stringify({ ...o, schema_version: 1, schema: 'codewhale.exec-stream' }) + '\n');
const vf = (...a) => {
  emit({ type: 'tool_use', name: 'bash', id: String(Math.random()), input: { command: 'vf ' + a.join(' ') } });
  const out = execFileSync('vf', a, { encoding: 'utf8', env: process.env });
  emit({ type: 'tool_result', name: 'bash', output: out.slice(0, 200), status: 'success' });
  return out;
};
const prompt = args[args.length - 1];
const provider = args[args.indexOf('--provider') + 1];
const model = args[args.indexOf('--model') + 1];
if (!process.env.OPENROUTER_API_KEY && provider === 'openrouter') { process.stderr.write('missing OPENROUTER_API_KEY\n'); process.exit(2); }
const shop = /(http:\/\/127\.0\.0\.1:\d+)/.exec(prompt)?.[1];
let text = 'Codewhale finished.';
if (shop) {
  const snap = vf('browser', 'open', shop + '/');
  const items = snap.split('\n').filter((l) => /\$\d+\.\d\d$/.test(l)).length;
  text = `Codewhale（${model} via ${provider}）看了菜单：一共 ${items} 样东西，最便宜的是 Butter croissant $4.25。`;
}
vf('report', '--status', 'done', '--summary', text);
for (const chunk of text.match(/.{1,20}/g) ?? []) emit({ type: 'content', content: chunk });
emit({ type: 'session_capture', content: '<redacted>', saved_session_id: 'cw-fake-' + process.pid });
emit({ type: 'metadata', meta: { provider, model, input_tokens: 1000, output_tokens: 50 } });
emit({ type: 'done' });
