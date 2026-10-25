import type { Body, WorkerSpec } from '../core/body.ts';
import { logEvent } from '../core/log.ts';
import { PRINCIPLES } from '../core/principles.ts';
import type { Outcome, Store, Task } from '../core/store.ts';
import { chatJson, type ChatModel } from '../llm/index.ts';
import type { WorkerManager } from '../workers/manager.ts';

export const TASK_KINDS = ['research', 'writing', 'email', 'phone', 'shopping', 'browser', 'coding', 'data', 'other'] as const;

export interface RouteDecision {
  spec: WorkerSpec;
  reason: string;
  exploration: boolean;
  source: 'parent-request' | 'parent-rule' | 'learned' | 'default' | 'exploration' | 'budget';
}

export interface KindStats {
  n: number;
  ok: number;
  costUsd: number;
  bad: number;
}

/** stats[kind][workerId] */
export function statsByKind(outcomes: Outcome[]): Record<string, Record<string, KindStats>> {
  const out: Record<string, Record<string, KindStats>> = {};
  for (const o of outcomes) {
    const k = (out[o.kind] ??= {});
    const s = (k[o.worker_id] ??= { n: 0, ok: 0, costUsd: 0, bad: 0 });
    s.n++;
    s.ok += o.success;
    s.costUsd += o.cost_usd;
    if (o.feedback && o.feedback !== 'good') s.bad++;
  }
  return out;
}

export function availableWorkers(body: Body, manager: WorkerManager): WorkerSpec[] {
  return body.workers().filter((w) => w.enabled && manager.available(w).ok).sort((a, b) => a.tier - b.tier);
}

/** What parents call each harness. "deepseek" alone names a model, not the DeepSeek Harness. */
const HARNESS_ALIASES: Record<string, string[]> = {
  dsh: ['deepseekharness', 'dsh', '官方deepseek'],
  'claude-code': ['claudecode', 'claude'],
  opencode: ['opencode'],
  codewhale: ['codewhale', 'deepseektui'],
  codex: ['codex'],
};

export function matchRequestedWorker(requested: string, workers: WorkerSpec[]): WorkerSpec | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[\s_\-·]+/g, '');
  const r = norm(requested);
  const exact = workers.find((w) => w.id.toLowerCase() === requested.toLowerCase().trim());
  if (exact) return exact;
  // Longest alias first, so "deepseek harness" picks dsh and "claude code" beats a model named claude.
  const byAlias = Object.entries(HARNESS_ALIASES)
    .flatMap(([h, aliases]) => aliases.map((a) => ({ h, a })))
    .filter(({ a }) => r.includes(a))
    .sort((x, y) => y.a.length - x.a.length)
    .map(({ h }) => workers.find((w) => w.harness === h))
    .find(Boolean);
  if (byAlias) return byAlias;
  return (
    workers.find((w) => norm(w.harness) === r) ??
    workers.find((w) => norm(w.id).includes(r)) ??
    workers.find((w) => norm(w.label).includes(r)) ??
    workers.find((w) => norm(w.model ?? '').includes(r))
  );
}

export function nextTier(workers: WorkerSpec[], current: WorkerSpec, tried: Set<string>): WorkerSpec | undefined {
  const higher = workers.filter((w) => w.tier > current.tier && !tried.has(w.id)).sort((a, b) => a.tier - b.tier);
  if (higher.length) return higher[0];
  return undefined;
}

export async function chooseWorker(ctx: {
  body: Body;
  store: Store;
  manager: WorkerManager;
  model?: ChatModel;
  task: Task;
  budgetLow: boolean;
  explorationRate?: number;
}): Promise<RouteDecision | undefined> {
  const { body, store, manager, model, task } = ctx;
  const workers = availableWorkers(body, manager);
  if (!workers.length) return undefined;

  if (task.requested_worker) {
    const w = matchRequestedWorker(task.requested_worker, workers);
    if (w) return { spec: w, reason: `家长点名要 ${w.label}`, exploration: false, source: 'parent-request' };
  }

  const stats = statsByKind(store.outcomes())[task.kind] ?? {};
  let decision: RouteDecision | undefined;
  if (model) {
    try {
      const res = await chatJson<{ workerId: string; reason: string; ruleSource: 'parent' | 'learned' | 'default' }>(
        model,
        [
          {
            role: 'system',
            content: `${PRINCIPLES}\n\nYou are the agent's router choosing which worker does a task. Workers are generic; they differ only in cost and capability (tier 1 cheapest, tier 3 strongest).\nFollow the routing rules file strictly in this priority: parent rules > learned rules > default.\nReturn JSON {"workerId": "...", "reason": "one short sentence in the parent's language", "ruleSource": "parent"|"learned"|"default"}.`,
          },
          {
            role: 'user',
            content: JSON.stringify({
              routingRules: body.routing(),
              workers: workers.map((w) => ({ id: w.id, label: w.label, tier: w.tier, description: w.description })),
              task: { id: task.id, title: task.title, description: task.description, kind: task.kind, risk: task.risk },
              historyForThisKind: stats,
            }),
          },
        ],
        { tag: 'router.route', taskId: task.id, maxTokens: 300 },
      );
      const w = workers.find((x) => x.id === res.workerId);
      if (w) decision = { spec: w, reason: res.reason, exploration: false, source: res.ruleSource === 'parent' ? 'parent-rule' : res.ruleSource === 'learned' ? 'learned' : 'default' };
    } catch (err) {
      logEvent('router.route.error', { error: String((err as Error).message) });
    }
  }
  if (!decision) {
    const mid = workers.find((w) => w.tier === 2) ?? workers[0];
    decision = { spec: mid, reason: '默认：不确定的任务交给中档', exploration: false, source: 'default' };
  }

  if (ctx.budgetLow && decision.spec.tier > 1 && decision.source !== 'parent-rule') {
    const cheap = workers.find((w) => w.tier === 1);
    if (cheap) return { spec: cheap, reason: '脑子预算快用完了，先用便宜档', exploration: false, source: 'budget' };
  }

  // Occasionally try a cheaper worker on low-risk work, or the router never learns cheap ones are enough.
  const rate = ctx.explorationRate ?? Number(process.env.VF_EXPLORATION_RATE ?? 0.2);
  if (decision.spec.tier > 1 && task.risk === 'low' && decision.source !== 'parent-rule') {
    const cheaper = workers.filter((w) => w.tier < decision!.spec.tier);
    const chosenStats = stats[decision.spec.id];
    const candidate = cheaper.find((w) => (stats[w.id]?.n ?? 0) < 2);
    if (candidate && chosenStats && chosenStats.ok >= 3 && Math.random() < rate) {
      return { spec: candidate, reason: `试试 ${candidate.label} 能不能胜任这类任务（做砸了会自动升级）`, exploration: true, source: 'exploration' };
    }
  }
  return decision;
}

