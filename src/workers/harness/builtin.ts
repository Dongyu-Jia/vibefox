import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { VF_BIN } from '../../core/paths.ts';
import type { Harness, HarnessContext, HarnessExit } from './types.ts';
import { onLines, shorten } from './types.ts';

/** vibefox's own tool loop, run as a subprocess so every worker looks the same to the manager. */
export const builtinHarness: Harness = {
  kind: 'builtin',
  liveSupplement: true,
  available(spec) {
    return spec.model ? { ok: true } : { ok: false, reason: 'builtin worker needs a model' };
  },
  start(ctx: HarnessContext) {
    const args = ['--disable-warning=ExperimentalWarning', VF_BIN, 'worker', 'run', '--task', ctx.task.id, '--run', ctx.run.id, '--model', ctx.spec.model!];
    const child = spawn(process.execPath, args, { cwd: ctx.workspace, env: ctx.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const transcript = fs.createWriteStream(ctx.transcriptPath, { flags: 'a' });
    const exit: HarnessExit = { code: 1 };
    let stderr = '';
    child.stderr?.on('data', (d) => {
      stderr += d;
      transcript.write(d);
    });
    onLines(child.stdout, (line) => {
      transcript.write(line + '\n');
      try {
        const ev = JSON.parse(line) as { type: string; text?: string; costUsd?: number; final?: string };
        if (ev.type === 'tool') ctx.onProgress(`🔧 ${shorten(ev.text ?? '', 100)}`);
        if (ev.type === 'cost') exit.costUsd = ev.costUsd;
        if (ev.type === 'final') exit.finalText = ev.final;
      } catch {}
    });
    const done = new Promise<HarnessExit>((resolve) => {
      child.on('error', (err) => resolve({ ...exit, code: 127, error: err.message }));
      child.on('close', (code) => {
        transcript.end();
        if (code !== 0) exit.error = shorten(stderr.split('\n').filter(Boolean).slice(-3).join(' ') || `exit ${code}`, 500);
        resolve({ ...exit, code: code ?? 1 });
      });
    });
    return { child, done };
  },
};
