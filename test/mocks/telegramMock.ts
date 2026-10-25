import http from 'node:http';

/**
 * A local stand-in for the Telegram Bot API (the subset vibefox uses), plus a
 * tiny web UI at /ui that renders the chat like a messenger — the demo videos
 * are recorded against it. Tests drive the "parent" through the same helpers.
 */

export interface TgMsg {
  message_id: number;
  chat_id: number;
  from: 'parent' | 'bot' | 'stranger';
  text: string;
  reply_to?: number;
  buttons?: { text: string; callback_data: string }[][];
  edited?: number;
  at: number;
  document?: string;
}

export const PARENT = { id: 777001, first_name: 'Dongyu', username: 'dongyu' };
export const STRANGER = { id: 999002, first_name: 'Unknown', username: 'promo_deals' };

export class TelegramMock {
  url = '';
  token = '123456789:TEST-telegram-token-abcdefghijklmnop';
  botUsername = 'fox_vibefox_bot';
  messages: TgMsg[] = [];
  private updates: Record<string, unknown>[] = [];
  private updateId = 1000;
  private msgId = 1;
  private waiters: (() => void)[] = [];
  private botWaiters: (() => void)[] = [];
  callbacksAnswered: { id: string; text?: string }[] = [];
  commands: unknown[] = [];
  private server?: http.Server;

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', () => r()));
    this.url = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }

  async stop(): Promise<void> {
    this.waiters.splice(0).forEach((w) => w());
    this.server?.closeAllConnections();
    await new Promise<void>((r) => this.server?.close(() => r()) ?? r());
  }

  private push(update: Record<string, unknown>): void {
    this.updates.push({ update_id: ++this.updateId, ...update });
    this.waiters.splice(0).forEach((w) => w());
  }

  private tgMessage(m: TgMsg): Record<string, unknown> {
    const from = m.from === 'parent' ? PARENT : m.from === 'stranger' ? STRANGER : { id: 42, is_bot: true, first_name: 'Fox', username: this.botUsername };
    return {
      message_id: m.message_id,
      from: { is_bot: m.from === 'bot', ...from },
      chat: { id: m.chat_id, type: 'private' },
      date: Math.floor(m.at / 1000),
      text: m.text,
      reply_to_message: m.reply_to ? this.tgMessage(this.messages.find((x) => x.message_id === m.reply_to)!) : undefined,
    };
  }

  /** The parent types a message (optionally quoting/replying to one). */
  parentSays(text: string, replyTo?: number, who: 'parent' | 'stranger' = 'parent'): TgMsg {
    const chat = who === 'parent' ? PARENT.id : STRANGER.id;
    const m: TgMsg = { message_id: this.msgId++, chat_id: chat, from: who, text, reply_to: replyTo, at: Date.now() };
    this.messages.push(m);
    this.push({ message: this.tgMessage(m) });
    return m;
  }

  strangerSays(text: string): TgMsg {
    return this.parentSays(text, undefined, 'stranger');
  }

  /** The parent taps an inline button on a bot message. */
  parentClicks(messageId: number, label: string | RegExp): void {
    const m = this.messages.find((x) => x.message_id === messageId);
    const btn = m?.buttons?.flat().find((b) => (typeof label === 'string' ? b.text.includes(label) : label.test(b.text)));
    if (!m || !btn) throw new Error(`no button ${label} on message ${messageId}`);
    this.push({
      callback_query: { id: 'cb' + this.updateId, from: { is_bot: false, ...PARENT }, message: this.tgMessage(m), data: btn.callback_data },
    });
  }

  botMessages(chat = PARENT.id): TgMsg[] {
    return this.messages.filter((m) => m.from === 'bot' && m.chat_id === chat);
  }

  async waitForBot(pred: (m: TgMsg) => boolean, timeoutMs = 20_000, chat = PARENT.id): Promise<TgMsg> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.botMessages(chat).find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) {
        const last = this.botMessages(chat).slice(-6).map((m) => `#${m.message_id}: ${m.text.slice(0, 160)}`).join('\n');
        throw new Error(`timed out waiting for bot message. Last bot messages:\n${last}`);
      }
      await new Promise<void>((r) => {
        const t = setTimeout(r, 300);
        this.botWaiters.push(() => {
          clearTimeout(t);
          r();
        });
      });
    }
  }

  private botChanged(): void {
    this.botWaiters.splice(0).forEach((w) => w());
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const u = new URL(req.url ?? '/', 'http://x');
    let raw = '';
    for await (const c of req) raw += c;
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (u.pathname === '/ui') return void (res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }), res.end(UI_HTML));
    if (u.pathname === '/ui/state') return json(200, { messages: this.messages.filter((m) => m.chat_id === PARENT.id), bot: this.botUsername });
    if (u.pathname === '/ui/send' && req.method === 'POST') {
      const b = JSON.parse(raw) as { text: string; replyTo?: number };
      return json(200, this.parentSays(b.text, b.replyTo));
    }
    if (u.pathname === '/ui/click' && req.method === 'POST') {
      const b = JSON.parse(raw) as { messageId: number; data: string };
      const m = this.messages.find((x) => x.message_id === b.messageId)!;
      this.push({ callback_query: { id: 'cb' + this.updateId, from: { is_bot: false, ...PARENT }, message: this.tgMessage(m), data: b.data } });
      return json(200, { ok: true });
    }

    const m = /^\/bot([^/]+)\/(\w+)$/.exec(u.pathname);
    if (!m) return json(404, { ok: false, error_code: 404, description: 'Not Found' });
    if (m[1] !== this.token) return json(401, { ok: false, error_code: 401, description: 'Unauthorized' });
    const method = m[2];
    let body: Record<string, unknown> = {};
    if ((req.headers['content-type'] ?? '').includes('application/json') && raw) body = JSON.parse(raw);
    if ((req.headers['content-type'] ?? '').includes('multipart/form-data')) {
      const chat = /name="chat_id"\r\n\r\n(\d+)/.exec(raw)?.[1];
      const fname = /filename="([^"]+)"/.exec(raw)?.[1];
      body = { chat_id: Number(chat), document: fname };
    }
    const ok = (result: unknown) => json(200, { ok: true, result });

    switch (method) {
      case 'getMe':
        return ok({ id: 42, is_bot: true, first_name: 'Fox', username: this.botUsername });
      case 'getUpdates': {
        const offset = Number(body.offset ?? 0);
        const timeout = Math.min(Number(body.timeout ?? 0), 2);
        const pending = () => this.updates.filter((x) => (x.update_id as number) >= offset);
        if (!pending().length && timeout > 0) {
          await new Promise<void>((r) => {
            const t = setTimeout(r, timeout * 1000);
            this.waiters.push(() => {
              clearTimeout(t);
              r();
            });
          });
        }
        return ok(pending());
      }
      case 'sendMessage': {
        const replyTo = (body.reply_parameters as { message_id?: number } | undefined)?.message_id;
        const msg: TgMsg = {
          message_id: this.msgId++,
          chat_id: Number(body.chat_id),
          from: 'bot',
          text: String(body.text),
          reply_to: replyTo,
          buttons: (body.reply_markup as { inline_keyboard?: TgMsg['buttons'] } | undefined)?.inline_keyboard,
          at: Date.now(),
        };
        if (body.parse_mode === 'HTML' && /<(?!\/?(b|i|code|pre|a)\b)[^>]*>/.test(msg.text)) {
          return json(400, { ok: false, error_code: 400, description: "Bad Request: can't parse entities" });
        }
        this.messages.push(msg);
        this.botChanged();
        return ok(this.tgMessage(msg));
      }
      case 'editMessageText': {
        const msg = this.messages.find((x) => x.message_id === Number(body.message_id));
        if (!msg) return json(400, { ok: false, error_code: 400, description: 'message to edit not found' });
        if (msg.text === body.text) return json(400, { ok: false, error_code: 400, description: 'Bad Request: message is not modified' });
        msg.text = String(body.text);
        msg.buttons = (body.reply_markup as { inline_keyboard?: TgMsg['buttons'] } | undefined)?.inline_keyboard;
        msg.edited = Date.now();
        this.botChanged();
        return ok(this.tgMessage(msg));
      }
      case 'sendDocument': {
        const msg: TgMsg = { message_id: this.msgId++, chat_id: Number(body.chat_id), from: 'bot', text: `📎 ${body.document}`, document: String(body.document), at: Date.now() };
        this.messages.push(msg);
        this.botChanged();
        return ok(this.tgMessage(msg));
      }
      case 'answerCallbackQuery':
        this.callbacksAnswered.push({ id: String(body.callback_query_id), text: body.text as string | undefined });
        return ok(true);
      case 'sendChatAction':
      case 'setMyDescription':
      case 'setMyShortDescription':
        return ok(true);
      case 'setMyCommands':
        this.commands = body.commands as unknown[];
        return ok(true);
      default:
        return json(404, { ok: false, error_code: 404, description: `method ${method} not mocked` });
    }
  }
}