// ---------- learning ----------

const LEARNED_HEADING = /^## 我学到的.*$/m;

export function replaceLearnedSection(routing: string, bullets: string[]): string {
  const m = LEARNED_HEADING.exec(routing);
  const body = bullets.length ? bullets.map((b) => (b.startsWith('- ') ? b : `- ${b}`)).join('\n') : '- （还没有。每周复盘时根据结果更新，每条都附依据。）';
  if (!m) return routing.trimEnd() + `\n\n## 我学到的（router 自己维护）\n\n${body}\n`;
  const start = m.index + m[0].length;
  const rest = routing.slice(start);
  const next = rest.search(/^## /m);
  const tail = next >= 0 ? rest.slice(next) : '';
  return routing.slice(0, start) + `\n\n${body}\n\n` + tail;
}

export function learnedBulletsFromStats(stats: Record<string, Record<string, KindStats>>, workers: WorkerSpec[], minRuns = 3): string[] {
  const bullets: string[] = [];
  for (const [kind, byWorker] of Object.entries(stats)) {
    const candidates = Object.entries(byWorker)
      .map(([id, s]) => ({ w: workers.find((x) => x.id === id), s }))
      .filter((c) => c.w && c.s.n >= minRuns && c.s.ok / c.s.n >= 0.8 && c.s.bad === 0)
      .sort((a, b) => a.w!.tier - b.w!.tier || a.s.costUsd / a.s.n - b.s.costUsd / b.s.n);
    const best = candidates[0];
    if (best) {
      bullets.push(`${kind} 类任务 → ${best.w!.id}（最近 ${best.s.n} 次成功 ${best.s.ok} 次，平均 $${(best.s.costUsd / best.s.n).toFixed(4)}）`);
    }
    for (const [id, s] of Object.entries(byWorker)) {
      if (s.n >= 2 && s.ok / s.n < 0.5) bullets.push(`${kind} 类任务别用 ${id}（${s.n} 次里只成功 ${s.ok} 次）`);
    }
  }
  return bullets;
}

export async function reviewRouting(ctx: { body: Body; store: Store; model?: ChatModel }): Promise<{ changed: boolean; versionId?: string; summary: string }> {
  const { body, store, model } = ctx;
  const current = body.routing();
  const stats = statsByKind(store.outcomes());
  const workers = body.workers();
  let bullets: string[] = [];
  let summary = '';
  if (model) {
    try {
      const res = await chatJson<{ learnedRules: string[]; summary: string; changed: boolean }>(
        model,
        [
          {
            role: 'system',
            content: `${PRINCIPLES}\n\nYou maintain the "learned rules" section of your own routing rules, from real outcomes. Prefer the cheapest worker that reliably succeeds for a kind of task; note workers that failed or got bad parent feedback. Each rule must cite its evidence (counts, success, avg cost). Never touch the parent's rules. Only propose a rule when there are at least 3 outcomes behind it.\nReturn JSON {"learnedRules": ["kind → worker（evidence）", ...], "changed": true|false, "summary": "1-2 sentences in the parent's language telling the parent what you changed and why"}.`,
          },
          { role: 'user', content: JSON.stringify({ currentRules: current, workers: workers.map((w) => ({ id: w.id, label: w.label, tier: w.tier })), stats }) },
        ],
        { tag: 'router.review', maxTokens: 800 },
      );
      bullets = res.learnedRules ?? [];
      summary = res.summary ?? '';
      if (!res.changed) return { changed: false, summary: summary || '这周的派活规则不用改。' };
    } catch (err) {
      logEvent('router.review.error', { error: String((err as Error).message) });
    }
  }
  if (!bullets.length) {
    bullets = learnedBulletsFromStats(stats, workers);
    summary ||= bullets.length ? `根据最近的结果，我更新了派活规则：${bullets.join('；')}` : '';
  }
  if (!bullets.length) return { changed: false, summary: '数据还不够，这周不改派活规则。' };
  const next = replaceLearnedSection(current, bullets);
  if (next.trim() === current.trim()) return { changed: false, summary: '派活规则没有变化。' };
  const versionId = body.saveRouting(next, summary);
  logEvent('router.routing.updated', { versionId, bullets });
  return { changed: true, versionId, summary };
}
