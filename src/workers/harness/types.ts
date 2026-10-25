import { spawnSync, type ChildProcess } from 'node:child_process';
import type { WorkerSpec } from '../../core/body.ts';
import type { Run, Task } from '../../core/store.ts';
import { PROJECT_BIN_DIR } from '../../core/paths.ts';

export interface HarnessContext {
  task: Task;
  run: Run;
  spec: WorkerSpec;
  workspace: string;
  prompt: string;
  systemPrompt: string;
  env: NodeJS.ProcessEnv;
  mcpConfigPath: string;
  transcriptPath: string;
  resumeSession?: string;
  onProgress: (text: string) => void;
  /** Called as soon as the harness knows its session id (needed to resume it mid-run). */
  onSession: (id: string) => void;
}

export interface HarnessExit {
  code: number;
  sessionId?: string;
  finalText?: string;
  costUsd?: number;
  error?: string;
}

export interface HarnessProcess {
  child: ChildProcess;
  done: Promise<HarnessExit>;
}

export interface Harness {
  kind: WorkerSpec['harness'];
  /** Can accept new instructions mid-run (otherwise the manager restarts with --resume). */
  liveSupplement: boolean;
  available(spec: WorkerSpec): { ok: boolean; reason?: string };
  start(ctx: HarnessContext): HarnessProcess;
}

export function which(bin: string): string | undefined {
  const r = spawnSync('/usr/bin/which', [bin], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

/** Vars the Claude desktop host injects into child shells; a worker must not inherit the host session. */
const HOST_VARS = /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_AGENT_SDK_.*|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PREVIEW_.*|ANTHROPIC_BASE_URL)$/;

export function workerEnv(extra: Record<string, string>, specEnv: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!HOST_VARS.test(k)) env[k] = v;
  env.PATH = `${PROJECT_BIN_DIR}:${process.env.PATH ?? ''}`;
  return { ...env, ...extra, ...specEnv };
}

/** Feed a child's stdout line by line. */
export function onLines(stream: NodeJS.ReadableStream | null, fn: (line: string) => void): void {
  if (!stream) return;
  let buf = '';
  stream.on('data', (d: Buffer) => {
    buf += d.toString();
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim()) fn(line);
    }
  });
  stream.on('end', () => {
    if (buf.trim()) fn(buf);
  });
}

export function shorten(s: string, n = 120): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}
