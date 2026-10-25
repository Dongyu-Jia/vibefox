import type { AgentConfig } from '../core/body.ts';
import { log } from '../core/log.ts';
import type { Store } from '../core/store.ts';
import type { Router } from '../router/router.ts';

/** The agent's daily rhythm: morning brief + journal, weekly routing review, hourly budget check. */
export class Heartbeat {
  private timer?: NodeJS.Timeout;
  private router: Router;
  private store: Store;
  private config: AgentConfig;
  private busy = false;

  constructor(router: Router, store: Store, config: AgentConfig) {
    this.router = router;
    this.store = store;
    this.config = config;
  }

  start(): void {
    if (!this.config.heartbeat.enabled) return;
    this.timer = setInterval(() => void this.tick(), this.config.heartbeat.tickSeconds * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now = new Date()): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const today = now.toLocaleDateString('sv');
      if (hhmm >= this.config.heartbeat.briefTime && this.store.get('last_brief_day') !== today) {
        this.store.set('last_brief_day', today);
        await this.router.sendBrief();
      }
      const lastReview = this.store.get('last_review_at');
      const daysSince = lastReview ? (now.getTime() - new Date(lastReview).getTime()) / 86_400_000 : Infinity;
      if (now.getDay() === this.config.heartbeat.weeklyReviewDay && hhmm >= this.config.heartbeat.weeklyReviewTime && daysSince > 6) {
        await this.router.weeklyReview();
      }
      const lastBudget = Number(this.store.get('last_budget_check') ?? 0);
      if (now.getTime() - lastBudget > 3600_000) {
        this.store.set('last_budget_check', String(now.getTime()));
        await this.router.checkBudget();
      }
    } catch (err) {
      log('heartbeat error', String((err as Error).stack ?? err));
    } finally {
      this.busy = false;
    }
  }
}
