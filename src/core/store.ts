import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

/** Task states follow A2A's lifecycle so other agents' vocabulary maps cleanly. */
export type TaskStatus = 'submitted' | 'working' | 'input-required' | 'completed' | 'failed' | 'canceled';

export interface Task {
  id: string;
  title: string;
  description: string;
  kind: string;
  risk: 'low' | 'high';
  status: TaskStatus;
  worker_id: string | null;
  requested_worker: string | null;
  origin_channel: string | null;
  origin_ref: string | null;
  status_ref: string | null;
  attempts: number;
  result: string | null;
  error: string | null;
  cost_usd: number;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface Run {
  id: string;
  task_id: string;
  worker_id: string;
  harness: string;
  model: string | null;
  pid: number | null;
  status: 'running' | 'reported' | 'exited' | 'failed' | 'stopped';
  session_id: string | null;
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
  cost_usd: number;
  exploration: number;
  transcript: string | null;
}

export interface Question {
  id: string;
  task_id: string;
  run_id: string;
  question: string;
  answer: string | null;
  answered_by: string | null;
  status: 'pending' | 'asked-parent' | 'answered';
  created_at: string;
  answered_at: string | null;
}

export interface Outcome {
  id: number;
  task_id: string;
  run_id: string;
  kind: string;
  worker_id: string;
  tier: number;
  success: number;
  feedback: string | null;
  cost_usd: number;
  duration_ms: number;
  exploration: number;
  created_at: string;
}

export interface SpendRow {
  id: string;
  task_id: string | null;
  merchant_name: string;
  merchant_url: string;
  amount_cents: number;
  currency: string;
  status: string;
  approval_url: string | null;
  test: number;
  context: string;
  last4: string | null;
  created_at: string;
  updated_at: string;
}

export interface InboxItem {
  id: string;
  source: 'email' | 'sms' | 'telegram' | 'call';
  external_id: string | null;
  thread_id: string | null;
  sender: string;
  recipient: string | null;
  subject: string | null;
  body: string;
  received_at: string;
  task_id: string | null;
  classification: 'task-related' | 'stranger' | 'parent' | 'code';
  surfaced: number;
  data: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks(
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'general', risk TEXT NOT NULL DEFAULT 'low', status TEXT NOT NULL,
  worker_id TEXT, requested_worker TEXT, origin_channel TEXT, origin_ref TEXT, status_ref TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, result TEXT, error TEXT, cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT);
CREATE TABLE IF NOT EXISTS task_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, at TEXT NOT NULL, type TEXT NOT NULL, data TEXT);
CREATE TABLE IF NOT EXISTS message_map(
  channel TEXT NOT NULL, ref TEXT NOT NULL, task_id TEXT, question_id TEXT, kind TEXT, PRIMARY KEY(channel, ref));
CREATE TABLE IF NOT EXISTS runs(
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, worker_id TEXT NOT NULL, harness TEXT NOT NULL, model TEXT,
  pid INTEGER, status TEXT NOT NULL, session_id TEXT, started_at TEXT NOT NULL, ended_at TEXT,
  exit_code INTEGER, cost_usd REAL NOT NULL DEFAULT 0, exploration INTEGER NOT NULL DEFAULT 0, transcript TEXT);
CREATE TABLE IF NOT EXISTS supplements(
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL, delivered_run TEXT);
CREATE TABLE IF NOT EXISTS questions(
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT NOT NULL, question TEXT NOT NULL, answer TEXT,
  answered_by TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, answered_at TEXT);
CREATE TABLE IF NOT EXISTS outcomes(
  id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, run_id TEXT NOT NULL, kind TEXT NOT NULL,
  worker_id TEXT NOT NULL, tier INTEGER NOT NULL, success INTEGER NOT NULL, feedback TEXT,
  cost_usd REAL NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, exploration INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS spend(
  id TEXT PRIMARY KEY, task_id TEXT, merchant_name TEXT NOT NULL, merchant_url TEXT NOT NULL,
  amount_cents INTEGER NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL, approval_url TEXT,
  test INTEGER NOT NULL DEFAULT 0, context TEXT NOT NULL, last4 TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS inbox(
  id TEXT PRIMARY KEY, source TEXT NOT NULL, external_id TEXT, thread_id TEXT, sender TEXT NOT NULL,
  recipient TEXT, subject TEXT, body TEXT NOT NULL, received_at TEXT NOT NULL, task_id TEXT,
  classification TEXT NOT NULL, surfaced INTEGER NOT NULL DEFAULT 0, data TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS inbox_external ON inbox(source, external_id);
CREATE TABLE IF NOT EXISTS threads(thread_id TEXT PRIMARY KEY, source TEXT NOT NULL, task_id TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS calls(
  id TEXT PRIMARY KEY, task_id TEXT, to_number TEXT NOT NULL, purpose TEXT NOT NULL, status TEXT NOT NULL,
  transcript TEXT, summary TEXT, created_at TEXT NOT NULL, ended_at TEXT);
CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const now = () => new Date().toISOString();

export function shortId(prefix: string): string {
  return prefix + crypto.randomBytes(5).toString('hex');
}

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ---------- kv ----------
  get(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key) as { value: string } | undefined;
    return row?.value;
  }
  set(key: string, value: string): void {
    this.db.prepare('INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  }
  del(key: string): void {
    this.db.prepare('DELETE FROM kv WHERE key=?').run(key);
  }

  // ---------- tasks ----------
  nextTaskId(): string {
    const n = Number(this.get('task_seq') ?? '0') + 1;
    this.set('task_seq', String(n));
    return `t${n}`;
  }

  createTask(t: Pick<Task, 'title' | 'description'> & Partial<Task>): Task {
    const id = t.id ?? this.nextTaskId();
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO tasks(id,title,description,kind,risk,status,worker_id,requested_worker,origin_channel,origin_ref,status_ref,attempts,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,0,?,?)`,
      )
      .run(id, t.title, t.description, t.kind ?? 'general', t.risk ?? 'low', t.status ?? 'submitted', t.worker_id ?? null, t.requested_worker ?? null, t.origin_channel ?? null, t.origin_ref ?? null, t.status_ref ?? null, ts, ts);
    this.addEvent(id, 'created', { title: t.title, description: t.description });
    return this.task(id)!;
  }

  task(id: string): Task | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE id=?').get(id) as Task | undefined;
  }

  updateTask(id: string, patch: Partial<Task>): Task {
    const keys = Object.keys(patch).filter((k) => k !== 'id');
    if (keys.length) {
      const sets = keys.map((k) => `${k}=?`).join(',');
      const vals = keys.map((k) => (patch as Record<string, unknown>)[k] as never);
      this.db.prepare(`UPDATE tasks SET ${sets}, updated_at=? WHERE id=?`).run(...vals, now(), id);
    }
    return this.task(id)!;
  }

  activeTasks(): Task[] {
    return this.db.prepare(`SELECT * FROM tasks WHERE status IN ('submitted','working','input-required') ORDER BY created_at`).all() as unknown as Task[];
  }

  recentTasks(limit = 20): Task[] {
    return this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?').all(limit) as unknown as Task[];
  }

  tasksSince(iso: string): Task[] {
    return this.db.prepare('SELECT * FROM tasks WHERE updated_at >= ? ORDER BY created_at').all(iso) as unknown as Task[];
  }

  addEvent(taskId: string, type: string, data: unknown = {}): void {
    this.db.prepare('INSERT INTO task_events(task_id,at,type,data) VALUES(?,?,?,?)').run(taskId, now(), type, JSON.stringify(data));
  }

  events(taskId: string): { at: string; type: string; data: Record<string, unknown> }[] {
    const rows = this.db.prepare('SELECT at,type,data FROM task_events WHERE task_id=? ORDER BY id').all(taskId) as { at: string; type: string; data: string }[];
    return rows.map((r) => ({ at: r.at, type: r.type, data: JSON.parse(r.data ?? '{}') }));
  }

  // ---------- message map (reply-to → task) ----------
  mapMessage(channel: string, ref: string, link: { taskId?: string; questionId?: string; kind: string }): void {
    this.db
      .prepare('INSERT INTO message_map(channel,ref,task_id,question_id,kind) VALUES(?,?,?,?,?) ON CONFLICT(channel,ref) DO UPDATE SET task_id=excluded.task_id, question_id=excluded.question_id, kind=excluded.kind')
      .run(channel, ref, link.taskId ?? null, link.questionId ?? null, link.kind);
  }

  lookupMessage(channel: string, ref: string): { task_id: string | null; question_id: string | null; kind: string } | undefined {
    return this.db.prepare('SELECT task_id,question_id,kind FROM message_map WHERE channel=? AND ref=?').get(channel, ref) as never;
  }

  // ---------- runs ----------
  createRun(r: Pick<Run, 'task_id' | 'worker_id' | 'harness'> & Partial<Run>): Run {
    const id = r.id ?? shortId('r_');
    this.db
      .prepare('INSERT INTO runs(id,task_id,worker_id,harness,model,status,started_at,exploration) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, r.task_id, r.worker_id, r.harness, r.model ?? null, 'running', now(), r.exploration ?? 0);
    return this.run(id)!;
  }
  run(id: string): Run | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as Run | undefined;
  }
  updateRun(id: string, patch: Partial<Run>): Run {
    const keys = Object.keys(patch).filter((k) => k !== 'id');
    if (keys.length) {
      this.db.prepare(`UPDATE runs SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`).run(...keys.map((k) => (patch as Record<string, unknown>)[k] as never), id);
    }
    return this.run(id)!;
  }
  runsForTask(taskId: string): Run[] {
    return this.db.prepare('SELECT * FROM runs WHERE task_id=? ORDER BY started_at').all(taskId) as unknown as Run[];
  }
  runningRuns(): Run[] {
    return this.db.prepare(`SELECT * FROM runs WHERE status='running'`).all() as unknown as Run[];
  }

  // ---------- supplements ----------
  addSupplement(taskId: string, text: string): void {
    this.db.prepare('INSERT INTO supplements(task_id,text,at) VALUES(?,?,?)').run(taskId, text, now());
    this.addEvent(taskId, 'supplement', { text });
  }
  takeSupplements(taskId: string, runId: string): string[] {
    const rows = this.db.prepare('SELECT id,text FROM supplements WHERE task_id=? AND delivered_run IS NULL ORDER BY id').all(taskId) as { id: number; text: string }[];
    for (const r of rows) this.db.prepare('UPDATE supplements SET delivered_run=? WHERE id=?').run(runId, r.id);
    return rows.map((r) => r.text);
  }
  allSupplements(taskId: string): string[] {
    return (this.db.prepare('SELECT text FROM supplements WHERE task_id=? ORDER BY id').all(taskId) as { text: string }[]).map((r) => r.text);
  }

  // ---------- questions ----------
  createQuestion(taskId: string, runId: string, question: string): Question {
    const id = shortId('q_');
    this.db.prepare('INSERT INTO questions(id,task_id,run_id,question,status,created_at) VALUES(?,?,?,?,?,?)').run(id, taskId, runId, question, 'pending', now());
    this.addEvent(taskId, 'question', { questionId: id, question });
    return this.question(id)!;
  }
  question(id: string): Question | undefined {
    return this.db.prepare('SELECT * FROM questions WHERE id=?').get(id) as Question | undefined;
  }
  updateQuestion(id: string, patch: Partial<Question>): Question {
    const keys = Object.keys(patch);
    this.db.prepare(`UPDATE questions SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`).run(...keys.map((k) => (patch as Record<string, unknown>)[k] as never), id);
    return this.question(id)!;
  }
  answerQuestion(id: string, answer: string, by: 'router' | 'parent'): Question {
    const q = this.updateQuestion(id, { answer, answered_by: by, status: 'answered', answered_at: now() });
    this.addEvent(q.task_id, 'answer', { questionId: id, answer, by });
    return q;
  }
  questionsAskedToParent(): Question[] {
    return this.db.prepare(`SELECT * FROM questions WHERE status='asked-parent' ORDER BY created_at`).all() as unknown as Question[];
  }

  // ---------- outcomes ----------
  addOutcome(o: Omit<Outcome, 'id' | 'created_at'>): void {
    this.db
      .prepare('INSERT INTO outcomes(task_id,run_id,kind,worker_id,tier,success,feedback,cost_usd,duration_ms,exploration,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(o.task_id, o.run_id, o.kind, o.worker_id, o.tier, o.success, o.feedback, o.cost_usd, o.duration_ms, o.exploration, now());
  }
  setOutcomeFeedback(runId: string, feedback: string, success?: number): void {
    if (success === undefined) this.db.prepare('UPDATE outcomes SET feedback=? WHERE run_id=?').run(feedback, runId);
    else this.db.prepare('UPDATE outcomes SET feedback=?, success=? WHERE run_id=?').run(feedback, success, runId);
  }
  outcomes(sinceIso?: string): Outcome[] {
    if (sinceIso) return this.db.prepare('SELECT * FROM outcomes WHERE created_at >= ? ORDER BY id').all(sinceIso) as unknown as Outcome[];
    return this.db.prepare('SELECT * FROM outcomes ORDER BY id').all() as unknown as Outcome[];
  }

  // ---------- money ----------
  addSpend(s: Omit<SpendRow, 'created_at' | 'updated_at'>): void {
    const ts = now();
    this.db
      .prepare('INSERT INTO spend(id,task_id,merchant_name,merchant_url,amount_cents,currency,status,approval_url,test,context,last4,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(s.id, s.task_id, s.merchant_name, s.merchant_url, s.amount_cents, s.currency, s.status, s.approval_url, s.test, s.context, s.last4, ts, ts);
  }
  updateSpend(id: string, patch: Partial<SpendRow>): void {
    const keys = Object.keys(patch);
    this.db.prepare(`UPDATE spend SET ${keys.map((k) => `${k}=?`).join(',')}, updated_at=? WHERE id=?`).run(...keys.map((k) => (patch as Record<string, unknown>)[k] as never), now(), id);
  }
  spendRows(): SpendRow[] {
    return this.db.prepare('SELECT * FROM spend ORDER BY created_at').all() as unknown as SpendRow[];
  }
  /** Money committed this calendar month (approved or still pending), excluding test mode. */
  spentThisMonthCents(nowDate = new Date()): number {
    const monthStart = new Date(Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), 1)).toISOString();
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(amount_cents),0) AS s FROM spend WHERE test=0 AND created_at >= ? AND status IN ('approved','pending_approval','created','succeeded','submitted')`)
      .get(monthStart) as { s: number };
    return row.s;
  }

  // ---------- inbox / threads / calls ----------
  addInbox(item: Omit<InboxItem, 'id' | 'surfaced'> & { id?: string }): InboxItem | undefined {
    const id = item.id ?? shortId('m_');
    const r = this.db
      .prepare('INSERT OR IGNORE INTO inbox(id,source,external_id,thread_id,sender,recipient,subject,body,received_at,task_id,classification,data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, item.source, item.external_id, item.thread_id, item.sender, item.recipient, item.subject, item.body, item.received_at, item.task_id, item.classification, item.data);
    if (Number(r.changes) === 0) return undefined;
    return this.db.prepare('SELECT * FROM inbox WHERE id=?').get(id) as unknown as InboxItem;
  }
  unsurfacedInbox(): InboxItem[] {
    return this.db.prepare(`SELECT * FROM inbox WHERE surfaced=0 AND classification='stranger' ORDER BY received_at`).all() as unknown as InboxItem[];
  }
  markSurfaced(ids: string[]): void {
    for (const id of ids) this.db.prepare('UPDATE inbox SET surfaced=1 WHERE id=?').run(id);
  }
  inboxItems(limit = 50): InboxItem[] {
    return this.db.prepare('SELECT * FROM inbox ORDER BY received_at DESC LIMIT ?').all(limit) as unknown as InboxItem[];
  }
  linkThread(threadId: string, source: string, taskId: string | null): void {
    this.db.prepare('INSERT OR REPLACE INTO threads(thread_id,source,task_id,created_at) VALUES(?,?,?,?)').run(threadId, source, taskId, now());
  }
  threadTask(threadId: string): string | null | undefined {
    const row = this.db.prepare('SELECT task_id FROM threads WHERE thread_id=?').get(threadId) as { task_id: string | null } | undefined;
    return row ? row.task_id : undefined;
  }
  addCall(c: { id: string; task_id: string | null; to_number: string; purpose: string; status: string }): void {
    this.db.prepare('INSERT OR REPLACE INTO calls(id,task_id,to_number,purpose,status,created_at) VALUES(?,?,?,?,?,?)').run(c.id, c.task_id, c.to_number, c.purpose, c.status, now());
  }
  call(id: string): { id: string; task_id: string | null; to_number: string; purpose: string; status: string; transcript: string | null; summary: string | null } | undefined {
    return this.db.prepare('SELECT * FROM calls WHERE id=?').get(id) as never;
  }
  updateCall(id: string, patch: Record<string, unknown>): void {
    const keys = Object.keys(patch);
    this.db.prepare(`UPDATE calls SET ${keys.map((k) => `${k}=?`).join(',')} WHERE id=?`).run(...keys.map((k) => patch[k] as never), id);
  }
}
