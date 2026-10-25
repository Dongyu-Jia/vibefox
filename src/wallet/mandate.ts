import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Body, Mandate } from '../core/body.ts';
import { sign, verify } from '../identity/selfmade.ts';

/** Categories a parent can forbid forever. These are the classic scam cash-out routes. */
export const CATEGORY_PATTERNS: Record<string, RegExp> = {
  gift_cards: /gift\s?-?cards?|giftcard|礼品卡|充值卡|steam\s?card|itunes\s?card/i,
  money_transfer: /\b(wire|remit|money\s?transfer|western\s?union|moneygram|zelle|venmo|paypal\.me|cash\s?app)\b|转账|汇款/i,
  crypto: /\b(crypto|bitcoin|btc|ethereum|usdt|usdc|coinbase|binance|kraken)\b|加密货币|比特币/i,
  gambling: /\b(casino|betting|gambl\w*|lottery|poker|sportsbook)\b|赌|彩票/i,
};

/** Forbidden in every mandate; the parent cannot switch these on. */
export const BLOCKED_CATEGORIES = ['gift_cards', 'money_transfer', 'crypto', 'gambling'] as const;

/** What a parent can allow, in the order the wizard and the UI ask. */
export const SPEND_CATEGORIES = ['compute', 'software', 'food', 'shopping', 'travel'] as const;

export const CATEGORY_LABELS: Record<string, string> = {
  gift_cards: '礼品卡',
  money_transfer: '转账汇款',
  crypto: '加密货币',
  gambling: '赌博',
  software: '软件和订阅',
  compute: '自己的 token 和服务费',
  food: '外卖和日用品',
  travel: '机票酒店',
  shopping: '网购',
};

export interface SpendRequestInput {
  amountCents: number;
  merchantName: string;
  merchantUrl: string;
  context: string;
}

export interface SpendCheck {
  ok: boolean;
  reason?: string;
  remainingCents: number;
}

export function checkSpend(m: Mandate | undefined, req: SpendRequestInput, spentThisMonthCents: number, frozen: boolean): SpendCheck {
  if (!m) return { ok: false, reason: '还没有授权书：家长需要先在 onboarding 里设定零花钱。', remainingCents: 0 };
  const remaining = Math.max(0, m.monthlyLimitCents - spentThisMonthCents);
  if (frozen) return { ok: false, reason: '家长冻结了我的花钱权限（/unfreeze 解冻）。', remainingCents: remaining };
  if (!Number.isInteger(req.amountCents) || req.amountCents <= 0) return { ok: false, reason: '金额必须是正整数（单位：分）。', remainingCents: remaining };
  if (req.amountCents > m.perTransactionLimitCents) {
    return { ok: false, reason: `超过单笔上限 ${fmtCents(m.perTransactionLimitCents, m.currency)}。`, remainingCents: remaining };
  }
  if (req.amountCents > remaining) {
    return { ok: false, reason: `超过本月额度：本月已花 ${fmtCents(spentThisMonthCents, m.currency)}，还剩 ${fmtCents(remaining, m.currency)}。`, remainingCents: remaining };
  }
  const haystack = `${req.merchantName} ${req.merchantUrl} ${req.context}`;
  for (const cat of m.blockedCategories) {
    const re = CATEGORY_PATTERNS[cat];
    if (re?.test(haystack)) return { ok: false, reason: `授权书永远不允许买${CATEGORY_LABELS[cat] ?? cat}。`, remainingCents: remaining };
  }
  return { ok: true, remainingCents: remaining - req.amountCents };
}

export function fmtCents(cents: number, currency = 'usd'): string {
  const sym = currency.toLowerCase() === 'usd' ? '$' : currency.toUpperCase() + ' ';
  return `${sym}${(cents / 100).toFixed(2)}`;
}

function canonical(m: Mandate): string {
  const { hash: _h, agentSignature: _s, ...rest } = m;
  return JSON.stringify(rest, Object.keys(rest).sort());
}

export function createMandate(body: Body, input: {
  monthlyLimitCents: number;
  perTransactionLimitCents: number;
  allowedCategories: string[];
  blockedCategories: string[];
  parentName: string;
  currency?: string;
  revision?: number;
  previousHash?: string;
}): Mandate {
  const name = body.identity().name;
  const m: Mandate = {
    version: 1,
    currency: input.currency ?? 'usd',
    monthlyLimitCents: input.monthlyLimitCents,
    perTransactionLimitCents: input.perTransactionLimitCents,
    allowedCategories: input.allowedCategories,
    blockedCategories: input.blockedCategories,
    rules: { tasksOnlyFromParent: true, discloseAI: true, notifyAfterSpend: true },
    parentStatement: `我授权 ${name} 每月最多花 ${fmtCents(input.monthlyLimitCents, input.currency)}，单笔不超过 ${fmtCents(input.perTransactionLimitCents, input.currency)}。这个数字是我愿意让它搞砸的最大金额。`,
    signedAt: new Date().toISOString(),
    signedBy: input.parentName,
  };
  // Only set when given: a mandate without these keys hashes exactly like the ones signed before revisions existed.
  if (input.revision != null) m.revision = input.revision;
  if (input.previousHash) m.previousHash = input.previousHash;
  m.hash = crypto.createHash('sha256').update(canonical(m)).digest('hex');
  m.agentSignature = sign(body, m.hash);
  return m;
}

export function mandateIntact(m: Mandate): boolean {
  return m.hash === crypto.createHash('sha256').update(canonical(m)).digest('hex');
}

/** Hash intact and signed by this agent's own key. */
export function mandateSigned(body: Body, m: Mandate): boolean {
  if (!mandateIntact(m) || !m.hash || !m.agentSignature) return false;
  try {
    return verify(body, m.hash, m.agentSignature);
  } catch {
    return false;
  }
}

export function mandateRevision(m: Mandate): number {
  return m.revision ?? 1;
}

/** Every mandate the parent signed before the current one: `<body>/mandate-history/<revision>.json`. */
export function mandateHistoryDir(body: Body): string {
  return path.join(body.root, 'mandate-history');
}

export function archiveMandate(body: Body, m: Mandate): string {
  const dir = mandateHistoryDir(body);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${mandateRevision(m)}.json`);
  fs.writeFileSync(file, JSON.stringify(m, null, 2) + '\n');
  return file;
}

/** Oldest first. */
export function mandateHistory(body: Body): Mandate[] {
  const dir = mandateHistoryDir(body);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d+\.json$/.test(f))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Mandate)
    .sort((a, b) => mandateRevision(a) - mandateRevision(b));
}
