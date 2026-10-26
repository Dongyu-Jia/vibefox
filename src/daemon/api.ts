import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { BrowserService } from '../browser/service.ts';
import { shareableIdentity, type Body } from '../core/body.ts';
import { logEvent } from '../core/log.ts';
import { shortId, type Store } from '../core/store.ts';
import { IDENTITY_KINDS, OPENER_LABEL } from '../identity/registry.ts';
import { openSelfIdentities } from '../identity/selfmade.ts';
import { errorStatus } from '../control/errors.ts';
import { gate, HttpError, readJson, sameToken, bearer, sendJson, serveUi } from '../control/http.ts';
import { identityViews, resourceView } from '../control/routes.ts';
import { resourceKind } from '../resources/catalog.ts';
import type { Resources } from '../resources/store.ts';
import type { Router } from '../router/router.ts';
import type { Services } from './services.ts';

/**
 * Local control API (127.0.0.1 only, bearer token). `vf` subcommands, the MCP
 * server and builtin workers all call this, so they share one browser, one
 * inbox, one phone and one wallet.
 */

export interface ApiDeps {
  body: Body;
  store: Store;
  router: Router;
  services: Services;
  browser: BrowserService;
  token: string;
  resources: Resources;
  /** `/v1/control/*` and its own parent-session auth (see src/control/routes.ts). */
  control?: (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => Promise<boolean>;
}

interface Op {
  status: 'running' | 'done' | 'error';
  result?: unknown;
  error?: string;
  note?: string;
  waiters: (() => void)[];
}

export function createApi(deps: ApiDeps): http.Server {
  const ops = new Map<string, Op>();

  const startOp = (fn: (note: (s: string) => void) => Promise<unknown>): { opId: string } => {
    const opId = shortId('op_');
    const op: Op = { status: 'running', waiters: [] };
    ops.set(opId, op);
    const wake = () => op.waiters.splice(0).forEach((w) => w());
    fn((s) => {
      op.note = s;
      wake();
    })
      .then((r) => {
        op.status = 'done';
        op.result = r;
      })
      .catch((e: Error) => {
        op.status = 'error';
        op.error = e.message;
      })
      .finally(wake);
    return { opId };
  };

  const waitOp = async (id: string, waitSec: number) => {
    const op = ops.get(id);
    if (!op) throw new HttpError(404, 'unknown op');
    if (op.status === 'running') {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, waitSec * 1000);
        op.waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    const out = { status: op.status, result: op.result, error: op.error, note: op.note };
    op.note = undefined;
    return out;
  };

  const waitQuestion = async (id: string, waitSec: number) => {
    const deadline = Date.now() + waitSec * 1000;
    for (;;) {
      const q = deps.store.question(id);
      if (!q) throw new HttpError(404, 'unknown question');
      if (q.status === 'answered' || Date.now() > deadline) return { status: q.status, answer: q.answer };
      await new Promise((r) => setTimeout(r, 400));
    }
  };

  const runOf = (id: string) => {
    const run = deps.store.run(id);
    if (!run) throw new HttpError(404, 'unknown run');
    return run;
  };

  const identitySummary = () => {
    const id = deps.body.identity();
    const lines = [`${id.name} — independent AI agent; parent: ${id.parent.name}`];
    for (const k of IDENTITY_KINDS) {
      const r = id.identities[k.id];
      lines.push(`${r?.status === 'open' ? '[open]' : r?.status === 'needs-parent' ? '[needs parent]' : '[ ]'} ${k.id} (${OPENER_LABEL[k.opener]})${r?.value ? ': ' + r.value : ''}`);
    }
    return { text: lines.join('\n'), identities: id.identities };
  };

  async function route(method: string, url: URL, body: Record<string, unknown>): Promise<unknown> {
    const p = url.pathname;
    const seg = p.split('/').filter(Boolean); // ['v1', ...]
    const { store, router, services, browser } = deps;
    const wait = Math.min(Number(url.searchParams.get('wait') ?? 0), 55);

    if (p === '/v1/health') return { ok: true };
    if (p === '/v1/status') return { text: await router.statusSummary(), tasks: store.activeTasks() };
    if (p === '/v1/identity') return shareableIdentity(deps.body.identity());
    if (p === '/v1/identity/summary') return identitySummary();
    if (p === '/v1/identity/open' && method === 'POST') return { opened: openSelfIdentities(deps.body) };
    if (p === '/v1/mandate') return { mandate: deps.body.mandate(), spentThisMonthCents: store.spentThisMonthCents() };
    if (p === '/v1/tasks') return { active: store.activeTasks(), recent: store.recentTasks(20) };
    if (seg[1] === 'tasks' && seg[2]) return { task: store.task(seg[2]), events: store.events(seg[2]), runs: store.runsForTask(seg[2]) };

    // ---- worker ↔ router ----
    if (seg[1] === 'runs' && seg[2]) {
      const run = runOf(seg[2]);
      const action = seg[3];
      if (action === 'context') {
        const ws = path.join(deps.body.paths.workspace, run.task_id);
        return { systemPrompt: fs.readFileSync(path.join(ws, 'AGENTS.md'), 'utf8'), prompt: fs.readFileSync(path.join(ws, 'TASK.md'), 'utf8'), workspace: ws };
      }
      if (action === 'progress') {
        router.onProgress(run.id, String(body.text ?? ''));
        return { ok: true };
      }
      if (action === 'ask') {
        const q = await router.onAsk(run.id, String(body.question ?? ''));
        return { questionId: q.id, status: q.status, answer: q.answer };
      }
      if (action === 'report') {
        await router.onReport(run.id, { status: body.status === 'failed' ? 'failed' : 'done', summary: String(body.summary ?? ''), costUsd: body.costUsd == null ? undefined : Number(body.costUsd) });
        return { ok: true };
      }
      if (action === 'supplements') return { supplements: store.takeSupplements(run.task_id, run.id) };
    }
    // ---- the agent's resources (secrets only on explicit request, always audited) ----
    if (p === '/v1/resources' && method === 'GET') return { resources: [...identityViews(deps.body), ...deps.resources.list().map((r) => resourceView(deps.resources, r))] };
    if (p === '/v1/resources/request' && method === 'POST') {
      const kind = resourceKind(String(body.kind ?? ''));
      const why = String(body.why ?? '').slice(0, 600);
      logEvent('resource.requested', { kind: body.kind, why, taskId: body.taskId });
      await router.notifyParent(`🧩 我需要一个资源：<b>${kind?.label ?? String(body.kind)}</b>${why ? '\n' + why.replace(/[<>&]/g, '') : ''}\n\n在 Mac 上运行 <code>vf ui resources/add/${kind?.id ?? 'custom'}</code> 就能直接交给我。`);
      return { ok: true };
    }
    if (p === '/v1/resources' && method === 'POST') {
      const kind = resourceKind(String(body.kind ?? ''));
      if (!kind) throw new HttpError(400, 'unknown resource kind; see vf resources --catalog');
      // Workers may only append what they built themselves: never replace or edit an existing resource.
      if (body.id && deps.resources.get(String(body.id))) throw new HttpError(409, `${String(body.id)} already exists; resources are read-only for workers`);
      const r = deps.resources.add({
        kind: kind.id,
        id: body.id ? String(body.id) : undefined,
        label: body.label ? String(body.label) : undefined,
        handle: body.handle ? String(body.handle) : undefined,
        parent: body.parent ? String(body.parent) : undefined,
        note: body.note ? String(body.note) : undefined,
        method: body.fields ? kind.methods[0] : 'none',
        fields: body.fields && typeof body.fields === 'object' ? (body.fields as Record<string, string>) : {},
        access: 'full',
        origin: 'self',
        addedBy: 'agent',
        status: 'unverified',
      });
      logEvent('resource.self-added', { id: r.id, kind: kind.id, parent: r.parent, taskId: body.taskId });
      deps.body.appendJournal(`- 我自己加了一个资源：${r.label}${r.handle ? ' ' + r.handle : ''}${r.parent ? `（建在 ${r.parent} 上）` : ''}`);
      await router.notifyParent(`🧩 我自己加了一个资源：<b>${r.label.replace(/[<>&]/g, '')}</b>${r.handle ? ' ' + r.handle.replace(/[<>&]/g, '') : ''}${r.parent ? `（建在 ${r.parent} 上）` : ''}`);
      return { resource: resourceView(deps.resources, r) };
    }
    if (seg[1] === 'resources' && seg[2] && method === 'POST') {
      const id = decodeURIComponent(seg[2]);
      const r = deps.resources.get(id);
      if (!r) throw new HttpError(404, `no resource ${id}`);
      if (seg[3] === 'secret') {
        const field = String(body.field ?? r.secretFields[0] ?? '');
        const value = deps.resources.secret(id, field);
        logEvent('resource.secret.read', { id, field, found: Boolean(value), runId: body.runId, taskId: body.taskId });
        if (!value) throw new HttpError(404, `${id} has no ${field}`);
        return { value };
      }
      if (seg[3] === 'otp') {
        const code = deps.resources.otp(id);
        logEvent('resource.otp.read', { id, found: Boolean(code), runId: body.runId });
        if (!code) throw new HttpError(404, `${id} has no two-step key`);
        return { code };
      }
    }
    if (p === '/v1/parent/legal') {
      logEvent('parent.legal.read', { runId: body.runId, taskId: body.taskId });
      return { legal: deps.body.identity().parent.legal ?? null };
    }

    if (seg[1] === 'questions' && seg[2]) return waitQuestion(seg[2], wait);
    if (seg[1] === 'ops' && seg[2]) return waitOp(seg[2], wait);

    // ---- browser ----
    if (seg[1] === 'browser') {
      const action = seg[2];
      if (action === 'open') return { snapshot: await browser.open(String(body.url)) };
      if (action === 'snapshot') return { snapshot: await browser.snapshot() };
      if (action === 'click') return { snapshot: await browser.click(String(body.ref)) };
      if (action === 'type') return { snapshot: await browser.type(String(body.ref), String(body.text ?? ''), Boolean(body.submit)) };
      if (action === 'select') return { snapshot: await browser.select(String(body.ref), String(body.value)) };
      if (action === 'press') return { snapshot: await browser.press(String(body.key)) };
      if (action === 'back') return { snapshot: await browser.back() };
      if (action === 'wait') return { snapshot: await browser.wait(body.text ? String(body.text) : undefined, body.seconds == null ? undefined : Number(body.seconds)) };
      if (action === 'screenshot') {
        // A relative path is the worker's: resolve it in its task workspace, not the daemon's cwd.
        const run = body.runId ? deps.store.run(String(body.runId)) : undefined;
        const base = run ? path.join(deps.body.paths.workspace, run.task_id) : deps.body.paths.recordings;
        const file = body.path ? path.resolve(base, String(body.path)) : path.join(deps.body.paths.recordings, `shot-${Date.now()}.png`);
        return { path: await browser.screenshot(file) };
      }
      if (action === 'close') return { recordings: await browser.close() };
    }

    // ---- identities as services ----
    if (p === '/v1/mail/send') return services.sendMail({ to: String(body.to), subject: String(body.subject ?? ''), text: String(body.text ?? ''), taskId: body.taskId as string | undefined });
    if (p === '/v1/mail/reply') return services.replyMail({ messageId: String(body.messageId), text: String(body.text ?? ''), taskId: body.taskId as string | undefined });
    if (p === '/v1/mail/messages') return services.listMail(Number(url.searchParams.get('limit') ?? 10));
    if (seg[1] === 'mail' && seg[2] === 'messages' && seg[3]) return services.readMail(decodeURIComponent(seg.slice(3).join('/')));
    if (p === '/v1/sms/send') return services.sendSms({ to: String(body.to), text: String(body.text ?? ''), taskId: body.taskId as string | undefined });
    if (p === '/v1/sms/messages') return services.listSms();
    if (p === '/v1/codes') return services.codes();
    if (p === '/v1/calls' && method === 'POST') return startOp((note) => services.placeCall({ to: String(body.to), purpose: String(body.purpose ?? ''), taskId: body.taskId as string | undefined }, note));
    if (seg[1] === 'calls' && seg[2]) return store.call(seg[2]);
    if (p === '/v1/pay' && method === 'POST') {
      return startOp((note) =>
        services.pay(
          {
            merchantName: String(body.merchantName),
            merchantUrl: String(body.merchantUrl),
            amountCents: Number(body.amountCents),
            context: String(body.context ?? ''),
            test: Boolean(body.test),
            taskId: body.taskId as string | undefined,
            waitSeconds: body.waitSeconds == null ? undefined : Number(body.waitSeconds),
          },
          note,
        ),
      );
    }
    if (p === '/v1/spend') return { rows: store.spendRows(), spentThisMonthCents: store.spentThisMonthCents() };
    if (p === '/v1/memory' && method === 'POST') {
      deps.body.remember(String(body.fact ?? ''));
      return { ok: true };
    }
    if (p === '/v1/journal' && method === 'POST') {
      deps.body.appendJournal(String(body.text ?? ''));
      return { ok: true };
    }

    // ---- heartbeat triggers (CLI + tests) ----
    if (p === '/v1/admin/brief') {
      await router.sendBrief(true);
      return { ok: true };
    }
    if (p === '/v1/admin/review') {
      await router.weeklyReview(true);
      return { ok: true, routing: deps.body.routing() };
    }
    if (p === '/v1/admin/budget') {
      await router.checkBudget();
      return { ok: true, mode: store.get('budget_mode') ?? 'normal' };
    }
    if (p === '/v1/admin/browser-record') {
      browser.setRecording(Boolean(body.record));
      return { ok: true };
    }
    if (p === '/v1/admin/poll') {
      await services.pollSms().catch(() => {});
      return { ok: true };
    }
    throw new HttpError(404, `no route ${method} ${p}`);
  }

  return http.createServer(async (req, res) => {
    if (!gate(req, res)) return;
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const send = (status: number, data: unknown) => sendJson(res, status, data);
    if (serveUi(req, res, url.pathname)) return;
    if (url.pathname === '/v1/whoami') {
      const id = deps.body.identity();
      return send(200, { mode: 'control', agent: { name: id.name, slug: id.slug } });
    }
    if (deps.control && (await deps.control(req, res, url))) return;
    if (url.pathname !== '/v1/health' && !sameToken(bearer(req), deps.token)) return send(401, { error: 'unauthorized' });
    try {
      const body = await readJson(req);
      const out = await route(req.method ?? 'GET', url, body);
      send(200, out);
    } catch (err) {
      const status = errorStatus(err);
      logEvent('api.error', { path: url.pathname, status, error: String((err as Error).message) });
      send(status, { error: (err as Error).message });
    }
  });
}