const UI_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Telegram · Fox</title>
<style>
*{box-sizing:border-box}body{margin:0;font:15px/1.45 -apple-system,system-ui,"PingFang SC",sans-serif;background:#0e1621;color:#fff;height:100vh;display:flex;flex-direction:column}
.top{background:#17212b;padding:12px 18px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #0b121a}
.av{width:38px;height:38px;border-radius:50%;background:#f97316;display:flex;align-items:center;justify-content:center;font-size:20px}
.name{font-weight:600}.sub{color:#7f91a4;font-size:13px}
#log{flex:1;overflow-y:auto;padding:18px 14%;display:flex;flex-direction:column;gap:8px;background:#0e1621}
.m{max-width:72%;padding:8px 12px;border-radius:14px;white-space:pre-wrap;word-wrap:break-word;position:relative}
.bot{align-self:flex-start;background:#182533;border-bottom-left-radius:4px}
.parent{align-self:flex-end;background:#2b5278;border-bottom-right-radius:4px}
.q{border-left:3px solid #64b5ef;padding-left:8px;color:#9fc7ea;font-size:13px;margin-bottom:4px;max-height:3.2em;overflow:hidden}
.btns{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.btns button{flex:1;background:#2f6ea5;color:#fff;border:0;border-radius:8px;padding:7px 10px;font:inherit;font-size:14px;cursor:pointer}
.meta{color:#6d7f8f;font-size:11px;text-align:right;margin-top:2px}
.bar{background:#17212b;padding:10px 14%;display:flex;gap:8px}
.bar input{flex:1;background:#242f3d;border:0;border-radius:10px;padding:12px 14px;color:#fff;font:inherit}
.bar button{background:#2f6ea5;border:0;color:#fff;border-radius:10px;padding:0 18px;font:inherit}
#reply{color:#9fc7ea;font-size:13px;padding:0 14%;background:#17212b}
code,pre{background:#0b121a;border-radius:4px;padding:1px 4px;font-size:13px}a{color:#71b7f5}
</style></head><body>
<div class="top"><div class="av">🦊</div><div><div class="name">Fox</div><div class="sub">bot · 独立的 AI agent</div></div></div>
<div id="log"></div><div id="reply"></div>
<div class="bar"><input id="in" placeholder="Message" autocomplete="off"><button id="send">Send</button></div>
<script>
let replyTo=null, seen='';
const log=document.getElementById('log');
function render(s){const key=JSON.stringify(s.messages);if(key===seen)return;seen=key;log.innerHTML='';
for(const m of s.messages){const d=document.createElement('div');d.className='m '+(m.from==='bot'?'bot':'parent');d.dataset.id=m.message_id;
if(m.reply_to){const q=s.messages.find(x=>x.message_id===m.reply_to);if(q){const qd=document.createElement('div');qd.className='q';qd.textContent=q.text.replace(/<[^>]+>/g,'');d.appendChild(qd);}}
const t=document.createElement('div');t.innerHTML=m.text;d.appendChild(t);
if(m.buttons){const b=document.createElement('div');b.className='btns';for(const row of m.buttons)for(const btn of row){const e=document.createElement('button');e.textContent=btn.text;e.onclick=()=>fetch('/ui/click',{method:'POST',body:JSON.stringify({messageId:m.message_id,data:btn.callback_data})});b.appendChild(e);}d.appendChild(b);}
const meta=document.createElement('div');meta.className='meta';meta.textContent=new Date(m.at).toLocaleTimeString().slice(0,5)+(m.edited?' · edited':'');d.appendChild(meta);
d.ondblclick=()=>{replyTo=m.message_id;document.getElementById('reply').textContent='↩︎ 回复: '+t.textContent.slice(0,60);};
log.appendChild(d);}log.scrollTop=log.scrollHeight;}
async function tick(){try{render(await (await fetch('/ui/state')).json());}catch(e){}setTimeout(tick,400);}tick();
async function send(){const i=document.getElementById('in');if(!i.value.trim())return;await fetch('/ui/send',{method:'POST',body:JSON.stringify({text:i.value,replyTo})});i.value='';replyTo=null;document.getElementById('reply').textContent='';}
document.getElementById('send').onclick=send;document.getElementById('in').onkeydown=e=>{if(e.key==='Enter')send();};
</script></body></html>`;
