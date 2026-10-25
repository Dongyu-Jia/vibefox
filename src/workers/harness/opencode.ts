import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { Harness, HarnessContext, HarnessExit } from './types.ts';
import { onLines, shorten, which } from './types.ts';

/** OpenCode (`opencode run --format json`), any model it has a provider for — e.g. DeepSeek via OpenRouter. */
export const opencodeHarness: Harness = {
  kind: 'opencode',
  liveSupplement: false,
  available(spec) {
    if (!which('opencode')) return { ok: false, reason: 'opencode not installed' };
    if (!spec.model) return { ok: false, reason: 'opencode worker needs a model like openrouter/deepseek/deepseek-v4.1-flash' };
    return { ok: true };
  },
  start(ctx: HarnessContext) {
    const args = ['run', '--model', ctx.spec.model!, '--format', 'json', '--auto', '--dir', ctx.workspace, '--title', `vibefox ${ctx.task.id}`];
    if (ctx.resumeSession) args.push('--session', ctx.resumeSession);
    args.push(ctx.resumeSession ? ctx.prompt : `${ctx.systemPrompt}\n\n---\n\n${ctx.prompt}`);
    const child = spawn('opencode', args, { cwd: ctx.workspace, env: ctx.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const transcript = fs.createWriteStream(ctx.transcriptPath, { flags: 'a' });
    const exit: HarnessExit = { code: 1 };
    let lastText = '';
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
      const sid = ev.sessionID ?? (ev.part as Record<string, unknown> | undefined)?.sessionID;
      if (sid && exit.sessionId !== String(sid)) {
        exit.sessionId = String(sid);
        ctx.onSession(exit.sessionId);
      }
      const part = (ev.part ?? {}) as { type?: string; text?: string; tool?: string; state?: { input?: Record<string, unknown>; status?: string } };
      if (part.type === 'text' && part.text) lastText = part.text;
      if (part.type === 'tool' && part.tool) {
        const input = part.state?.input ?? {};
        const detail = String(input.command ?? input.url ?? input.filePath ?? '');
        ctx.onProgress(`🔧 ${part.tool}${detail ? ' · ' + shorten(detail, 80) : ''}`);
      }
      if (ev.type === 'error') {
        const err = ev.error as { data?: { message?: string }; name?: string } | undefined;
        exit.error = shorten(err?.data?.message ?? err?.name ?? 'opencode error', 600);
      }
      const cost = (ev.part as { cost?: number } | undefined)?.cost;
      if (typeof cost === 'number') exit.costUsd = (exit.costUsd ?? 0) + cost;
    });
    const done = new Promise<HarnessExit>((resolve) => {
      child.on('error', (err) => resolve({ ...exit, code: 127, error: String(err.message) }));
      child.on('close', (code) => {
        transcript.end();
        exit.finalText = lastText;
        if (exit.error) code = code || 1;
        else if (code !== 0) exit.error = shorten(stderr || `exit ${code}`, 500);
        resolve({ ...exit, code: code ?? 1 });
      });
    });
    return { child, done };
  },
};
