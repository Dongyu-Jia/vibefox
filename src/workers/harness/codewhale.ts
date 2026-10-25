import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { Harness, HarnessContext, HarnessExit } from './types.ts';
import { onLines, shorten, which } from './types.ts';

/**
 * Codewhale (formerly DeepSeek-TUI): a DeepSeek-first terminal agent.
 * `codewhale --provider openrouter --model deepseek/… exec --auto --output-format stream-json`.
 * Worker model spec: `openrouter/deepseek/deepseek-v4.1-flash` or `deepseek/deepseek-v4-flash`.
 */

export function codewhaleModel(spec: string): { provider: string; model: string } {
  const [first, ...rest] = spec.split('/');
  if (['openrouter', 'deepseek'].includes(first) && rest.length) return { provider: first, model: rest.join('/') };
  return { provider: 'openrouter', model: spec };
}

export const codewhaleHarness: Harness = {
  kind: 'codewhale',
  liveSupplement: false,
  available(spec) {
    if (!which('codewhale')) return { ok: false, reason: 'codewhale not installed (npm i -g codewhale)' };
    if (!spec.model) return { ok: false, reason: 'codewhale worker needs a model like openrouter/deepseek/deepseek-v4.1-flash' };
    return { ok: true };
  },
  start(ctx: HarnessContext) {
    const { provider, model } = codewhaleModel(ctx.spec.model!);
    const args = ['--provider', provider, '--model', model, 'exec', '--auto', '--output-format', 'stream-json'];
    if (ctx.resumeSession) args.push('--resume', ctx.resumeSession);
    args.push(ctx.resumeSession ? ctx.prompt : `${ctx.systemPrompt}\n\n---\n\n${ctx.prompt}`);
    const child = spawn('codewhale', args, { cwd: ctx.workspace, env: ctx.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const transcript = fs.createWriteStream(ctx.transcriptPath, { flags: 'a' });
    const exit: HarnessExit = { code: 1 };
    let text = '';
    let stderr = '';
    child.stderr?.on('data', (d) => (stderr += d));
    onLines(child.stdout, (line) => {
      transcript.write(line + '\n');
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (ev.type === 'tool_use') {
        const input = (ev.input ?? {}) as Record<string, unknown>;
        const detail = String(input.command ?? input.url ?? input.path ?? '');
        ctx.onProgress(`🔧 ${ev.name}${detail ? ' · ' + shorten(detail, 80) : ''}`);
        text = '';
      }
      if (ev.type === 'content' && typeof ev.content === 'string') text += ev.content;
      if (ev.type === 'session_capture' && ev.saved_session_id) {
        exit.sessionId = String(ev.saved_session_id);
        ctx.onSession(exit.sessionId);
      }
      if (ev.type === 'error') exit.error = shorten(String((ev as { message?: string }).message ?? JSON.stringify(ev)), 600);
    });
    const done = new Promise<HarnessExit>((resolve) => {
      child.on('error', (err) => resolve({ ...exit, code: 127, error: err.message }));
      child.on('close', (code) => {
        transcript.end();
        exit.finalText = text.trim();
        if (code !== 0 && !exit.error) exit.error = shorten(stderr.split('\n').filter((l) => !/telemetry|PostHog|Usage reporting/i.test(l)).join(' ') || `exit ${code}`, 500);
        resolve({ ...exit, code: code ?? 1 });
      });
    });
    return { child, done };
  },
};
