import fs from 'node:fs';
import path from 'node:path';
import { Body } from '../core/body.ts';

/** Talks to the running daemon. Workers get URL + token via env; humans via daemon.json. */
export class DaemonClient {
  readonly url: string;
  readonly token: string;
  readonly runId?: string;
  readonly taskId?: string;

  constructor(url: string, token: string, runId?: string, taskId?: string) {
    this.url = url.replace(/\/$/, '');
    this.token = token;
    this.runId = runId;
    this.taskId = taskId;
  }

  static fromEnv(): DaemonClient {
    if (process.env.VF_API_URL && process.env.VF_API_TOKEN) {
      return new DaemonClient(process.env.VF_API_URL, process.env.VF_API_TOKEN, process.env.VF_RUN_ID, process.env.VF_TASK_ID);
    }
    // Inside a task workspace whose harness scrubbed our env: never fall back to some other agent's daemon.
    const runFile = findRunFile(process.cwd());
    if (runFile) {
      const r = JSON.parse(fs.readFileSync(runFile, 'utf8')) as { url: string; token: string; runId: string; taskId: string; home: string; agent: string };
      process.env.VF_HOME ??= r.home;
      process.env.VF_AGENT ??= r.agent;
      return new DaemonClient(r.url, r.token, r.runId, r.taskId);
    }
    const body = Body.open();
    if (!fs.existsSync(body.paths.daemonJson)) throw new Error('The agent is not running. Start it with `vf start`.');
    const info = JSON.parse(fs.readFileSync(body.paths.daemonJson, 'utf8')) as { url: string; token: string };
    return new DaemonClient(info.url, info.token);
  }

  async request<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.url}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: unknown = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const msg = (data as { error?: string }).error ?? text;
      throw new Error(msg);
    }
    return data as T;
  }

  get<T = Record<string, unknown>>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T = Record<string, unknown>>(path: string, body: unknown = {}): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  /** Start a long operation (pay, call) and wait for it without hitting HTTP timeouts. */
  async op<T = Record<string, unknown>>(path: string, body: unknown, onWait?: (status: string) => void): Promise<T> {
    const started = await this.post<{ opId: string }>(path, body);
    for (;;) {
      const st = await this.get<{ status: 'running' | 'done' | 'error'; result?: T; error?: string; note?: string }>(`/v1/ops/${started.opId}?wait=45`);
      if (st.status === 'done') return st.result as T;
      if (st.status === 'error') throw new Error(st.error ?? 'operation failed');
      if (st.note) onWait?.(st.note);
    }
  }

  runPath(suffix: string): string {
    if (!this.runId) throw new Error('This command only works inside a worker run (VF_RUN_ID is not set).');
    return `/v1/runs/${this.runId}/${suffix}`;
  }
}

function findRunFile(dir: string): string | undefined {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const f = path.join(d, '.vf-run.json');
    if (fs.existsSync(f)) return f;
    if (path.dirname(d) === d) return undefined;
  }
}
