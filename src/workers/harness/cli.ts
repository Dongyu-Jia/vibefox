import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { Harness, HarnessContext, HarnessExit } from './types.ts';
import { onLines, shorten, which } from './types.ts';

/**
 * Any other agent CLI (Codex, Gemini CLI, aider…). `command` is an argv
 * template; `{prompt}` gets system prompt + task, `{workspace}` the task dir.
 * The tools come through `vf` on PATH and AGENTS.md in the workspace.
 */
export const cliHarness: Harness = {
  kind: 'cli',
  liveSupplement: false,
  available(spec) {
    if (!spec.command?.length) return { ok: false, reason: 'cli worker needs a command template' };
    return which(spec.command[0]) ? { ok: true } : { ok: false, reason: `${spec.command[0]} not found` };
  },
  start(ctx: HarnessContext) {
    const full = `${ctx.systemPrompt}\n\n---\n\n${ctx.prompt}`;
    const argv = ctx.spec.command!.map((a) => a.replace('{prompt}', full).replace('{workspace}', ctx.workspace));
    const child = spawn(argv[0], argv.slice(1), { cwd: ctx.workspace, env: ctx.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const transcript = fs.createWriteStream(ctx.transcriptPath, { flags: 'a' });
    const exit: HarnessExit = { code: 1 };
    let out = '';
    let stderr = '';
    child.stderr?.on('data', (d) => (stderr += d));
    onLines(child.stdout, (line) => {
      transcript.write(line + '\n');
      out += line + '\n';
    });
    const done = new Promise<HarnessExit>((resolve) => {
      child.on('error', (err) => resolve({ ...exit, code: 127, error: err.message }));
      child.on('close', (code) => {
        transcript.end();
        exit.finalText = out.trim().split('\n').slice(-40).join('\n');
        if (code !== 0) exit.error = shorten(stderr || `exit ${code}`, 500);
        resolve({ ...exit, code: code ?? 1 });
      });
    });
    return { child, done };
  },
};

export const codexHarness: Harness = {
  ...cliHarness,
  kind: 'codex',
  available() {
    return which('codex') ? { ok: true } : { ok: false, reason: 'codex not installed' };
  },
  start(ctx) {
    const spec = { ...ctx.spec, command: ['codex', 'exec', '--full-auto', '--skip-git-repo-check', ...(ctx.spec.model ? ['--model', ctx.spec.model] : []), '{prompt}'] };
    return cliHarness.start({ ...ctx, spec });
  },
};
