import fs from 'node:fs';
import path from 'node:path';
import { loggedFetch, log, unlessEmpty } from '../core/log.ts';
import { chunkText } from './format.ts';
import type { Address, Attachment, Channel, ChannelCapabilities, InboundMessage, MessageRef, OutboundMessage } from './types.ts';

interface TgUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}
interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
}
interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  caption?: string;
  reply_to_message?: TgMessage;
  document?: { file_id: string; file_name?: string; mime_type?: string };
  photo?: { file_id: string; width: number }[];
  voice?: { file_id: string; mime_type?: string };
}
interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: { id: string; from: TgUser; message?: TgMessage; data?: string };
}

export class TelegramError extends Error {
  code: number;
  constructor(code: number, description: string) {
    super(`Telegram ${code}: ${description}`);
    this.code = code;
  }
}

export interface TelegramOptions {
  token: string;
  apiBase?: string;
  pollTimeoutSec?: number;
  loadOffset?: () => number;
  saveOffset?: (offset: number) => void;
}

export class TelegramChannel implements Channel {
  readonly id = 'telegram';
  readonly capabilities: ChannelCapabilities = { replyTo: true, buttons: true, edit: true, files: true, voice: true, maxTextLength: 4096 };
  private token: string;
  private apiBase: string;
  private pollTimeout: number;
  private loadOffset: () => number;
  private saveOffset: (n: number) => void;
  private abort?: AbortController;
  private running = false;
  private lastEdit = new Map<string, string>();
  private loop?: Promise<void>;

  constructor(opts: TelegramOptions) {
    this.token = opts.token;
    this.apiBase = (opts.apiBase ?? 'https://api.telegram.org').replace(/\/$/, '');
    this.pollTimeout = opts.pollTimeoutSec ?? 25;
    let mem = 0;
    this.loadOffset = opts.loadOffset ?? (() => mem);
    this.saveOffset = opts.saveOffset ?? ((n) => (mem = n));
  }

