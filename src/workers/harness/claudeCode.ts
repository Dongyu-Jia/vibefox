import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import type { Harness, HarnessContext, HarnessExit } from './types.ts';
import { onLines, shorten, which, workerEnv } from './types.ts';

let loginCache: { at: number; ok: boolean } | undefined;

function claudeLoggedIn(): boolean {
  if (loginCache && Date.now() - loginCache.at < 5 * 60_000) return loginCache.ok;
  const r = spawnSync('claude', ['auth', 'status', '--json'], { encoding: 'utf8', env: workerEnv({}), timeout: 20_000 });
  let ok = false;
  try {
    ok = Boolean((JSON.parse(r.stdout) as { loggedIn?: boolean }).loggedIn);
  } catch {}
  loginCache = { at: Date.now(), ok };
  return ok;
}

/** Claude Code in headless mode (`claude -p … --output-format stream-json`). */
export const claudeCodeHarness: Harness = {
  kind: 'claude-code',
  liveSupplement: false,
  available(spec) {
    if (!which('claude')) return { ok: false, reason: 'claude CLI not found (npm i -g @anthropic-ai/claude-code)' };
    if (spec.env?.ANTHROPIC_API_KEY || spec.env?.ANTHROPIC_AUTH_TOKEN) return { ok: true };
    return claudeLoggedIn() ? { ok: true } : { ok: false, reason: 'Claude Code is not logged in (run: claude auth login)' };
  },
  start(ctx: HarnessContext) {
    const args = [
      '-p', ctx.prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
      '--append-system-prompt', ctx.systemPrompt,
      '--mcp-config', ctx.mcpConfigPath,
    ];
    if (ctx.spec.model) args.push('--model', ctx.spec.model);
    if (ctx.resumeSession) args.push('--resume', ctx.resumeSession);
    const child = spawn('claude', args, { cwd: ctx.workspace, env: ctx.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const transcript = fs.createWriteStream(ctx.transcriptPath, { flags: 'a' });
    const exit: HarnessExit = { code: 1 };
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
      if (ev.session_id && exit.sessionId !== String(ev.session_id)) {
        exit.sessionId = String(ev.session_id);
        ctx.onSession(exit.sessionId);
      }
      if (ev.type === 'assistant') {
        const content = ((ev.message as { content?: unknown[] })?.content ?? []) as { type: string; name?: string; input?: Record<string, unknown>; text?: string }[];
        for (const blk of content) {
          if (blk.type === 'tool_use') {
            const input = blk.input ?? {};
            const detail = String(input.command ?? input.url ?? input.file_path ?? input.query ?? '');
            ctx.onProgress(`🔧 ${blk.name}${detail ? ' · ' + shorten(detail, 80) : ''}`);
          }
        }
      }
      if (ev.type === 'result') {
        exit.finalText = String(ev.result ?? '');
        exit.costUsd = Number(ev.total_cost_usd ?? 0);
        if (ev.is_error) exit.error = exit.finalText;
      }
    });
    const done = new Promise<HarnessExit>((resolve) => {
      child.on('error', (err) => resolve({ ...exit, code: 127, error: String(err.message) }));
      child.on('close', (code) => {
        transcript.end();
        if (code !== 0 && !exit.error) exit.error = shorten(stderr || `exit ${code}`, 500);
        resolve({ ...exit, code: code ?? 1 });
      });
    });
    return { child, done };
  },
};