  async call<T>(method: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const isPoll = method === 'getUpdates';
    const res = await loggedFetch(
      'telegram',
      `${this.apiBase}/bot${this.token}/${method}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal },
      { logIf: isPoll ? unlessEmpty('result') : undefined },
    );
    const json = (await res.json()) as { ok: boolean; result: T; description?: string; error_code?: number };
    if (!json.ok) throw new TelegramError(json.error_code ?? res.status, json.description ?? 'unknown error');
    return json.result;
  }

  async describe(): Promise<{ handle: string; displayName: string; id: string }> {
    const me = await this.call<TgUser>('getMe');
    return { handle: '@' + (me.username ?? me.first_name), displayName: me.first_name, id: String(me.id) };
  }

  async start(handler: (msg: InboundMessage) => Promise<void>): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    this.loop = this.pollLoop(handler);
  }

  private async pollLoop(handler: (msg: InboundMessage) => Promise<void>): Promise<void> {
    let backoff = 1000;
    while (this.running) {
      try {
        const updates = await this.call<TgUpdate[]>(
          'getUpdates',
          { offset: this.loadOffset(), timeout: this.pollTimeout, allowed_updates: ['message', 'callback_query'] },
          this.abort?.signal,
        );
        backoff = 1000;
        for (const u of updates) {
          this.saveOffset(u.update_id + 1);
          const msg = this.convert(u);
          if (!msg) continue;
          try {
            await handler(msg);
          } catch (err) {
            log('telegram handler error', String((err as Error).stack ?? err));
          }
        }
      } catch (err) {
        if (!this.running) break;
        log('telegram poll error', String((err as Error).message ?? err));
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    await this.loop?.catch(() => {});
  }

  private convert(u: TgUpdate): InboundMessage | undefined {
    if (u.callback_query) {
      const cq = u.callback_query;
      const m = cq.message;
      return {
        channel: this.id,
        id: `cb:${cq.id}`,
        chatId: String(m?.chat.id ?? cq.from.id),
        isPrivateChat: (m?.chat.type ?? 'private') === 'private',
        sender: { id: String(cq.from.id), displayName: name(cq.from), username: cq.from.username },
        text: '',
        buttonPayload: cq.data,
        buttonMessage: m ? { channel: this.id, chatId: String(m.chat.id), messageId: String(m.message_id) } : undefined,
        callbackId: cq.id,
        attachments: [],
        at: new Date(),
      };
    }
    const m = u.message;
    if (!m || !m.from) return undefined;
    const attachments: Attachment[] = [];
    if (m.document) attachments.push({ kind: 'document', fileId: m.document.file_id, name: m.document.file_name, mime: m.document.mime_type });
    if (m.photo?.length) attachments.push({ kind: 'photo', fileId: m.photo[m.photo.length - 1].file_id });
    if (m.voice) attachments.push({ kind: 'voice', fileId: m.voice.file_id, mime: m.voice.mime_type });
    return {
      channel: this.id,
      id: String(m.message_id),
      chatId: String(m.chat.id),
      isPrivateChat: m.chat.type === 'private',
      sender: { id: String(m.from.id), displayName: name(m.from), username: m.from.username },
      text: m.text ?? m.caption ?? '',
      replyTo: m.reply_to_message ? { channel: this.id, chatId: String(m.chat.id), messageId: String(m.reply_to_message.message_id) } : undefined,
      attachments,
      at: new Date(m.date * 1000),
    };
  }

  private markup(msg: OutboundMessage): Record<string, unknown> | undefined {
    if (!msg.buttons?.length) return undefined;
    return { inline_keyboard: msg.buttons.map((row) => row.map((btn) => ({ text: btn.label, callback_data: btn.payload.slice(0, 64) }))) };
  }

  async send(to: Address, msg: OutboundMessage): Promise<MessageRef> {
    const chunks = chunkText(msg.text || ' ', this.capabilities.maxTextLength);
    let last: TgMessage | undefined;
    for (let idx = 0; idx < chunks.length; idx++) {
      const isLast = idx === chunks.length - 1;
      const body: Record<string, unknown> = {
        chat_id: to.chatId,
        text: chunks[idx],
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      };
      if (idx === 0 && msg.replyTo) body.reply_parameters = { message_id: Number(msg.replyTo.messageId), allow_sending_without_reply: true };
      if (isLast) {
        const rm = this.markup(msg);
        if (rm) body.reply_markup = rm;
      }
      try {
        last = await this.call<TgMessage>('sendMessage', body);
      } catch (err) {
        // Malformed markup from a model should not lose the message: retry as plain text.
        if (err instanceof TelegramError && err.code === 400 && /parse entities/i.test(err.message)) {
          delete body.parse_mode;
          body.text = String(body.text).replace(/<[^>]+>/g, '');
          last = await this.call<TgMessage>('sendMessage', body);
        } else throw err;
      }
    }
    for (const f of msg.files ?? []) {
      if (!f.path) continue;
      const form = new FormData();
      form.set('chat_id', to.chatId);
      form.set('document', new Blob([fs.readFileSync(f.path)]), f.name ?? path.basename(f.path));
      const res = await loggedFetch('telegram', `${this.apiBase}/bot${this.token}/sendDocument`, { method: 'POST', body: form });
      const json = (await res.json()) as { ok: boolean; result: TgMessage };
      if (json.ok) last = json.result;
    }
    return { channel: this.id, chatId: to.chatId, messageId: String(last?.message_id ?? 0) };
  }

  async edit(ref: MessageRef, msg: OutboundMessage): Promise<void> {
    const body: Record<string, unknown> = {
      chat_id: ref.chatId,
      message_id: Number(ref.messageId),
      text: chunkText(msg.text || ' ', this.capabilities.maxTextLength)[0],
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    };
    const rm = this.markup(msg);
    body.reply_markup = rm ?? { inline_keyboard: [] };
    // Telegram answers 400 "message is not modified" to an identical edit; don't send one.
    const key = `${ref.chatId}:${ref.messageId}`;
    const sig = JSON.stringify([body.text, body.reply_markup]);
    if (this.lastEdit.get(key) === sig) return;
    try {
      await this.call('editMessageText', body);
    } catch (err) {
      if (!(err instanceof TelegramError && /not modified/i.test(err.message))) throw err;
    }
    this.lastEdit.delete(key);
    this.lastEdit.set(key, sig);
    if (this.lastEdit.size > 200) this.lastEdit.delete(this.lastEdit.keys().next().value!);
  }

  async acknowledge(msg: InboundMessage, toast?: string): Promise<void> {
    if (!msg.callbackId) return;
    await this.call('answerCallbackQuery', { callback_query_id: msg.callbackId, text: toast }).catch(() => {});
  }

  async typing(to: Address): Promise<void> {
    await this.call('sendChatAction', { chat_id: to.chatId, action: 'typing' }).catch(() => {});
  }

  async downloadAttachment(a: Attachment, dir: string): Promise<string> {
    const file = await this.call<{ file_path: string }>('getFile', { file_id: a.fileId });
    const res = await fetch(`${this.apiBase}/file/bot${this.token}/${file.file_path}`);
    const out = path.join(dir, a.name ?? path.basename(file.file_path));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
    return out;
  }

  /** Make the bot look like the agent: name, description, command menu. */
  async presentAs(agentName: string, description: string): Promise<void> {
    await this.call('setMyCommands', {
      commands: [
        { command: 'tasks', description: '看看我手上的任务' },
        { command: 'status', description: '我的状态、身份和预算' },
        { command: 'identity', description: '我的身份清单' },
        { command: 'routing', description: '我的派活规则' },
        { command: 'brief', description: '现在发一份简报' },
        { command: 'cancel', description: '取消一个任务：/cancel t3' },
        { command: 'freeze', description: '冻结：停止花钱和对外联系' },
        { command: 'unfreeze', description: '解冻' },
      ],
    }).catch(() => {});
    await this.call('setMyDescription', { description }).catch(() => {});
    await this.call('setMyShortDescription', { short_description: `${agentName}，一个独立的 AI agent` }).catch(() => {});
  }
}

function name(u: TgUser): string {
  return [u.first_name, u.last_name].filter(Boolean).join(' ');
}
