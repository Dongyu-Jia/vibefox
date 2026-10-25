/*
 * vibefox console: the birth wizard (setup mode) and the control plane, in
 * plain DOM with no build step. It talks only to /v1/* on its own origin
 * (see docs/CONTROL-PLANE.md). Nothing from the API is ever parsed as HTML:
 * email subjects, SMS, task titles and handles all go in as text nodes.
 */

const NS = 'http://www.w3.org/2000/svg';
const $app = document.getElementById('app');
const $toasts = document.getElementById('toasts');

const S = {
  mode: null, // 'setup' | 'control'
  token: null,
  agent: null, // { name, slug }
  overview: null,
  catalogP: null,
  view: 0, // bumps on every navigation; async work started for an older view drops its result
  polls: [],
  drafts: new Map(), // kind id -> password generated this session (memory only, never stored)
  expired: false,
  shell: null,
  navigated: false,
};

// ---------------- DOM helpers ----------------

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'style' || k === 'innerHTML') throw new Error(`refusing ${k}`);
      if (k === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
      else if (k === 'text') el.textContent = String(v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked' || k === 'disabled' || k === 'hidden' || k === 'required' || k === 'readOnly') el[k] = Boolean(v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  add(el, kids);
  return el;
}

function add(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

/** replaceChildren / append that skip null and false, so `cond ? node : null` reads naturally. */
const fill = (el, ...kids) => (el.replaceChildren(), add(el, kids));
const put = (el, ...kids) => add(el, kids);

const ICONS = {
  home: 'M4 11l8-7 8 7v9h-5v-6H9v6H4z',
  box: 'M4 8l8-4 8 4v8l-8 4-8-4z M4 8l8 4 8-4 M12 12v8',
  wallet: 'M4 7h15a1 1 0 0 1 1 1v11H5a1 1 0 0 1-1-1z M4 7l11-3v3 M16 13h1.5',
  chat: 'M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-5 4z',
  spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z M18.5 16.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z',
  tool: 'M14.5 4.5a4.5 4.5 0 0 0-4.2 6.1L4 17v3h3l6.4-6.3a4.5 4.5 0 0 0 6.1-4.2l-2.8 1.3-2.2-2.2z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4.5 20c1.4-3.6 4.2-5.5 7.5-5.5s6.1 1.9 7.5 5.5',
  copy: 'M9 9h10v10H9z M5 15V5h10',
  check: 'M5 12.5l4.5 4.5L19 7',
  ext: 'M14 4h6v6 M20 4l-9 9 M18 14v6H4V6h6',
  plus: 'M12 5v14 M5 12h14',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M20 20l-4-4',
  arrow: 'M5 12h14 M13 6l6 6-6 6',
  back: 'M19 12H5 M11 6l-6 6 6 6',
  lock: 'M6 11h12v9H6z M8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  mail: 'M4 6h16v12H4z M4 7l8 6 8-6',
  phone: 'M7 3h3l1.5 4.5-2 1.5a11 11 0 0 0 5.5 5.5l1.5-2L21 14v3a2 2 0 0 1-2 2A16 16 0 0 1 5 5a2 2 0 0 1 2-2z',
  alert: 'M12 4l9 16H3z M12 10v4 M12 17v.5',
  x: 'M6 6l12 12 M18 6L6 18',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7 M20 5v6h-6',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  file: 'M6 3h8l4 4v14H6z M14 3v4h4',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M3 12h18 M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9 M12 3c-2.5 2.7-3.8 5.7-3.8 9s1.3 6.3 3.8 9',
  snow: 'M12 3v18 M4.2 7.5l15.6 9 M19.8 7.5l-15.6 9',
  key: 'M8 15a4 4 0 1 1 3.4-6.1L20 9v3h-2v2h-3v-2h-3.6A4 4 0 0 1 8 15z',
  id: 'M4 5h16v14H4z M8 10.5a1.8 1.8 0 1 0 0-.1z M6 15.5c.6-1.5 1.6-2.2 3-2.2s2.4.7 3 2.2 M14 10h4 M14 13h3',
};

function icon(name, cls) {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', cls ? `icon ${cls}` : 'icon');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', ICONS[name] || ICONS.box);
  put(svg, p);
  return svg;
}

const $ = (sel, root = document) => root.querySelector(sel);

/** A button or a link that looks like one. External links open in a new tab without a referrer. */
function btn(label, o = {}) {
  const cls = ['btn', o.kind || 'secondary', o.size, o.block && 'block', o.cls];
  const kids = [o.icon ? icon(o.icon) : null, h('span', { class: 'btn-label', text: label }), o.trail ? icon(o.trail) : null];
  if (o.href) {
    const ext = /^https?:/i.test(o.href);
    return h('a', { class: cls, href: o.href, target: ext ? '_blank' : null, rel: ext ? 'noopener noreferrer' : null, 'aria-label': o.aria }, kids);
  }
  return h('button', { type: o.type || 'button', class: cls, disabled: o.disabled, onclick: o.onClick, 'aria-label': o.aria }, kids);
}

function setLabel(button, text) {
  const l = button.querySelector('.btn-label');
  if (l) l.textContent = text;
}

/** Runs an async action from a button: disables it, shows a spinner, puts any error in `errEl` (or a toast). */
async function busy(button, fn, errEl) {
  if (button.disabled) return undefined;
  button.disabled = true;
  button.classList.add('is-busy');
  button.setAttribute('aria-busy', 'true');
  if (errEl) showErr(errEl, '');
  try {
    return await fn();
  } catch (e) {
    if (e && e.status === 401) return undefined;
    if (errEl && errEl.isConnected) showErr(errEl, e.message);
    else toast(e.message, 'bad');
    return undefined;
  } finally {
    button.disabled = false;
    button.classList.remove('is-busy');
    button.removeAttribute('aria-busy');
  }
}

const errBox = () => h('p', { class: 'form-error', role: 'alert', hidden: true });
function showErr(el, msg) {
  el.textContent = msg || '';
  el.hidden = !msg;
}

function toast(msg, tone) {
  const t = h('div', { class: ['toast', tone] }, tone === 'bad' ? icon('alert') : icon('check'), h('span', { text: msg }));
  put($toasts, t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 260);
  }, tone === 'bad' ? 4200 : 2400);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { class: 'clip', 'aria-hidden': 'true', readonly: true });
    ta.value = text;
    put(document.body, ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

function copyBtn(value, what, o = {}) {
  const label = h('span', { class: 'btn-label', text: o.label || '复制' });
  const b = h('button', { type: 'button', class: ['btn', o.kind || 'ghost', 'sm', 'copy'], 'aria-label': `复制${what || ''}` }, icon('copy'), label);
  let t = 0;
  b.addEventListener('click', async () => {
    const ok = await copyText(typeof value === 'function' ? value() : value);
    if (!ok) return toast('没复制成功，可以手动选中再复制', 'bad');
    b.classList.add('done');
    b.firstChild.replaceWith(icon('check'));
    label.textContent = '已复制';
    clearTimeout(t);
    t = setTimeout(() => {
      b.classList.remove('done');
      b.firstChild.replaceWith(icon('copy'));
      label.textContent = o.label || '复制';
    }, 1600);
  });
  return b;
}

const badge = (text, tone) => h('span', { class: ['badge', tone], text });
const spinner = () => h('span', { class: 'spinner', 'aria-hidden': 'true' });

function seg(options, value, onChange, o = {}) {
  const wrap = h('div', { class: ['seg', o.small && 'sm'], role: 'radiogroup', 'aria-label': o.label });
  const items = options.map((opt) =>
    h('button', { type: 'button', class: 'seg-item', role: 'radio', 'aria-checked': String(opt.value === value), tabindex: opt.value === value ? '0' : '-1' }, opt.icon ? icon(opt.icon) : null, h('span', { text: opt.label })),
  );
  const set = (v) =>
    items.forEach((b, i) => {
      b.setAttribute('aria-checked', String(options[i].value === v));
      b.tabIndex = options[i].value === v ? 0 : -1;
    });
  items.forEach((b, i) =>
    b.addEventListener('click', () => {
      set(options[i].value);
      onChange(options[i].value);
    }),
  );
  wrap.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    const next = items[(i + (e.key === 'ArrowRight' ? 1 : items.length - 1)) % items.length];
    next.focus();
    next.click();
    e.preventDefault();
  });
  add(wrap, items);
  return wrap;
}

function chip(label, pressed, onToggle, o = {}) {
  const c = h('button', { type: 'button', class: ['chip', o.cls], 'aria-pressed': String(Boolean(pressed)) }, o.icon ? icon(o.icon) : null, h('span', { text: label }));
  c.addEventListener('click', () => {
    const v = c.getAttribute('aria-pressed') !== 'true';
    if (!o.radio) c.setAttribute('aria-pressed', String(v));
    onToggle(v, c);
  });
  return c;
}

let fieldSeq = 0;
function input(props = {}) {
  return h('input', { class: 'input', type: 'text', autocomplete: 'off', spellcheck: 'false', ...props, id: props.id || `f${++fieldSeq}` });
}

/** A password-style input with a show/hide toggle. Returns the wrapper; `.input` inside is the field. */
function secretInput(props = {}) {
  const el = input({ ...props, type: 'password', autocapitalize: 'off' });
  const t = h('button', { type: 'button', class: 'reveal', 'aria-label': '显示', 'aria-pressed': 'false' }, icon('eye'));
  t.addEventListener('click', () => {
    const show = el.type === 'password';
    el.type = show ? 'text' : 'password';
    t.setAttribute('aria-pressed', String(show));
    t.setAttribute('aria-label', show ? '隐藏' : '显示');
  });
  return h('div', { class: 'secret' }, el, t);
}

function field(label, control, o = {}) {
  const el = control.matches?.('input, select, textarea') ? control : $('input, select, textarea', control);
  const helpId = o.help ? `${el.id}-help` : null;
  if (helpId) el.setAttribute('aria-describedby', helpId);
  return h(
    'div',
    { class: ['field', o.cls] },
    h('label', { class: 'field-label', for: el.id }, label, o.optional ? h('span', { class: 'optional', text: '可选' }) : null),
    control,
    o.help ? h('p', { class: 'field-help', id: helpId, text: o.help }) : null,
  );
}

function switchEl(checked, o) {
  const s = h('input', { type: 'checkbox', role: 'switch', class: 'switch', checked, disabled: o.disabled, 'aria-label': o.label, id: o.id });
  s.addEventListener('change', () => o.onChange(s.checked, s));
  return s;
}

// ---------------- formatting ----------------

const fmtCents = (c) => `$${(Number(c || 0) / 100).toFixed(2)}`;
const fmtDollars = (c) => (c % 100 === 0 ? `$${c / 100}` : fmtCents(c));

function fmtPhone(p) {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(p || '');
  return m ? `+1 (${m[1]}) ${m[2]}-${m[3]}` : p || '';
}

const dateFmt = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
function fmtTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : dateFmt.format(d);
}

function ago(iso) {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 45) return '刚刚';
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return fmtTime(iso);
}

function daysSince(iso) {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : Math.max(1, Math.floor((Date.now() - t) / 86400000) + 1);
}

/** Only http(s) links ever become hrefs; anything else stays text. */
function safeUrl(u) {
  try {
    const x = new URL(String(u));
    return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null;
  } catch {
    return null;
  }
}

function shortUrl(u) {
  try {
    const x = new URL(u);
    return x.host + (x.pathname.length > 1 ? x.pathname : '');
  } catch {
    return String(u);
  }
}

const initial = (name) => (String(name || '?').trim()[0] || '?').toUpperCase();
const finePointer = () => window.matchMedia('(pointer: fine)').matches;

function randomHex(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------- API ----------------

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path, o = {}) {
  const headers = { accept: 'application/json' };
  if (o.auth !== false && S.token) headers.authorization = `Bearer ${S.token}`;
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  let res;
  try {
    res = await fetch(path, { method: o.method || (o.body !== undefined ? 'POST' : 'GET'), headers, body: o.body === undefined ? undefined : JSON.stringify(o.body), cache: 'no-store', credentials: 'omit' });
  } catch {
    throw new ApiError(0, '连不上它的后台服务。它可能没在运行：在终端里运行 vf start。');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (res.status === 401 && o.auth !== false) {
    sessionLost();
    throw new ApiError(401, '会话过期了');
  }
  if (!res.ok) throw new ApiError(res.status, (data && typeof data.error === 'string' && data.error) || `出了点问题（HTTP ${res.status}）`);
  return data ?? {};
}

const post = (path, body = {}) => api(path, { method: 'POST', body });

function catalog() {
  S.catalogP ||= api('/v1/control/catalog').then((c) => ({ groups: c.groups || [], kinds: c.kinds || [] })).catch((e) => {
    S.catalogP = null;
    throw e;
  });
  return S.catalogP;
}

async function overview() {
  S.overview = await api('/v1/control/overview');
  if (S.overview.agent) S.agent = { ...S.agent, ...S.overview.agent };
  return S.overview;
}

async function savedKeys() {
  try {
    return (await api('/v1/control/keys')).keys || [];
  } catch (e) {
    if (e.status === 401) throw e;
    return [];
  }
}

const savedKey = (keys, name) => keys.find((k) => String(k.name).toLowerCase() === name && k.present);

/** Repeats `fn` every `ms` while this view is on screen; stops when it returns true. Skips ticks while the tab is hidden. */
function poll(fn, ms) {
  const view = S.view;
  let timer = 0;
  let stopped = false;
  const handle = {
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
  const tick = async () => {
    if (stopped || view !== S.view) return;
    if (!document.hidden) {
      try {
        if ((await fn()) === true) return handle.stop();
      } catch (e) {
        if (e.status === 401) return handle.stop();
      }
    }
    if (!stopped && view === S.view) timer = setTimeout(tick, ms);
  };
  timer = setTimeout(tick, ms);
  S.polls.push(handle);
  return handle;
}

function stopPolls() {
  S.polls.splice(0).forEach((p) => p.stop());
}

// ---------------- session ----------------

const SKEY = 'vf.session';

function loadSession() {
  try {
    const v = JSON.parse(sessionStorage.getItem(SKEY) || 'null');
    return v && typeof v.token === 'string' ? v : null;
  } catch {
    return null;
  }
}

function saveSession(mode, token) {
  try {
    sessionStorage.setItem(SKEY, JSON.stringify({ mode, token }));
  } catch {
    // private mode: the session lasts as long as this page
  }
}

function clearSession() {
  try {
    sessionStorage.removeItem(SKEY);
  } catch {
    // nothing stored
  }
}

function sessionLost() {
  if (S.expired) return;
  S.expired = true;
  S.token = null;
  clearSession();
  stopPolls();
  S.view++;
  renderExpired();
}

function cleanHash(next) {
  history.replaceState(null, '', `${location.pathname}${location.search}#${next}`);
}

async function boot() {
  stopPolls();
  S.view++;
  S.shell = null;
  S.expired = false;
  const raw = location.hash.replace(/^#\/?/, '');
  const hp = /(^|&)code=/.test(raw) ? new URLSearchParams(raw) : null;
  let who;
  try {
    who = await api('/v1/whoami', { auth: false });
  } catch (e) {
    return renderOffline(e);
  }
  S.mode = who.mode === 'setup' ? 'setup' : 'control';
  S.agent = who.agent || null;
  if (hp?.get('code')) {
    const code = hp.get('code');
    const to = hp.get('to');
    // Drop the one-time code from the address bar and history before anything else.
    cleanHash(S.mode === 'setup' ? '/setup' : to && /^\/[\w/:%.-]*$/.test(to) ? to : '/home');
    try {
      const r = await api(`/v1/${S.mode}/session`, { body: { code }, auth: false });
      S.token = r.token;
      if (r.agent) S.agent = r.agent;
      saveSession(S.mode, r.token);
    } catch (e) {
      clearSession();
      return renderExpired(e.status && e.status < 500 ? null : e);
    }
  } else {
    const s = loadSession();
    S.token = s && s.mode === S.mode ? s.token : null;
  }
  if (!S.token) return renderExpired();
  if (S.mode === 'setup') {
    if (location.hash !== '#/setup') cleanHash('/setup');
    return renderSetup();
  }
  if (!location.hash.startsWith('#/') || location.hash === '#/setup') cleanHash('/home');
  return renderControl();
}

window.addEventListener('hashchange', () => {
  if (/code=/.test(location.hash)) return void boot();
  if (S.mode === 'control' && S.token && !S.expired) renderControl();
});

function brandMark() {
  return h('div', { class: 'brand-solo' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true', text: '🦊' }), h('span', { text: 'vibefox' }));
}

function cmdLine(cmd) {
  return h('div', { class: 'cmd' }, h('code', { text: cmd }), copyBtn(cmd, '命令'));
}

function renderExpired(err) {
  stopPolls();
  document.title = 'vibefox';
  const setup = S.mode === 'setup';
  fill($app,
    h(
      'main',
      { class: 'solo' },
      h(
        'div',
        { class: 'card solo-card' },
        brandMark(),
        h('h1', { text: setup ? '这个出生向导的链接用过了' : '这个控制台页面过期了' }),
        h('p', { class: 'lead', text: '为了安全，每个链接只能打开一次，会话 12 小时后过期。在这台 Mac 的终端里再运行一次：' }),
        cmdLine(setup ? 'vf init' : 'vf ui'),
        err ? h('p', { class: 'form-error', text: err.message }) : null,
        h('p', { class: 'muted small', text: '它会在浏览器里打开一个新的链接。' }),
      ),
    ),
  );
}

function renderOffline(err) {
  document.title = 'vibefox';
  const retry = btn('再试一次', { kind: 'primary', icon: 'refresh', onClick: () => boot() });
  fill($app,
    h(
      'main',
      { class: 'solo' },
      h(
        'div',
        { class: 'card solo-card' },
        brandMark(),
        h('h1', { text: '连不上它' }),
        h('p', { class: 'lead', text: '这一页找不到 vibefox 的本地服务。如果刚完成出生，控制台换了地址；如果它没在运行，先启动它：' }),
        cmdLine('vf ui'),
        h('p', { class: 'muted small', text: err?.message || '' }),
        h('div', { class: 'actions' }, retry),
      ),
    ),
  );
}

// ---------------- setup mode ----------------

async function renderSetup() {
  document.title = '出生 · vibefox';
  const view = S.view;
  const root = h('main', { class: 'setup' });
  fill($app, h('div', { class: 'setup-wrap' }, root));
  let st;
  try {
    st = await api('/v1/setup/state');
  } catch (e) {
    if (e.status === 401 || view !== S.view) return;
    fill(root, errorPanel(e, () => renderSetup()));
    return;
  }
  if (view !== S.view) return;
  const ctx = { st, step: 0, skipped: { email: false, phone: false }, email: null, phone: null, editName: false };
  const firstOpen = () => (!ctx.st.born ? 1 : !ctx.st.email && !ctx.skipped.email ? 2 : !ctx.st.phone && !ctx.skipped.phone ? 3 : 4);
  ctx.step = firstOpen();

  const go = (step) => {
    ctx.step = step;
    paint(true);
  };
  ctx.next = () => go(firstOpen());

  function paint(focus) {
    const name = ctx.st.agent?.name;
    const head = h(
      'header',
      { class: 'setup-head' },
      brandMark(),
      h('h1', { tabindex: '-1', text: name && ctx.st.born ? `${name} 快出生了` : '让一个独立的 AI agent 在你的 Mac 上出生' }),
      h('p', { class: 'lead', text: '它会有自己的名字、邮箱和电话号码。大脑、Telegram、钱包和零花钱，之后在控制台里一项一项加。' }),
    );
    const done = { 1: ctx.st.born, 2: Boolean(ctx.st.email), 3: Boolean(ctx.st.phone) };
    const steps = [
      { n: 1, label: '名字' },
      { n: 2, label: '邮箱' },
      { n: 3, label: '电话' },
    ];
    const stepper = h(
      'ol',
      { class: 'stepper', 'aria-label': '出生的三步' },
      steps.map((s) => {
        const state = ctx.step === s.n ? 'current' : done[s.n] ? 'done' : 'todo';
        const reachable = s.n === 1 || ctx.st.born;
        const label = [h('span', { class: 'stepper-num' }, state === 'done' ? icon('check') : String(s.n)), h('span', { class: 'stepper-label', text: s.label })];
        return h(
          'li',
          { class: ['stepper-item', state], 'aria-current': state === 'current' ? 'step' : null },
          reachable && state !== 'current' ? h('button', { type: 'button', class: 'stepper-btn', onclick: () => go(s.n), 'aria-label': `${s.label}（${done[s.n] ? '已完成，点一下修改' : '未完成'}）` }, label) : h('span', { class: 'stepper-btn' }, label),
        );
      }),
    );
    let panel;
    if (ctx.step === 1) panel = setupName(ctx);
    else if (ctx.step === 2) panel = setupIdentity(ctx, EMAIL_STEP);
    else if (ctx.step === 3) panel = setupIdentity(ctx, PHONE_STEP);
    else panel = setupFinish(ctx);
    fill(root, head, stepper, panel);
    const auto = finePointer() ? $('[data-autofocus]', panel) : null;
    if (auto) auto.focus();
    else if (focus) $('h2', panel)?.focus();
  }
  paint(false);
}

function setupName(ctx) {
  const a = ctx.st.agent || {};
  const name = input({ value: a.name || 'Fox', maxlength: '40', autocomplete: 'off', 'data-autofocus': !ctx.st.born ? null : true });
  const parent = input({ value: a.parentName || '', placeholder: '比如 Dongyu', maxlength: '60', autocomplete: 'given-name', 'data-autofocus': !ctx.st.born ? true : null });
  const err = errBox();
  const submit = btn(ctx.st.born ? '保存' : '让它出生', { kind: 'primary', size: 'lg', type: 'submit', trail: 'arrow' });
  const form = h(
    'form',
    { class: 'card step-card', novalidate: true, 'aria-labelledby': 'setup-name-title' },
    h('h2', { id: 'setup-name-title', tabindex: '-1', text: '给它起个名字' }),
    h('p', { class: 'muted', text: '名字它自己会一直用：邮箱、电话里的声音、签名都跟着它。' }),
    field('它的名字', name),
    field('你的名字', parent, { help: '它会叫你"家长"。任务只来自你。' }),
    err,
    h('div', { class: 'actions' }, submit),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const n = name.value.trim();
    const p = parent.value.trim();
    if (!n) return showErr(err, '先给它起个名字');
    if (!p) return showErr(err, '再告诉它你叫什么');
    busy(
      submit,
      async () => {
        const r = await post('/v1/setup/birth', { name: n, parentName: p });
        ctx.st.born = true;
        ctx.st.agent = { ...(ctx.st.agent || {}), ...(r.agent || {}), name: r.agent?.name || n, parentName: p };
        S.agent = ctx.st.agent;
        toast(`${ctx.st.agent.name} 出生了`);
        ctx.next();
      },
      err,
    );
  });
  return form;
}

const EMAIL_STEP = {
  id: 'email',
  title: '它自己的邮箱',
  intro: '用 AgentMail：它以自己的名义收发邮件、注册网站、收验证邮件。',
  presetKey: 'agentmail',
  keyLabel: 'AgentMail API key',
  keyPlaceholder: 'am_…',
  signup: { text: '去 console.agentmail.to 注册（免费档 3 个邮箱），创建一个 API key', url: 'https://console.agentmail.to' },
  optionsPath: '/v1/setup/email/options',
  listKey: 'inboxes',
  savePath: '/v1/setup/email',
  itemValue: (i) => i.email,
  itemLabel: (i) => `用已有的 ${i.email}`,
  newLabel: '开一个新的',
  newNote: '免费档最多 3 个',
  saveLabel: '用这个邮箱',
  defaultPick: () => 'new',
};

const PHONE_STEP = {
  id: 'phone',
  title: '它自己的电话号码',
  intro: '用 AgentPhone：收发短信、接打电话、收验证码。目前只有美国和加拿大号码。',
  presetKey: 'agentphone',
  keyLabel: 'AgentPhone API key',
  keyPlaceholder: 'ap_…',
  signup: { text: '去 agentphone.ai 注册（送 $5），创建一个 API key', url: 'https://agentphone.ai' },
  optionsPath: '/v1/setup/phone/options',
  listKey: 'numbers',
  savePath: '/v1/setup/phone',
  itemValue: (n) => fmtPhone(n.phoneNumber),
  itemLabel: (n) => `用已有的 ${fmtPhone(n.phoneNumber)}`,
  itemNote: '不额外花钱',
  newLabel: '开一个新号码',
  newNote: '$3/月',
  saveLabel: '用这个号码',
  defaultPick: (list) => (list[0] ? list[0].id : 'new'),
};

/** Email and phone are the same shape: a key (saved or pasted), then reuse one or open a new one. */
function setupIdentity(ctx, cfg) {
  const preset = ctx.st.preset?.[cfg.presetKey];
  const L = (ctx[cfg.id] ||= { usePreset: Boolean(preset), key: '', list: null, pick: 'new', username: '', areaCode: '', loading: false, error: '' });
  if (!L.username) L.username = `${ctx.st.agent?.slug || 'fox'}-${randomHex(2)}`;
  const card = h('section', { class: 'card step-card', 'aria-labelledby': `setup-${cfg.id}-title` });
  const current = cfg.id === 'email' ? ctx.st.email : ctx.st.phone;

  const keyBody = () => (L.usePreset ? { usePreset: true } : { key: L.key });

  async function loadOptions() {
    L.loading = true;
    L.error = '';
    paint();
    try {
      const r = await post(cfg.optionsPath, keyBody());
      L.list = r[cfg.listKey] || [];
      L.pick = cfg.defaultPick(L.list);
    } catch (e) {
      L.error = e.message;
      if (!L.usePreset) L.list = null;
    } finally {
      L.loading = false;
    }
    paint(true);
  }

  function keyRow() {
    if (L.usePreset) {
      return h(
        'div',
        { class: 'keyrow' },
        h('span', { class: 'keyrow-icon' }, icon('key')),
        h('div', { class: 'keyrow-text' }, h('strong', { text: '用你存好的 key' }), h('span', { class: 'muted small' }, `${cfg.keyLabel} `, h('span', { class: 'mono', text: preset }))),
        btn('换一个 key', {
          kind: 'ghost',
          size: 'sm',
          onClick: () => {
            L.usePreset = false;
            L.list = null;
            L.error = '';
            paint(true);
          },
        }),
      );
    }
    const keyIn = secretInput({ placeholder: cfg.keyPlaceholder, value: L.key, 'data-autofocus': true });
    const el = $('input', keyIn);
    const err = errBox();
    const next = btn('下一步', { kind: 'primary', type: 'submit', trail: 'arrow' });
    const form = h(
      'form',
      { class: 'keyform', novalidate: true },
      field(cfg.keyLabel, keyIn, { help: '只存在它自己的钥匙串里。' }),
      h('p', { class: 'small' }, h('a', { href: cfg.signup.url, target: '_blank', rel: 'noopener noreferrer', class: 'link' }, cfg.signup.text, icon('ext'))),
      err,
      h('div', { class: 'actions' }, next, preset ? btn(`改用存好的 key（${preset}）`, { kind: 'ghost', onClick: () => ((L.usePreset = true), loadOptions()) }) : null),
    );
    if (L.error) showErr(err, L.error);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      L.key = el.value.trim();
      if (!L.key) return showErr(err, `先粘贴 ${cfg.keyLabel}`);
      loadOptions();
    });
    return form;
  }

  function options() {
    if (L.loading) return h('div', { class: 'options loading' }, h('div', { class: 'skeleton line' }), h('div', { class: 'skeleton line' }));
    if (!L.list) return null;
    const name = `pick-${cfg.id}`;
    const err = errBox();
    const save = btn(cfg.saveLabel, { kind: 'primary', size: 'lg', type: 'submit', trail: 'arrow' });
    const radio = (value, kids, extra) => {
      const r = h('input', { type: 'radio', name, value, checked: L.pick === value, class: 'radio' });
      r.addEventListener('change', () => (L.pick = value));
      return h('label', { class: 'option' }, r, h('span', { class: 'option-body' }, kids), extra);
    };
    let newExtra;
    if (cfg.id === 'email') {
      const u = input({ value: L.username, 'aria-label': '邮箱名', maxlength: '60', class: 'input inline mono' });
      u.addEventListener('input', () => (L.username = u.value.trim().toLowerCase()));
      u.addEventListener('focus', () => {
        L.pick = 'new';
        $(`input[name=${name}][value=new]`, card).checked = true;
      });
      newExtra = h('span', { class: 'option-inline' }, u, h('span', { class: 'mono muted', text: '@agentmail.to' }));
    } else {
      const ac = input({ value: L.areaCode, inputmode: 'numeric', maxlength: '3', placeholder: '区号（可不填）', 'aria-label': '想要的区号（美国/加拿大三位数，可不填）', class: 'input inline narrow mono' });
      ac.addEventListener('input', () => (L.areaCode = ac.value.replace(/\D/g, '').slice(0, 3)));
      ac.addEventListener('focus', () => {
        L.pick = 'new';
        $(`input[name=${name}][value=new]`, card).checked = true;
      });
      newExtra = h('span', { class: 'option-inline' }, ac);
    }
    const items = [
      ...(cfg.id === 'phone' ? L.list.map((i) => radio(i.id, [h('strong', { text: cfg.itemLabel(i) }), cfg.itemNote ? h('span', { class: 'muted small', text: cfg.itemNote }) : null])) : []),
      radio('new', [h('strong', { text: cfg.newLabel }), h('span', { class: 'muted small', text: cfg.newNote })], newExtra),
      ...(cfg.id === 'email' ? L.list.map((i) => radio(i.id, [h('strong', { text: cfg.itemLabel(i) })])) : []),
    ];
    const form = h('form', { class: 'pick', novalidate: true }, h('fieldset', { class: 'options' }, h('legend', { class: 'sr-only', text: cfg.title }), items), err, h('div', { class: 'actions' }, save));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const body = keyBody();
      if (L.pick === 'new') {
        if (cfg.id === 'email') {
          if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(L.username)) return showErr(err, '邮箱名只能用小写字母、数字、点、横线和下划线');
          body.username = L.username;
        } else {
          if (L.areaCode && !/^\d{3}$/.test(L.areaCode)) return showErr(err, '区号是三位数字，或者不填');
          if (L.areaCode) body.areaCode = L.areaCode;
        }
      } else body.use = L.pick;
      busy(
        save,
        async () => {
          const r = await post(cfg.savePath, body);
          if (cfg.id === 'email') ctx.st.email = r.email || L.list.find((i) => i.id === L.pick)?.email || `${L.username}@agentmail.to`;
          else ctx.st.phone = r.phone || L.list.find((i) => i.id === L.pick)?.phoneNumber || '';
          toast(cfg.id === 'email' ? `它有邮箱了：${ctx.st.email}` : `它有号码了：${fmtPhone(ctx.st.phone)}`);
          ctx.next();
        },
        err,
      );
    });
    return form;
  }

  function paint(focus) {
    const skip = h('button', {
      type: 'button',
      class: 'link quiet',
      text: '先跳过，之后在控制台里加',
      onclick: () => {
        ctx.skipped[cfg.id] = true;
        ctx.next();
      },
    });
    fill(card,
      h('h2', { id: `setup-${cfg.id}-title`, tabindex: '-1', text: cfg.title }),
      h('p', { class: 'muted', text: cfg.intro }),
      current ? h('div', { class: 'note ok' }, icon('check'), h('span', {}, '现在用的是 ', h('strong', { class: 'mono', text: cfg.id === 'phone' ? fmtPhone(current) : current }), '。可以换一个，或者直接下一步。')) : null,
      keyRow(),
      L.usePreset && L.error ? h('p', { class: 'form-error', role: 'alert', text: L.error }) : null,
      options(),
      current ? h('div', { class: 'actions' }, btn('不换，下一步', { kind: 'ghost', onClick: () => ctx.next(), trail: 'arrow' })) : h('div', { class: 'skip-row' }, skip),
    );
    if (focus) ($('input[type=radio]:checked', card) || $('input', card))?.focus();
  }

  paint();
  // With a saved key the inbox/number list loads by itself: one click to pick.
  if (L.usePreset && !L.list && !L.loading) queueMicrotask(loadOptions);
  return card;
}

function setupFinish(ctx) {
  const a = ctx.st.agent || {};
  const err = errBox();
  const status = h('p', { class: 'muted small', hidden: true, role: 'status' });
  const go = btn('让它住下来', { kind: 'primary', size: 'lg', block: true, trail: 'arrow' });
  go.addEventListener('click', () =>
    busy(
      go,
      async () => {
        setLabel(go, '正在安顿它…');
        status.hidden = false;
        status.textContent = '装好后台服务、等它醒来、打开控制台——大概十几秒。';
        try {
          const r = await post('/v1/setup/finish');
          const target = r.redirect ? new URL(r.redirect, location.href) : null;
          // The console only ever lives on this Mac.
          if (!target || !/^(127\.0\.0\.1|localhost)$/.test(target.hostname)) throw new Error('控制台的地址不对，运行 vf ui 打开它');
          setLabel(go, '好了，正在打开控制台…');
          location.assign(target.href);
        } catch (e) {
          setLabel(go, '让它住下来');
          status.hidden = true;
          throw e;
        }
      },
      err,
    ),
  );
  const line = (ic, label, value, copyVal) =>
    h('div', { class: 'vline' }, h('span', { class: 'vline-icon' }, icon(ic)), h('span', { class: 'vline-label', text: label }), value ? h('span', { class: ['vline-value', copyVal !== false && 'mono'], text: value }) : h('span', { class: 'vline-value muted', text: '先跳过了' }), value && copyVal !== false ? copyBtn(copyVal || value, label) : null);
  return h(
    'section',
    { class: 'card step-card finish', 'aria-labelledby': 'setup-finish-title' },
    h('div', { class: 'finish-avatar', 'aria-hidden': 'true', text: initial(a.name) }),
    h('h2', { id: 'setup-finish-title', tabindex: '-1', text: `${a.name || '它'} 准备好了` }),
    h('p', { class: 'muted', text: '它会装成这台 Mac 上的后台服务，开机自启、崩溃自动重启。' }),
    h('div', { class: 'vlines' }, line('user', '家长', a.parentName || '', false), line('mail', '邮箱', ctx.st.email || ''), line('phone', '电话', fmtPhone(ctx.st.phone || ''), ctx.st.phone)),
    h('p', { class: 'small muted', text: '接下来在控制台里一项一项加：大脑、Telegram、钱包和零花钱。没有大脑和对话渠道之前，它能收邮件和短信，但还不能接任务。' }),
    err,
    go,
    status,
  );
}

// ---------------- control mode: shell and routing ----------------

const NAV = [
  { id: 'home', label: '首页', icon: 'home' },
  { id: 'resources', label: '资源', icon: 'box' },
  { id: 'money', label: '钱', icon: 'wallet' },
  { id: 'chat', label: '对话', icon: 'chat' },
  { id: 'brain', label: '大脑', icon: 'spark' },
  { id: 'workers', label: 'Worker', icon: 'tool' },
  { id: 'parent', label: '家长', icon: 'user' },
];

const STEP_CTA = {
  brain: { label: '接上大脑', href: '#/brain', nav: 'brain' },
  telegram: { label: '连上 Telegram', href: '#/chat', nav: 'chat' },
  wallet: { label: '连接 Link', href: '#/money', nav: 'money' },
  mandate: { label: '定零花钱', href: '#/money/mandate', nav: 'money' },
  workers: { label: '选 worker', href: '#/workers', nav: 'workers' },
  legal: { label: '填登记人', href: '#/parent/legal', nav: 'parent' },
  parent: { label: '留联系方式', href: '#/parent', nav: 'parent' },
  resources: { label: '添加资源', href: '#/resources/add', nav: 'resources' },
};

function routeParts() {
  return location.hash
    .replace(/^#\/?/, '')
    .split('?')[0]
    .split('/')
    .filter(Boolean)
    .map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return p;
      }
    });
}

function ensureShell() {
  if (S.shell && S.shell.root.isConnected) return S.shell;
  const links = new Map();
  const nav = h(
    'nav',
    { class: 'nav', 'aria-label': '控制台' },
    NAV.map((n) => {
      const a = h('a', { class: 'nav-item', href: `#/${n.id}` }, icon(n.icon), h('span', { class: 'nav-label', text: n.label }), h('span', { class: 'nav-dot', hidden: true, 'aria-label': '有待办' }));
      links.set(n.id, a);
      return a;
    }),
  );
  const name = h('strong', { class: 'brand-name', text: S.agent?.name || 'vibefox' });
  const brand = h('a', { class: 'brand', href: '#/home' }, h('span', { class: 'brand-avatar', 'aria-hidden': 'true', text: '🦊' }), h('span', { class: 'brand-text' }, name, h('span', { class: 'brand-sub', text: '控制台' })));
  const side = h('aside', { class: 'side' }, brand, nav, h('p', { class: 'side-foot' }, icon('lock'), h('span', { text: '只在这台 Mac 上' })));
  const main = h('main', { id: 'main', class: 'main', tabindex: '-1' });
  const root = h('div', { class: 'shell' }, h('a', { class: 'skip', href: '#main', onclick: (e) => (e.preventDefault(), main.focus()) }, '跳到正文'), side, main);
  fill($app, root);
  S.shell = { root, main, links, name };
  return S.shell;
}

const VIEWS = {
  home: viewHome,
  resources: viewResources,
  money: viewMoney,
  chat: viewChat,
  brain: viewBrain,
  workers: viewWorkers,
  parent: viewParent,
};

const TITLES = { home: '首页', resources: '资源', money: '钱', chat: '对话', brain: '大脑', workers: 'Worker', parent: '家长' };

async function renderControl() {
  stopPolls();
  const view = ++S.view;
  const parts = routeParts();
  const section = VIEWS[parts[0]] ? parts[0] : 'home';
  const shell = ensureShell();
  for (const [id, a] of shell.links) {
    if (id === section) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  document.title = `${TITLES[section]} · ${S.agent?.name || 'vibefox'}`;
  const slow = setTimeout(() => view === S.view && fill(shell.main, skeletonPage()), 140);
  let node;
  try {
    node = await VIEWS[section](parts.slice(1), view);
  } catch (e) {
    node = e.status === 401 ? null : errorPanel(e, () => renderControl());
  }
  clearTimeout(slow);
  if (view !== S.view || !node) return;
  fill(shell.main, node);
  if (typeof node.vfAfter === 'function') node.vfAfter();
  else window.scrollTo(0, 0);
  // Keyboard users land on the new page's heading; with a mouse, a search box can take focus instead.
  const auto = finePointer() ? $('[data-autofocus]', node) : null;
  if (auto) auto.focus({ preventScroll: true });
  else if (S.navigated) $('h1', node)?.focus({ preventScroll: true });
  S.navigated = true;
  if (section !== 'home') overview().then(paintDots, () => {});
  else paintDots(S.overview);
}

function paintDots(ov) {
  if (!S.shell || !ov) return;
  const need = new Set();
  for (const s of ov.steps || []) if (!s.done && STEP_CTA[s.id]) need.add(STEP_CTA[s.id].nav);
  for (const [id, a] of S.shell.links) $('.nav-dot', a).hidden = !need.has(id);
  if (S.agent?.name) S.shell.name.textContent = S.agent.name;
}

function skeletonPage() {
  return h('div', { class: 'page', 'aria-busy': 'true' }, h('div', { class: 'skeleton title' }), h('div', { class: 'skeleton block' }), h('div', { class: 'skeleton block short' }));
}

function errorPanel(e, retry) {
  return h(
    'div',
    { class: 'page' },
    h('div', { class: 'card empty' }, h('span', { class: 'empty-icon bad' }, icon('alert')), h('h1', { tabindex: '-1', text: '这一页没打开' }), h('p', { class: 'muted', text: e.message }), btn('再试一次', { kind: 'primary', icon: 'refresh', onClick: retry })),
  );
}

function pageHead(title, sub, o = {}) {
  return h(
    'header',
    { class: 'page-head' },
    o.back ? h('a', { class: 'back', href: o.back.href }, icon('back'), h('span', { text: o.back.label })) : null,
    h('div', { class: 'page-head-row' }, h('div', { class: 'page-head-text' }, h('h1', { tabindex: '-1' }, title, o.badge || null), sub ? h('p', { class: 'lead', text: sub }) : null), o.actions ? h('div', { class: 'page-actions' }, o.actions) : null),
  );
}

function cardHead(title, right, sub) {
  return h('div', { class: 'card-head' }, h('div', {}, h('h2', { text: title }), sub ? h('p', { class: 'muted small', text: sub }) : null), right || null);
}

function scrollToId(id) {
  return () => {
    const el = document.getElementById(id);
    if (!el) return window.scrollTo(0, 0);
    el.scrollIntoView({ block: 'start' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1600);
  };
}

// ---------------- 首页 ----------------

const TASK_STATUS = {
  submitted: ['已收到', 'muted'],
  working: ['在做', 'info'],
  'input-required': ['等你回答', 'warn'],
  completed: ['完成', 'ok'],
  failed: ['失败', 'bad'],
  canceled: ['取消了', 'muted'],
};

async function viewHome() {
  const [ov, cat] = await Promise.all([overview(), catalog().catch(() => ({ groups: [], kinds: [] }))]);
  const a = ov.agent || {};
  const ready = ov.ready || {};
  const root = h('div', { class: 'page home' });

  const contact = (ic, value, display, what) =>
    value
      ? h('div', { class: 'contact' }, icon(ic), h('span', { class: 'mono', text: display }), copyBtn(value, what))
      : h('a', { class: 'contact missing', href: '#/resources' }, icon(ic), h('span', { text: `还没有${what}` }));
  const days = daysSince(a.bornAt);
  put(root,
    h(
      'section',
      { class: 'card hero' },
      h('div', { class: 'avatar', 'aria-hidden': 'true', text: initial(a.name) }),
      h(
        'div',
        { class: 'hero-body' },
        h('div', { class: 'hero-title' }, h('h1', { tabindex: '-1', text: a.name || '它' }), ready.canWork ? badge('能接任务', 'ok') : badge('还不能接任务', 'warn')),
        h('p', { class: 'muted', text: [a.parentName ? `家长 ${a.parentName}` : null, days ? `出生第 ${days} 天` : null].filter(Boolean).join(' · ') }),
        h('div', { class: 'contacts' }, contact('mail', a.email, a.email, '邮箱'), contact('phone', a.phone, fmtPhone(a.phone), '电话')),
      ),
    ),
  );

  if (!ready.canWork) {
    const missing = [];
    if (!ready.brain) missing.push(['大脑', '#/brain', '接上大脑']);
    if (!ready.channel) missing.push(['对话渠道', '#/chat', '连上 Telegram']);
    put(root,
      h(
        'section',
        { class: 'banner warn', 'aria-label': '还不能接任务' },
        h('span', { class: 'banner-icon' }, icon('alert')),
        h(
          'div',
          { class: 'banner-body' },
          h('strong', { text: `还差：${missing.map((m) => m[0]).join('、') || '一点点'}` }),
          h('p', { text: '它已经住下了，能收邮件和短信；但没有大脑它没法想事情，没有对话渠道它听不到你。' }),
        ),
        h(
          'div',
          { class: 'banner-actions' },
          missing.map((m, i) => btn(m[2], { kind: i === 0 ? 'primary' : 'secondary', href: m[1] })),
        ),
      ),
    );
  }

  const steps = ov.steps || [];
  // While the banner asks for the brain and Telegram, the checklist doesn't repeat them.
  const inBanner = new Set(ready.canWork ? [] : ['brain', 'telegram']);
  const todo = steps.filter((s) => !s.done && !inBanner.has(s.id));
  const done = steps.filter((s) => s.done);
  const quick = (need) =>
    cat.kinds
      .filter((k) => k.human === need)
      .slice(0, need === 'signup' ? 6 : 3)
      .map((k) => h('a', { class: 'chip link-chip', href: `#/resources/add/${encodeURIComponent(k.id)}` }, h('span', { text: k.label })));
  const stepRow = (s, i) => {
    const cta = STEP_CTA[s.id] || { label: '去看看', href: '#/home' };
    const chips = s.id === 'resources' ? quick('signup') : s.id === 'legal' ? quick('legal') : [];
    return h(
      'li',
      { class: 'step-row' },
      h('span', { class: 'step-num', text: String(i + 1) }),
      h('div', { class: 'step-text' }, h('strong', { text: s.title }), s.note ? h('p', { class: 'muted small', text: s.note }) : null, chips.length ? h('div', { class: 'chips' }, chips) : null),
      btn(cta.label, { kind: i === 0 ? 'primary' : 'secondary', size: 'sm', href: cta.href }),
    );
  };
  if (steps.length) {
    put(root,
      h(
        'section',
        { class: 'card', 'aria-labelledby': 'next-title' },
        h('div', { class: 'card-head' }, h('h2', { id: 'next-title', text: todo.length ? (inBanner.size ? '接下来' : '下一步') : '都齐了' }), h('div', { class: 'progress-wrap' }, h('span', { class: 'muted small', text: `${done.length} / ${steps.length}` }), h('progress', { max: String(steps.length), value: String(done.length), 'aria-label': '完成进度' }))),
        todo.length ? h('ol', { class: 'steps' }, todo.map(stepRow)) : h('p', { class: 'muted', text: inBanner.size ? '剩下的就是上面那两样。' : '它要的东西你都给了。之后它缺什么，会在 Telegram 里问你。' }),
        done.length ? h('details', { class: 'done-list' }, h('summary', { text: `已完成 ${done.length} 项` }), h('ul', {}, done.map((s) => h('li', {}, icon('check'), h('span', { text: s.title }))))) : null,
      ),
    );
  }

  const m = ov.money || {};
  const walletLabel = { open: ['Link 已连接', 'ok'], 'needs-parent': ['等你连接 Link', 'warn'], none: ['没有钱包', 'muted'] }[m.wallet] || ['没有钱包', 'muted'];
  const moneyCard = h(
    'section',
    { class: 'card' },
    cardHead('零花钱', btn('去钱页', { kind: 'ghost', size: 'sm', href: '#/money', trail: 'arrow' })),
    m.mandate
      ? h(
          'div',
          { class: 'money-sum' },
          h('div', { class: 'big-num' }, h('span', { text: fmtCents(m.spentThisMonthCents) }), h('span', { class: 'muted', text: ` / ${fmtCents(m.mandate.monthlyLimitCents)} 本月` })),
          h('progress', { max: String(m.mandate.monthlyLimitCents || 1), value: String(Math.min(m.spentThisMonthCents || 0, m.mandate.monthlyLimitCents || 0)), 'aria-label': '本月已花' }),
          h('div', { class: 'badges' }, badge(`单笔 ≤ ${fmtCents(m.mandate.perTransactionLimitCents)}`, 'muted'), badge(walletLabel[0], walletLabel[1]), m.frozen ? badge('已冻结', 'bad') : null),
        )
      : h('div', { class: 'money-sum' }, h('p', { class: 'muted', text: '还没有零花钱。连上 Link、签一份授权书，它就能在额度内自己买东西，花了告诉你。' }), h('div', { class: 'badges' }, badge(walletLabel[0], walletLabel[1]))),
  );

  const tasks = ov.recentTasks || [];
  const taskCard = h(
    'section',
    { class: 'card' },
    cardHead('最近的任务', ov.counts?.activeTasks ? badge(`${ov.counts.activeTasks} 个在做`, 'info') : null),
    tasks.length
      ? h(
          'ul',
          { class: 'rows' },
          tasks.slice(0, 6).map((t) => {
            const [label, tone] = TASK_STATUS[t.status] || [t.status, 'muted'];
            return h('li', { class: 'row' }, h('span', { class: 'row-title', text: t.title }), badge(label, tone));
          }),
        )
      : h('p', { class: 'muted', text: ready.canWork ? '还没有任务。在 Telegram 里给它发一句话，就是一个任务。' : '还没有任务。能接任务以后，在 Telegram 里给它发一句话就行。' }),
  );
  put(root, h('div', { class: 'grid2' }, moneyCard, taskCard));
  return root;
}

// ---------------- 资源 ----------------

const ORIGIN = { parent: ['你给的', 'accent'], self: ['它自己开的', 'info'] };
const ACCESS = { full: ['100% 权限', 'ok'], scoped: ['部分权限', 'muted'], read: ['只读', 'muted'], unknown: ['权限未知', 'muted'] };
const STATUS = { ok: ['已验证', 'ok'], unverified: ['没验证', 'muted'], failed: ['验证失败', 'bad'], pending: ['注册到一半', 'warn'] };
const METHOD = { token: 'Token', password: '账号密码', browser: '在它的浏览器里登好', file: '文件', none: '不需要凭证' };
const HUMAN = {
  signup: ['要你注册一次', 'accent', '只许真人注册的平台：你在它的浏览器里注册一次，交给它 100% 权限的 token 或账号密码。'],
  legal: ['要实名', 'warn', '要你的法律身份：登记人是你或你的公司，你同意一次。'],
  money: ['要钱', 'warn', '要你的钱：Link 钱包加上你签的零花钱授权书。'],
  key: ['要你账号里的 key', 'info', '你在这个服务注册、创建一个 key 交给它，之后它自己管。'],
  none: ['它自己能开', 'ok', '它用自己的邮箱和号码就能开，不需要你。'],
};
const humanOf = (k) => HUMAN[k?.human || 'none'] || HUMAN.none;

const kindOf = (cat, id) => cat.kinds.find((k) => k.id === id);
const isWalletKind = (k) => k.human === 'money' && (!k.methods || k.methods.length === 0);

function resBadges(r) {
  const out = [];
  if (STATUS[r.status]) out.push(badge(...STATUS[r.status]));
  if (ORIGIN[r.origin]) out.push(badge(...ORIGIN[r.origin]));
  if (ACCESS[r.access] && r.access !== 'unknown') out.push(badge(...ACCESS[r.access]));
  return out;
}

const KIND_ICONS = { agentmail: 'mail', email: 'mail', agentphone: 'phone', phone: 'phone', signing_key: 'key', ssh_key: 'key', link_wallet: 'wallet', wallet: 'wallet' };

function kindMark(label, group, kindId) {
  const ic = KIND_ICONS[kindId] || (group === 'brain' ? 'spark' : null);
  return h('span', { class: ['kind-mark', `g-${group || 'custom'}`], 'aria-hidden': 'true' }, ic ? icon(ic) : initial(label));
}

/** The second line of a resource row: its handle, or what it is waiting for. */
function resSubline(r) {
  if (r.handle) return /^\+\d{11,15}$/.test(r.handle) ? fmtPhone(r.handle) : r.handle;
  if (r.status === 'pending') return '注册到一半，点进去继续';
  if (r.status === 'failed') return r.lastError || '验证没通过';
  return METHOD[r.method] || '';
}

async function viewResources(parts, view) {
  if (parts[0] === 'add') return parts[1] ? viewAddFlow(parts[1], null, view) : viewPicker();
  if (parts[0]) return parts[1] === 'edit' ? viewAddFlow(null, parts[0], view) : viewDetail(parts[0]);
  const [cat, res] = await Promise.all([catalog(), api('/v1/control/resources')]);
  const list = res.resources || [];
  const root = h('div', { class: 'page' });
  const addBtn = btn('添加资源', { kind: 'primary', icon: 'plus', href: '#/resources/add' });
  const attention = list.filter((r) => r.status === 'failed' || r.status === 'pending').length;
  put(root, pageHead('资源', '它拥有或能用的一切：邮箱、号码、平台账号、token、数据库……凭证只在它自己的钥匙串里，这里看不到值。', { actions: addBtn }));
  if (attention) put(root, h('p', { class: 'note warn' }, icon('alert'), h('span', { text: `${attention} 个资源需要你看一眼。` })));
  if (!list.length) {
    put(root, h('div', { class: 'card empty' }, h('span', { class: 'empty-icon' }, icon('box')), h('h2', { text: '还没有资源' }), h('p', { class: 'muted', text: '先交给它一个只许真人注册的平台账号，比如 GitHub。' }), btn('添加资源', { kind: 'primary', icon: 'plus', href: '#/resources/add' })));
    return root;
  }
  const groupOf = (r) => kindOf(cat, r.kind)?.group || (r.source === 'identity' ? 'identity' : 'custom');
  const order = cat.groups.length ? cat.groups : [{ id: 'identity', label: '身份' }, { id: 'custom', label: '其他' }];
  const known = new Set(order.map((g) => g.id));
  for (const g of [...order, { id: '_other', label: '其他' }]) {
    const rows = list.filter((r) => (g.id === '_other' ? !known.has(groupOf(r)) : groupOf(r) === g.id));
    if (!rows.length) continue;
    put(root,
      h(
        'section',
        { class: 'card group-card', 'aria-label': g.label },
        cardHead(g.label, h('span', { class: 'muted small', text: `${rows.length} 个` })),
        h(
          'ul',
          { class: 'res-list' },
          rows.map((r) => {
            const k = kindOf(cat, r.kind);
            return h(
              'li',
              {},
              h(
                'a',
                { class: 'res-row', href: `#/resources/${encodeURIComponent(r.id)}` },
                kindMark(k?.label || r.label, k?.group || g.id, r.kind),
                h('span', { class: 'res-text' }, h('span', { class: 'res-label', text: r.label || k?.label || r.id }), h('span', { class: ['res-handle', r.handle && 'mono'], text: resSubline(r) })),
                h('span', { class: 'badges' }, resBadges(r)),
                icon('arrow', 'res-go'),
              ),
            );
          }),
        ),
      ),
    );
  }
  return root;
}

async function viewPicker() {
  const [cat, res] = await Promise.all([catalog(), api('/v1/control/resources')]);
  const have = new Set((res.resources || []).filter((r) => r.status === 'ok').map((r) => r.kind));
  const root = h('div', { class: 'page' });
  put(root,
    pageHead('添加资源', '只有人能给的根：钱、法律身份、只许真人注册的平台、你账号里的 key。有了这些，它自己能在里面开别的（仓库、数据库、域名邮箱……）。', { back: { href: '#/resources', label: '资源' } }),
  );
  const F = { q: '', group: 'all' };
  const search = input({ type: 'search', placeholder: '搜：GitHub、数据库、域名、收款…', 'aria-label': '搜索资源', class: 'input search-input', 'data-autofocus': true });
  const groups = cat.groups.filter((g) => cat.kinds.some((k) => k.group === g.id));
  const chips = h(
    'div',
    { class: 'chips filter', role: 'group', 'aria-label': '按类别筛选' },
    [{ id: 'all', label: '全部' }, ...groups].map((g) =>
      chip(
        g.label,
        g.id === F.group,
        (_v, c) => {
          F.group = g.id;
          for (const x of chips.children) x.setAttribute('aria-pressed', String(x === c));
          paint();
        },
        { radio: true },
      ),
    ),
  );
  const results = h('div', { class: 'picker-results', 'aria-live': 'polite' });
  search.addEventListener('input', () => {
    F.q = search.value.trim().toLowerCase();
    paint();
  });
  put(root, h('div', { class: 'picker-bar' }, h('div', { class: 'search' }, icon('search'), search), chips), results);

  const text = (k) => [k.id, k.label, ...(k.unlocks || []), ...(k.agentCreates || []), k.notes || '', humanOf(k)[0]].join(' ').toLowerCase();
  function paint() {
    const match = cat.kinds.filter((k) => (F.group === 'all' || k.group === F.group) && (!F.q || text(k).includes(F.q)));
    fill(results);
    if (!match.length) {
      const custom = cat.kinds.find((k) => k.group === 'custom');
      put(results, h('div', { class: 'card empty' }, h('h2', { text: '没找到' }), h('p', { class: 'muted', text: '换个词试试，或者加一个自定义资源。' }), custom ? btn(`添加${custom.label}`, { kind: 'primary', href: `#/resources/add/${encodeURIComponent(custom.id)}` }) : null));
      return;
    }
    for (const g of cat.groups) {
      const ks = match.filter((k) => k.group === g.id);
      if (!ks.length) continue;
      put(results,
        h(
          'section',
          { class: 'kind-group', 'aria-label': g.label },
          h('h2', { class: 'group-title', text: g.label }),
          h(
            'div',
            { class: 'kind-grid' },
            ks.map((k) => {
              const [need, tone] = humanOf(k);
              return h(
                'a',
                { class: 'kind-card', href: `#/resources/add/${encodeURIComponent(k.id)}` },
                h('div', { class: 'kind-top' }, kindMark(k.label, k.group, k.id), h('strong', { class: 'kind-name', text: k.label }), have.has(k.id) ? h('span', { class: 'have', 'aria-label': '已经有了' }, icon('check')) : null),
                h('div', { class: 'badges' }, badge(need, tone)),
                k.unlocks?.length ? h('p', { class: 'kind-unlocks muted small', text: `能：${k.unlocks.slice(0, 3).join('、')}` }) : null,
              );
            }),
          ),
        ),
      );
    }
  }
  paint();
  return root;
}

// ---------------- the guided add flow ----------------

const DEFAULT_TOTP_HELP = '在两步验证设置里选"验证器 app"，点"手动输入/看不到二维码"，把那串密钥（不是 6 位数）贴在这里。以后验证码它自己算。';

async function viewAddFlow(kindId, editId, view) {
  const [cat, res, ov, browser] = await Promise.all([catalog(), api('/v1/control/resources'), S.overview ? Promise.resolve(S.overview) : overview(), api('/v1/control/browser').catch(() => ({ active: false }))]);
  const resources = res.resources || [];
  const editing = editId ? resources.find((r) => r.id === editId) : null;
  if (editId && !editing) return notFound('没有这个资源', '#/resources');
  const kind = kindOf(cat, editing ? editing.kind : kindId);
  if (!kind) return notFound('没有这种资源', '#/resources/add');
  if (isWalletKind(kind)) {
    location.replace('#/money');
    return null;
  }
  const draft = editing || resources.find((r) => r.kind === kind.id && r.status === 'pending');
  const agent = ov.agent || {};
  const F = {
    kind,
    editing,
    draftId: draft ? draft.id : null,
    password: S.drafts.get(kind.id) || null,
    draftHasPassword: Boolean(draft?.hasSecret?.password),
    browser: { active: Boolean(browser.active), url: browser.url || '' },
    startedHere: false,
    method: null,
    values: {},
    access: editing && editing.access !== 'unknown' ? editing.access : 'full',
    since: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
    codes: [],
    codesLoaded: false,
    seen: new Set(),
  };
  const methods = kind.methods || [];
  F.method = methods.includes('token') && F.password ? 'token' : methods[0] || null;

  const [need, needTone, needText] = humanOf(kind);
  const root = h('div', { class: 'page flow' });
  put(root,
    pageHead(editing ? `更换凭证：${editing.label || kind.label}` : `添加 ${kind.label}`, null, {
      back: editing ? { href: `#/resources/${encodeURIComponent(editing.id)}`, label: editing.label || kind.label } : { href: '#/resources/add', label: '添加资源' },
      badge: badge(need, needTone),
    }),
  );
  if (!editing) {
    put(root,
      h(
        'section',
        { class: 'card intro' },
        h('p', { text: needText }),
        kind.unlocks?.length ? h('div', { class: 'unlocks' }, h('span', { class: 'muted small', text: '有了它，它能：' }), h('div', { class: 'chips' }, kind.unlocks.map((u) => h('span', { class: 'chip static', text: u })))) : null,
        kind.agentCreates?.length ? h('p', { class: 'muted small', text: `之后它自己能在里面开：${kind.agentCreates.join('、')}` }) : null,
        kind.notes ? h('p', { class: 'note' }, icon('alert'), h('span', { text: kind.notes })) : null,
      ),
    );
    // Already has one: say so, and offer to fix a broken one instead of quietly adding a second.
    const same = resources.filter((r) => r.kind === kind.id && r.source !== 'identity' && r.status !== 'pending');
    if (same.length) {
      put(
        root,
        h(
          'div',
          { class: 'have-list' },
          same.map((r) =>
            h(
              'div',
              { class: ['note', r.status === 'failed' ? 'bad' : r.status === 'ok' ? 'ok' : ''] },
              icon(r.status === 'failed' ? 'alert' : 'check'),
              h('span', {}, '已经有了：', h('strong', { text: r.label || kind.label }), r.handle ? h('span', { class: 'mono', text: ` · ${r.handle}` }) : null, `（${STATUS[r.status]?.[0] || r.status}）。`, r.status === 'failed' ? '可以直接换个凭证，' : '', '下面会再加一个新的。'),
              r.status === 'failed' ? btn('更换凭证', { kind: 'primary', size: 'sm', href: `#/resources/${encodeURIComponent(r.id)}/edit` }) : btn('看看它', { kind: 'ghost', size: 'sm', href: `#/resources/${encodeURIComponent(r.id)}` }),
            ),
          ),
        ),
      );
    }
  }

  const bar = h('div', { class: 'browser-bar', hidden: true, role: 'status' });
  put(root, bar);
  function paintBar() {
    bar.hidden = !F.browser.active;
    if (!F.browser.active) return fill(bar);
    const close = btn('关掉它的浏览器窗口', { kind: 'ghost', size: 'sm' });
    close.addEventListener('click', () =>
      busy(close, async () => {
        await post('/v1/control/browser/finish');
        F.browser = { active: false, url: '' };
        paintBar();
        toast('关好了，登录状态留在它的浏览器里');
      }),
    );
    fill(bar, h('span', { class: 'live-dot', 'aria-hidden': 'true' }), h('span', { class: 'browser-bar-text' }, '它的浏览器正开着给你用', F.browser.url ? h('span', { class: 'mono muted', text: ` · ${shortUrl(F.browser.url)}` }) : null, h('span', { class: 'muted', text: '（这期间 worker 用不了浏览器）' })), close);
  }
  paintBar();

  async function openInAgentBrowser(url) {
    const safe = safeUrl(url);
    if (!safe) throw new Error('这个链接打不开');
    await post('/v1/control/browser/start', { url: safe });
    F.browser = { active: true, url: safe };
    F.startedHere = true;
    paintBar();
    toast(`在它的浏览器里打开了 ${shortUrl(safe)}`);
  }

  async function ensurePassword() {
    if (F.password) return F.password;
    const r = await post('/v1/control/resources/draft', { kind: kind.id });
    F.password = r.password;
    F.draftId = r.resource?.id || F.draftId;
    F.draftHasPassword = true;
    S.drafts.set(kind.id, r.password);
    return r.password;
  }

  const sections = [];
  const legal = kind.human === 'legal' && !editing;
  const signup = kind.human === 'signup' && !editing && (kind.signupUrl || kind.loginUrl);
  if (legal) sections.push(await legalStep());
  if (signup) sections.push(signupStep(), codesStep());
  else if (!editing && (kind.human === 'legal' || kind.human === 'key' || kind.human === 'money') && (kind.signupUrl || kind.loginUrl)) sections.push(accountStep());
  else if (!editing && !kind.human) sections.push(selfStep());
  if (methods.length) sections.push(handoverStep());
  sections.forEach((s, i) => {
    const num = $('.flow-num', s);
    if (num) num.textContent = String(i + 1);
    put(root, s);
  });

  function stepShell(id, title, sub, ...body) {
    return h('section', { class: 'card flow-step', id, 'aria-labelledby': `${id}-title` }, h('header', { class: 'flow-head' }, h('span', { class: 'flow-num', 'aria-hidden': 'true' }), h('div', {}, h('h2', { id: `${id}-title`, text: title }), sub ? h('p', { class: 'muted', text: sub }) : null)), ...body);
  }

  // ① sign up as itself, in its own browser
  function signupStep() {
    const creds = h('div', { class: 'vlines' });
    const status = h('div', { class: 'flow-status', role: 'status' });
    const err = errBox();
    const open = btn(kind.signupUrl ? '在它的浏览器里打开注册页' : '在它的浏览器里打开登录页', { kind: 'primary', size: 'lg', icon: 'globe' });
    open.addEventListener('click', () =>
      busy(
        open,
        async () => {
          await ensurePassword();
          paintCreds();
          await openInAgentBrowser(kind.signupUrl || kind.loginUrl);
          fill(status, icon('check'), h('span', { text: '已经打开了——Mac 上那个新窗口就是它的浏览器。用上面的邮箱、电话和密码填表；验证码会出现在下面。' }));
          status.classList.add('ok');
          setLabel(open, '再打开一次注册页');
        },
        err,
      ),
    );
    const login = kind.signupUrl && kind.loginUrl ? btn('已经有账号了？在它的浏览器里登录', { kind: 'ghost' }) : null;
    login?.addEventListener('click', () => busy(login, () => openInAgentBrowser(kind.loginUrl), err));

    function paintCreds() {
      const pw = F.password;
      const pwRow = pw
        ? h('div', { class: 'vline' }, h('span', { class: 'vline-icon' }, icon('lock')), h('span', { class: 'vline-label', text: '密码' }), maskedValue(pw), copyBtn(pw, '密码'))
        : h(
            'div',
            { class: 'vline' },
            h('span', { class: 'vline-icon' }, icon('lock')),
            h('span', { class: 'vline-label', text: '密码' }),
            h('span', { class: 'vline-value muted', text: F.draftHasPassword ? '生成过了，已存进它的钥匙串（这里不再显示）' : '点一下就生成一个强密码，先存进它的钥匙串' }),
            genBtn(),
          );
      fill(creds,
        agent.email ? h('div', { class: 'vline' }, h('span', { class: 'vline-icon' }, icon('mail')), h('span', { class: 'vline-label', text: '邮箱' }), h('span', { class: 'vline-value mono', text: agent.email }), copyBtn(agent.email, '邮箱')) : h('div', { class: 'vline' }, h('span', { class: 'vline-icon' }, icon('mail')), h('span', { class: 'vline-label', text: '邮箱' }), h('span', { class: 'vline-value muted', text: '它还没有邮箱' })),
        agent.phone ? h('div', { class: 'vline' }, h('span', { class: 'vline-icon' }, icon('phone')), h('span', { class: 'vline-label', text: '电话' }), h('span', { class: 'vline-value mono', text: fmtPhone(agent.phone) }), copyBtn(agent.phone, '电话')) : null,
        pwRow,
      );
    }
    function genBtn() {
      const b = btn(F.draftHasPassword ? '重新生成' : '生成并保存密码', { kind: 'secondary', size: 'sm' });
      b.addEventListener('click', () =>
        busy(
          b,
          async () => {
            F.password = null;
            await ensurePassword();
            paintCreds();
            toast('密码生成好了，已存进它的钥匙串');
          },
          err,
        ),
      );
      return b;
    }
    paintCreds();
    return stepShell(
      'step-signup',
      `用它自己的身份注册 ${kind.label}`,
      '在它的浏览器里注册（Mac 上会弹出它的浏览器窗口）。表单里填它的邮箱、电话和下面的密码；遇到验证码（CAPTCHA）你来点——它从不绕过。',
      creds,
      err,
      h('div', { class: 'actions' }, open, login),
      status,
    );
  }

  // ② the codes and links it receives, live
  function codesStep() {
    const list = h('ul', { class: 'codes' });
    const live = h('span', { class: 'live' }, h('span', { class: 'live-dot', 'aria-hidden': 'true' }), h('span', { text: '实时' }));
    const sec = stepShell('step-codes', '它收到的验证码和验证链接', '注册页发了验证邮件或短信，几秒内就出现在这里。', list);
    put($('.flow-head', sec), live);
    function paint() {
      if (!F.codes.length) {
        fill(list, h('li', { class: 'codes-empty' }, spinner(), h('span', { class: 'muted', text: `还没收到。正在听 ${agent.email || '它的邮箱'}${agent.phone ? ` 和 ${fmtPhone(agent.phone)}` : ''}……` })));
        return;
      }
      fill(list, ...F.codes.map(codeItem));
    }
    function codeItem(c) {
      const key = `${c.at}|${c.from}|${c.code || ''}|${c.link || ''}`;
      // Only codes that arrive while the page is open get the arrival highlight.
      const fresh = F.codesLoaded && !F.seen.has(key);
      F.seen.add(key);
      const link = c.link ? safeUrl(c.link) : null;
      const openLink = link ? btn('在它的浏览器里打开', { kind: 'primary', size: 'sm', icon: 'globe' }) : null;
      openLink?.addEventListener('click', () => busy(openLink, () => openInAgentBrowser(link)));
      return h(
        'li',
        { class: ['code-item', fresh && 'fresh'] },
        h('div', { class: 'code-meta' }, badge(c.channel === 'sms' ? '短信' : '邮件', c.channel === 'sms' ? 'info' : 'muted'), h('span', { class: 'code-from', text: c.from || '' }), h('time', { class: 'muted small', datetime: c.at, text: ago(c.at) })),
        c.subject ? h('p', { class: 'code-subject', text: c.subject }) : null,
        c.code ? h('div', { class: 'code-main' }, h('span', { class: 'otp mono', text: c.code }), copyBtn(c.code, '验证码', { kind: 'secondary' })) : null,
        link ? h('div', { class: 'code-link' }, openLink, h('span', { class: 'mono muted small ellipsis', text: shortUrl(link) })) : null,
      );
    }
    async function load() {
      const r = await api(`/v1/control/codes?since=${encodeURIComponent(F.since)}`);
      const items = (r.items || []).slice().sort((a, b) => String(b.at).localeCompare(String(a.at)));
      const sig = (xs) => xs.map((c) => `${c.at}|${c.code || ''}|${c.link || ''}`).join(',');
      if (sig(items) !== sig(F.codes)) {
        F.codes = items;
        paint();
      }
      F.codesLoaded = true;
    }
    paint();
    load().catch(() => {});
    poll(load, 3000);
    return sec;
  }

  // for keys, legal accounts and money: the parent's own account at the provider
  function accountStep() {
    const err = errBox();
    const url = kind.signupUrl || kind.loginUrl;
    const inAgent = btn('在它的浏览器里打开', { kind: 'primary', icon: 'globe' });
    inAgent.addEventListener('click', () => busy(inAgent, () => openInAgentBrowser(url), err));
    const title = kind.human === 'legal' ? `用你的身份注册 ${kind.label}，完成实名` : `在 ${kind.label} 注册，创建一个 key`;
    const sub = kind.human === 'legal' ? '这是你的账号：用你自己的邮箱注册、做实名认证（KYC）。做完再回来这里交给它。' : '用你自己的账号注册或登录，然后创建一个 key 交给它。';
    return stepShell('step-account', title, sub, err, h('div', { class: 'actions' }, inAgent, btn('用我自己的浏览器打开', { kind: 'ghost', href: safeUrl(url) || '#', trail: 'ext' })));
  }

  function selfStep() {
    return stepShell('step-self', '它自己就能开', '这个服务允许 agent 用自己的邮箱和号码注册。在 Telegram 里跟它说一声，它自己去办；遇到验证码会停下来找你。', methods.length ? h('p', { class: 'muted small', text: '如果你已经有现成的凭证，也可以直接在下面交给它。' }) : null);
  }

  // ① for legal kinds: the registrant, filled once
  async function legalStep() {
    const parent = await api('/v1/control/parent');
    const sec = stepShell('step-legal', '登记人（你）', '要实名的东西用你（或你的公司）的名义登记。填一次、同意一次，以后都用这份。');
    const body = h('div', {});
    put(sec, body);
    const paint = (editingForm) => {
      if (parent.legal && !editingForm) {
        fill(body, legalSummary(parent.legal), h('div', { class: 'actions' }, btn('改登记信息', { kind: 'ghost', size: 'sm', onClick: () => paint(true) })));
      } else {
        fill(body,
          legalForm(parent, (legal) => {
            parent.legal = legal;
            paint(false);
            toast('登记人存好了');
            $('#step-handover, #step-account')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
          }),
        );
      }
    };
    paint(false);
    return sec;
  }

  // ③ hand over a credential, verified on the spot
  function handoverStep() {
    const body = h('div', { class: 'handover' });
    const result = h('div', { class: 'result', role: 'status', 'aria-live': 'polite' });
    const sec = stepShell('step-handover', editing ? '交给它新的凭证' : '交给它', '最好是 100% 权限的凭证：这样它才能自己在里面开东西。交完当场验证。', body, result);
    const tabLabels = { token: 'Token', password: '账号密码', browser: '我已在它的浏览器里登好', file: '文件' };
    const tabIcons = { token: 'key', password: 'lock', browser: 'globe', file: 'file' };
    const tabs = methods.length > 1 ? seg(methods.map((m) => ({ value: m, label: tabLabels[m] || m, icon: tabIcons[m] })), F.method, (m) => ((F.method = m), paint()), { label: '怎么交给它' }) : null;
    const panel = h('div', { class: 'method-panel' });
    const err = errBox();
    const accessSeg = seg(
      [
        { value: 'full', label: '100% 权限' },
        { value: 'scoped', label: '部分' },
        { value: 'read', label: '只读' },
      ],
      F.access,
      (v) => (F.access = v),
      { label: '这个凭证的权限', small: true },
    );
    const submit = btn('交给它并验证', { kind: 'primary', size: 'lg', icon: 'check' });
    submit.addEventListener('click', () => busy(submit, save, err));
    put(body, tabs, panel, h('div', { class: 'access-row' }, h('span', { class: 'muted small', text: '这个凭证的权限' }), accessSeg), err, h('div', { class: 'actions' }, submit));

    let inputs = {};
    function paint() {
      inputs = {};
      const m = F.method;
      const fields = kind.fields?.[m] || [];
      const kids = [];
      if (m === 'token' && kind.tokenUrl) {
        const open = btn('打开 token 页（已勾好全部权限）', { kind: 'secondary', icon: 'globe' });
        open.addEventListener('click', () => busy(open, () => openInAgentBrowser(kind.tokenUrl), err));
        kids.push(h('div', { class: 'actions tight' }, open, btn('用我自己的浏览器打开', { kind: 'ghost', size: 'sm', href: safeUrl(kind.tokenUrl) || '#', trail: 'ext' })));
      }
      if (kind.fullPowerHint && (m === 'token' || m === 'file')) kids.push(h('p', { class: 'note' }, icon('key'), h('span', { text: kind.fullPowerHint })));
      if (m === 'password' && (agent.email || F.password)) kids.push(h('p', { class: 'muted small', text: F.password ? '已经填好它的邮箱和刚才生成的密码。' : '已经填好它的邮箱。' }));
      if (m === 'browser') {
        kids.push(h('p', { class: 'muted', text: `在它的浏览器里登录 ${kind.label}，登好以后点下面的按钮。登录状态（cookie）留在它自己的浏览器资料里，以后它自己用。` }));
        const url = kind.loginUrl || kind.signupUrl;
        if (url) {
          const open = btn('在它的浏览器里打开登录页', { kind: 'secondary', icon: 'globe' });
          open.addEventListener('click', () => busy(open, () => openInAgentBrowser(url), err));
          kids.push(h('div', { class: 'actions tight' }, open));
        }
      }
      for (const f of fields) kids.push(fieldFor(f, m));
      fill(panel, ...kids);
      setLabel(submit, m === 'browser' ? '我已在它的浏览器里登好' : '交给它并验证');
    }

    function fieldFor(f, m) {
      let prefill = F.values[`${m}.${f.id}`];
      if (prefill == null && m === 'password' && /^(username|email|login|user)$/i.test(f.id) && agent.email) prefill = agent.email;
      if (prefill == null && m === 'password' && f.id === 'password' && F.password) prefill = F.password;
      const remember = (v) => (F.values[`${m}.${f.id}`] = v);
      if (f.kind === 'file') {
        const fileField = dropZone(f, prefill, remember);
        inputs[f.id] = fileField;
        return fileField.node;
      }
      const props = { placeholder: f.placeholder || (f.kind === 'totp' ? 'JBSWY3DPEHPK3PXP' : ''), value: prefill || '' };
      const control = f.secret || f.kind === 'password' || f.kind === 'totp' ? secretInput(props) : input({ ...props, type: f.kind === 'url' ? 'url' : 'text' });
      const el = control.matches('input') ? control : $('input', control);
      el.addEventListener('input', () => remember(el.value));
      inputs[f.id] = { get: () => el.value.trim(), focus: () => el.focus() };
      return field(f.label, control, { optional: f.optional, help: f.help || (f.kind === 'totp' ? DEFAULT_TOTP_HELP : null) });
    }

    async function save() {
      const m = F.method;
      const fields = kind.fields?.[m] || [];
      const values = {};
      for (const f of fields) {
        const v = inputs[f.id]?.get() || '';
        if (!v && !f.optional) {
          inputs[f.id]?.focus();
          throw new Error(`请填上${f.label}`);
        }
        if (v) values[f.id] = v;
      }
      const reqBody = { kind: kind.id, method: m, fields: values, access: F.access };
      if (F.draftId) reqBody.id = F.draftId;
      const r = await post('/v1/control/resources', reqBody);
      const saved = r.resource || {};
      F.draftId = saved.id || F.draftId;
      if (saved.status === 'ok') S.drafts.delete(kind.id);
      if (saved.status === 'ok' && F.startedHere && F.browser.active) {
        await post('/v1/control/browser/finish').catch(() => {});
        F.browser = { active: false, url: '' };
        F.closedBrowser = true;
        paintBar();
      }
      paintResult(saved);
    }

    function paintResult(r) {
      const go = btn('看看它', { kind: 'primary', href: `#/resources/${encodeURIComponent(r.id)}`, trail: 'arrow' });
      if (r.status === 'ok') {
        fill(result,
          h(
            'div',
            { class: 'result-box ok' },
            h('span', { class: 'result-icon' }, icon('check')),
            h('div', {}, h('strong', { text: '验证通过' }), h('p', {}, r.handle ? h('span', { class: 'mono', text: r.handle }) : null, r.handle ? ' · ' : null, ACCESS[r.access]?.[0] || ''), kind.unlocks?.length ? h('p', { class: 'muted small', text: `它现在能：${kind.unlocks.join('、')}` }) : null, F.closedBrowser ? h('p', { class: 'muted small', text: '它的浏览器窗口关好了，登录状态留着；worker 又能用浏览器了。' }) : null),
            h('div', { class: 'actions tight' }, go, btn('再添加一个', { kind: 'ghost', href: '#/resources/add' })),
          ),
        );
      } else if (r.status === 'failed') {
        fill(result, h('div', { class: 'result-box bad' }, h('span', { class: 'result-icon' }, icon('alert')), h('div', {}, h('strong', { text: '没通过验证' }), h('p', { text: r.lastError || '这个凭证不能用。' }), h('p', { class: 'muted small', text: '改一下再点一次就行，已经存下的会被替换。' }))));
      } else {
        fill(result, h('div', { class: 'result-box' }, h('span', { class: 'result-icon' }, icon('check')), h('div', {}, h('strong', { text: '存好了' }), h('p', { class: 'muted', text: kind.verifiable ? '还没验证，可以在详情页里再验证一次。' : '这个平台没法当场验证；它第一次用的时候会告诉你行不行。' })), h('div', { class: 'actions tight' }, go)));
      }
      result.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    paint();
    return sec;
  }

  root.vfAfter = () => {
    window.scrollTo(0, 0);
    if (legal) return;
    if (editing) $('#step-handover input')?.focus({ preventScroll: true });
  };
  return root;
}

function maskedValue(value) {
  const shown = h('span', { class: 'mono masked', text: '•'.repeat(Math.min(16, value.length)) });
  const t = h('button', { type: 'button', class: 'reveal inline', 'aria-label': '显示密码', 'aria-pressed': 'false' }, icon('eye'));
  t.addEventListener('click', () => {
    const show = t.getAttribute('aria-pressed') !== 'true';
    shown.textContent = show ? value : '•'.repeat(Math.min(16, value.length));
    shown.classList.toggle('masked', !show);
    t.setAttribute('aria-pressed', String(show));
    t.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
  });
  return h('span', { class: 'vline-value with-reveal' }, shown, t);
}

/** Drag-drop (or pick) a JSON file such as a GCP service-account key. Read locally, sent as the field value. */
function dropZone(f, prefill, remember) {
  let value = prefill || '';
  const fileIn = h('input', { type: 'file', accept: '.json,application/json', class: 'sr-only', id: `f${++fieldSeq}` });
  const info = h('span', { class: 'drop-info' });
  const err = errBox();
  const zone = h('label', { class: 'drop', for: fileIn.id }, icon('file'), h('span', { class: 'drop-text', text: '把 JSON 文件拖到这里，或者点一下选文件' }), info);
  const show = (name, size, parsed) => {
    fill(info, icon('check'), h('span', { class: 'mono', text: name }), h('span', { class: 'muted small', text: ` · ${Math.ceil(size / 1024)} KB${parsed?.client_email ? ` · ${parsed.client_email}` : ''}` }));
    zone.classList.add('has-file');
  };
  if (value) show('已选好的文件', value.length);
  const read = (file) => {
    showErr(err, '');
    if (!file) return;
    if (file.size > 900 * 1024) return showErr(err, '文件太大了（上限 900 KB）');
    const r = new FileReader();
    r.onload = () => {
      const text = String(r.result || '');
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return showErr(err, '这不是有效的 JSON 文件');
      }
      value = text;
      remember(text);
      show(file.name, file.size, parsed);
    };
    r.onerror = () => showErr(err, '读不了这个文件');
    r.readAsText(file);
  };
  fileIn.addEventListener('change', () => read(fileIn.files?.[0]));
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    read(e.dataTransfer?.files?.[0]);
  });
  const node = h('div', { class: 'field' }, h('span', { class: 'field-label' }, f.label, f.optional ? h('span', { class: 'optional', text: '可选' }) : null), fileIn, zone, f.help ? h('p', { class: 'field-help', text: f.help }) : null, err);
  return { node, get: () => value, focus: () => zone.focus() };
}

function notFound(text, back) {
  return h('div', { class: 'page' }, h('div', { class: 'card empty' }, h('h1', { tabindex: '-1', text }), btn('回去', { kind: 'primary', href: back, icon: 'back' })));
}

// ---------------- resource detail ----------------

async function viewDetail(id) {
  const [cat, res] = await Promise.all([catalog(), api('/v1/control/resources')]);
  const list = res.resources || [];
  let r = list.find((x) => x.id === id);
  if (!r) return notFound('没有这个资源', '#/resources');
  const k = kindOf(cat, r.kind);
  const root = h('div', { class: 'page' });
  const card = h('section', { class: 'card detail' });
  const err = errBox();
  put(root, pageHead(r.label || k?.label || r.id, k ? `${k.label} · ${cat.groups.find((g) => g.id === k.group)?.label || ''}` : null, { back: { href: '#/resources', label: '资源' } }), card);

  function paint() {
    const parent = r.parent ? list.find((x) => x.id === r.parent) : null;
    const children = list.filter((x) => x.parent === r.id);
    const secretNames = Object.keys(r.hasSecret || {}).length ? Object.keys(r.hasSecret) : r.secretFields || [];
    const fieldLabel = (fid) => Object.values(k?.fields || {}).flat().find((f) => f.id === fid)?.label || fid;
    const rows = [
      ['名字', r.handle ? h('span', { class: 'mono', text: r.handle }) : h('span', { class: 'muted', text: '—' })],
      ['怎么交给它的', METHOD[r.method] || r.method],
      ['来源', ORIGIN[r.origin]?.[0] || r.origin],
      ['权限', ACCESS[r.access]?.[0] || r.access],
      ['加于', [fmtTime(r.addedAt), r.addedBy === 'agent' ? '它自己加的' : '你加的'].filter(Boolean).join(' · ')],
      r.verifiedAt ? ['上次验证', fmtTime(r.verifiedAt)] : null,
      parent ? ['建在', h('a', { class: 'link', href: `#/resources/${encodeURIComponent(parent.id)}`, text: parent.label || parent.id })] : r.parent ? ['建在', r.parent] : null,
      ...Object.entries(r.fields || {}).map(([fk, fv]) => [fieldLabel(fk), h('span', { class: 'mono', text: String(fv) })]),
      ...secretNames.map((s) => [fieldLabel(s), r.hasSecret?.[s] === false ? h('span', { class: 'muted', text: '没有' }) : h('span', { class: 'secret-ok' }, icon('lock'), h('span', { text: '存在它的钥匙串里（看不到值）' }))]),
    ].filter(Boolean);
    const verify = btn('重新验证', { kind: 'secondary', icon: 'refresh' });
    verify.addEventListener('click', () =>
      busy(
        verify,
        async () => {
          r = (await post(`/v1/control/resources/${encodeURIComponent(r.id)}/verify`)).resource || r;
          paint();
          toast(r.status === 'ok' ? '验证通过' : r.status === 'failed' ? '没通过验证' : '验证完了', r.status === 'failed' ? 'bad' : undefined);
        },
        err,
      ),
    );
    const del = btn('移除', { kind: 'danger-ghost', icon: 'x' });
    let armed = false;
    del.addEventListener('click', () => {
      if (!armed) {
        armed = true;
        setLabel(del, `确定移除？凭证也会删掉`);
        del.classList.add('armed');
        setTimeout(() => {
          if (!del.isConnected) return;
          armed = false;
          setLabel(del, '移除');
          del.classList.remove('armed');
        }, 4000);
        return;
      }
      busy(
        del,
        async () => {
          await post(`/v1/control/resources/${encodeURIComponent(r.id)}/delete`);
          toast(`移除了 ${r.label || r.id}`);
          location.hash = '#/resources';
        },
        err,
      );
    });
    const isRes = r.source !== 'identity';
    fill(card,
      h('div', { class: 'detail-top' }, kindMark(k?.label || r.label, k?.group || (r.source === 'identity' ? 'identity' : null), r.kind), h('div', { class: 'badges' }, resBadges(r))),
      r.status === 'pending'
        ? h('div', { class: 'note warn' }, icon('alert'), h('span', { text: '注册到一半：密码已经生成并存好了。' }), btn('继续注册', { kind: 'primary', size: 'sm', href: `#/resources/add/${encodeURIComponent(r.kind)}` }))
        : null,
      r.status === 'failed' && r.lastError ? h('div', { class: 'note bad' }, icon('alert'), h('span', { text: r.lastError })) : null,
      h('dl', { class: 'facts' }, rows.map(([dt, dd]) => [h('dt', { text: dt }), h('dd', {}, dd)])),
      r.note ? h('p', { class: 'muted', text: r.note }) : null,
      children.length
        ? h('div', { class: 'children' }, h('h3', { text: '它在这上面开的' }), h('ul', { class: 'res-list compact' }, children.map((c) => h('li', {}, h('a', { class: 'res-row', href: `#/resources/${encodeURIComponent(c.id)}` }, kindMark(c.label, k?.group, c.kind), h('span', { class: 'res-text' }, h('span', { class: 'res-label', text: c.label || c.id }), h('span', { class: ['res-handle', c.handle && 'mono'], text: resSubline(c) })), h('span', { class: 'badges' }, resBadges(c)))))))
        : null,
      isRes
        ? h(
            'div',
            { class: 'worker-use' },
            h('p', { class: 'muted small', text: 'worker 这样取用（每次取用都进审计日志）：' }),
            cmdLine(`vf resource get ${r.id}`),
            k?.workerEnv && Object.keys(k.workerEnv).length ? h('p', { class: 'muted small' }, '也会作为环境变量交给 worker：', Object.keys(k.workerEnv).map((e) => h('code', { class: 'env', text: e }))) : null,
          )
        : null,
      err,
      h('div', { class: 'actions' }, r.status !== 'pending' && k?.verifiable ? verify : null,isRes && k?.methods?.length ? btn('更换凭证', { kind: 'secondary', icon: 'key', href: `#/resources/${encodeURIComponent(r.id)}/edit` }) : null, isRes ? del : null),
    );
  }
  paint();
  return root;
}

// ---------------- 家长 and the legal profile ----------------

const COUNTRIES = [
  ['US', '美国'],
  ['CA', '加拿大'],
  ['CN', '中国'],
  ['HK', '中国香港'],
  ['TW', '中国台湾'],
  ['SG', '新加坡'],
  ['JP', '日本'],
  ['GB', '英国'],
  ['DE', '德国'],
  ['FR', '法国'],
  ['AU', '澳大利亚'],
];

function legalSummary(l) {
  const addr = [l.address?.line1, l.address?.line2, l.address?.city, [l.address?.state, l.address?.postalCode].filter(Boolean).join(' '), l.address?.country].filter(Boolean).join(', ');
  return h(
    'div',
    { class: 'legal-sum' },
    h('span', { class: 'vline-icon' }, icon('id')),
    h('div', {}, h('strong', { text: l.company ? `${l.fullName}（${l.company}）` : l.fullName }), h('p', { class: 'muted small', text: addr }), h('p', { class: 'muted small', text: [l.email, l.phone, l.consentAt ? `同意于 ${fmtTime(l.consentAt)}` : null].filter(Boolean).join(' · ') })),
  );
}

/** The registrant profile: filled once, consented once. Calls onSaved(legal) after it is stored. */
function legalForm(parent, onSaved) {
  const l = parent.legal || {};
  const a = l.address || {};
  const f = {
    fullName: input({ value: l.fullName || parent.name || '', autocomplete: 'name', required: true }),
    company: input({ value: l.company || '', autocomplete: 'organization', placeholder: '没有就不填' }),
    email: input({ value: l.email || parent.email || '', type: 'email', autocomplete: 'email', required: true }),
    phone: input({ value: l.phone || parent.phone || '', type: 'tel', autocomplete: 'tel', placeholder: '+14155550123', required: true }),
    line1: input({ value: a.line1 || '', autocomplete: 'address-line1', required: true }),
    line2: input({ value: a.line2 || '', autocomplete: 'address-line2' }),
    city: input({ value: a.city || '', autocomplete: 'address-level2', required: true }),
    state: input({ value: a.state || '', autocomplete: 'address-level1' }),
    postalCode: input({ value: a.postalCode || '', autocomplete: 'postal-code', required: true }),
  };
  const country = h('select', { class: 'input', id: `f${++fieldSeq}`, autocomplete: 'country' }, COUNTRIES.map(([v, label]) => h('option', { value: v, text: `${label} ${v}` })));
  country.value = COUNTRIES.some(([v]) => v === a.country) ? a.country : 'US';
  const consent = h('input', { type: 'checkbox', class: 'check', id: `f${++fieldSeq}`, checked: Boolean(l.consentAt) });
  const err = errBox();
  const save = btn(l.consentAt ? '保存' : '保存，我同意', { kind: 'primary', type: 'submit', icon: 'check' });
  const form = h(
    'form',
    { class: 'legal-form', novalidate: true },
    h('div', { class: 'form-grid' }, field('登记人姓名', f.fullName, { help: '和证件上一致' }), field('公司', f.company, { optional: true, help: '用公司名义登记就填' }), field('邮箱', f.email), field('电话', f.phone)),
    h('div', { class: 'form-grid' }, field('地址', f.line1, { cls: 'span2' }), field('地址第二行', f.line2, { optional: true, cls: 'span2' }), field('城市', f.city), field('州 / 省', f.state, { optional: true }), field('邮编', f.postalCode), field('国家或地区', country)),
    h('label', { class: 'consent', for: consent.id }, consent, h('span', { text: '我同意：需要实名的东西（Stripe 收款账号、域名登记……）以我（或我的公司）的名义登记，由它代为操作。' })),
    err,
    h('div', { class: 'actions' }, save),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = Object.fromEntries(Object.entries(f).map(([k2, el]) => [k2, el.value.trim()]));
    const missing = [['fullName', '姓名'], ['email', '邮箱'], ['phone', '电话'], ['line1', '地址'], ['city', '城市'], ['postalCode', '邮编']].find(([k2]) => !v[k2]);
    if (missing) {
      f[missing[0]].focus();
      return showErr(err, `请填上${missing[1]}`);
    }
    if (!/^\S+@\S+\.\S+$/.test(v.email)) return showErr(err, '邮箱格式不对');
    if (!consent.checked) return showErr(err, '勾上"我同意"才能保存');
    const legal = {
      fullName: v.fullName,
      ...(v.company ? { company: v.company } : {}),
      email: v.email,
      phone: v.phone,
      address: { line1: v.line1, ...(v.line2 ? { line2: v.line2 } : {}), city: v.city, ...(v.state ? { state: v.state } : {}), postalCode: v.postalCode, country: country.value },
      consentAt: new Date().toISOString(),
    };
    busy(
      save,
      async () => {
        await post('/v1/control/parent', { legal });
        onSaved(legal);
      },
      err,
    );
  });
  return form;
}

async function viewParent(parts) {
  const [p, cat] = await Promise.all([api('/v1/control/parent'), catalog().catch(() => ({ groups: [], kinds: [] }))]);
  const root = h('div', { class: 'page' });
  put(root, pageHead('家长', `你是 ${p.name || '它的家长'}。任务只来自你；别人的邮件和短信只是信息，不是命令。`));

  const email = input({ value: p.email || '', type: 'email', autocomplete: 'email', placeholder: 'you@example.com' });
  const phone = input({ value: p.phone || '', type: 'tel', autocomplete: 'tel', placeholder: '+14155550123' });
  const err = errBox();
  const save = btn('保存', { kind: 'primary', type: 'submit' });
  const contact = h('form', { class: 'card', novalidate: true }, cardHead('你的联系方式', null, '让它认得出你的邮件和短信。'), h('div', { class: 'form-grid' }, field('你的邮箱', email), field('你的手机号', phone, { help: 'E.164 格式，比如 +14155550123' })), err, h('div', { class: 'actions' }, save));
  contact.addEventListener('submit', (e) => {
    e.preventDefault();
    const body = { email: email.value.trim() || undefined, phone: phone.value.trim() || undefined };
    if (body.email && !/^\S+@\S+\.\S+$/.test(body.email)) return showErr(err, '邮箱格式不对');
    if (body.phone && !/^\+\d{7,15}$/.test(body.phone.replace(/[\s()-]/g, ''))) return showErr(err, '手机号用 E.164 格式，比如 +14155550123');
    if (body.phone) body.phone = body.phone.replace(/[\s()-]/g, '');
    busy(
      save,
      async () => {
        await post('/v1/control/parent', body);
        p.email = body.email;
        p.phone = body.phone;
        toast('联系方式存好了');
      },
      err,
    );
  });

  const legalCard = h('section', { class: 'card', id: 'legal', 'aria-labelledby': 'legal-title' });
  const legalKinds = cat.kinds.filter((k) => k.human === 'legal');
  function paintLegal(editing) {
    fill(legalCard,
      h('div', { class: 'card-head' }, h('div', {}, h('h2', { id: 'legal-title', text: '法律身份：登记人' }), h('p', { class: 'muted small', text: '它不是法律主体。要实名的东西（收款账号、域名的登记人……）用你或你公司的名义，你同意一次。' })), p.legal && !editing ? badge('已同意', 'ok') : null),
      p.legal && !editing
        ? h('div', {}, legalSummary(p.legal), h('div', { class: 'actions' }, btn('改登记信息', { kind: 'ghost', size: 'sm', onClick: () => paintLegal(true) })))
        : legalForm(p, (legal) => {
            p.legal = legal;
            toast('登记人存好了');
            paintLegal(false);
          }),
      legalKinds.length ? h('div', { class: 'legal-next' }, h('span', { class: 'muted small', text: '用得上它的：' }), h('div', { class: 'chips' }, legalKinds.map((k) => h('a', { class: 'chip link-chip', href: `#/resources/add/${encodeURIComponent(k.id)}` }, h('span', { text: k.label }), icon('arrow'))))) : null,
    );
  }
  paintLegal(false);
  put(root, contact, legalCard);
  if (parts[0] === 'legal') root.vfAfter = scrollToId('legal');
  return root;
}

// ---------------- 钱 ----------------

const FALLBACK_CATEGORIES = [
  { id: 'compute', label: '自己的 token 和服务费', blocked: false },
  { id: 'software', label: '软件和订阅', blocked: false },
  { id: 'food', label: '外卖和日用品', blocked: false },
  { id: 'shopping', label: '网购', blocked: false },
  { id: 'travel', label: '机票酒店', blocked: false },
  { id: 'gift_cards', label: '礼品卡', blocked: true },
  { id: 'money_transfer', label: '转账汇款', blocked: true },
  { id: 'crypto', label: '加密货币', blocked: true },
  { id: 'gambling', label: '赌博', blocked: true },
];
const SPEND_STATUS = { approved: ['批准了', 'ok'], pending_approval: ['等你批准', 'warn'], pending: ['等你批准', 'warn'], denied: ['拒绝了', 'bad'], refused: ['授权书不允许', 'bad'], expired: ['过期了', 'muted'], canceled: ['取消了', 'muted'], failed: ['失败', 'bad'] };
const PRESETS = [2000, 5000, 10000];

async function viewMoney(parts) {
  const [w0, ov] = await Promise.all([api('/v1/control/wallet'), S.overview ? Promise.resolve(S.overview) : overview()]);
  const name = S.agent?.name || ov.agent?.name || '它';
  const parentName = ov.agent?.parentName || '家长';
  const cats = Array.isArray(w0.categories) && w0.categories.length ? w0.categories : FALLBACK_CATEGORIES;
  const M = { w: w0, connecting: null, editing: !w0.mandate, monthly: 5000, perTx: 2500, perTxTouched: false, custom: false, allowed: new Set(), test: null };
  const resetMandateDraft = () => {
    const m = M.w.mandate;
    M.monthly = m?.monthlyLimitCents || 5000;
    M.perTx = m?.perTransactionLimitCents || Math.round(M.monthly / 2);
    M.perTxTouched = Boolean(m);
    M.custom = !PRESETS.includes(M.monthly);
    M.allowed = new Set(m ? m.allowedCategories : cats.filter((c) => !c.blocked && c.id !== 'travel').map((c) => c.id));
  };
  resetMandateDraft();

  const root = h('div', { class: 'page money' });
  const summary = h('div', {});
  const connectCard = h('section', { class: 'card flow-step', id: 'wallet', 'aria-labelledby': 'wallet-title' });
  const mandateCard = h('section', { class: 'card flow-step', id: 'mandate', 'aria-labelledby': 'mandate-title' });
  const testCard = h('section', { class: 'card flow-step', id: 'test', 'aria-labelledby': 'test-title' });
  const spendCard = h('section', { class: 'card', 'aria-labelledby': 'spend-title' });
  put(root, pageHead('钱', '你定一个每月额度，它在额度内自己花，花了告诉你。硬上限在机器外面：每一笔都要在 Link app 里批准。'), summary, connectCard, mandateCard, testCard, spendCard);

  const stepHead = (n, id, title, sub, done, right) => h('header', { class: 'flow-head' }, h('span', { class: ['flow-num', done && 'done'], 'aria-hidden': 'true' }, done ? icon('check') : String(n)), h('div', {}, h('h2', { id, text: title }), sub ? h('p', { class: 'muted', text: sub }) : null), right || null);

  function paintAll() {
    paintSummary();
    paintConnect();
    paintMandate();
    paintTest();
    paintSpend();
  }

  function paintSummary() {
    const w = M.w;
    const m = w.mandate;
    const kids = [];
    if (m && w.mandateIntact === false) kids.push(h('div', { class: 'banner bad' }, h('span', { class: 'banner-icon' }, icon('alert')), h('div', { class: 'banner-body' }, h('strong', { text: '授权书的签名对不上' }), h('p', { text: '授权书文件被改动过，它现在一分钱也不会花。请重新签一次。' })), h('div', { class: 'banner-actions' }, btn('重新签', { kind: 'primary', onClick: () => ((M.editing = true), paintMandate(), scrollToId('mandate')()) }))));
    if (m) {
      const freeze = switchEl(Boolean(w.frozen), {
        label: '冻结花钱',
        onChange: async (v, s) => {
          s.disabled = true;
          try {
            const r = await post('/v1/control/freeze', { frozen: v });
            M.w.frozen = Boolean(r.frozen);
            toast(M.w.frozen ? '冻结了：它现在一分钱也花不了' : '解冻了');
          } catch (e) {
            s.checked = !v;
            if (e.status !== 401) toast(e.message, 'bad');
          } finally {
            s.disabled = false;
            paintSummary();
          }
        },
      });
      kids.push(
        h(
          'section',
          { class: ['card', 'money-strip', w.frozen && 'frozen'], 'aria-label': '本月' },
          h('div', { class: 'money-strip-main' }, h('span', { class: 'muted small', text: '本月已花' }), h('div', { class: 'big-num' }, h('span', { text: fmtCents(w.spentThisMonthCents) }), h('span', { class: 'muted', text: ` / ${fmtCents(m.monthlyLimitCents)}` })), h('progress', { max: String(m.monthlyLimitCents || 1), value: String(Math.min(w.spentThisMonthCents || 0, m.monthlyLimitCents || 0)), 'aria-label': '本月已花' })),
          h('div', { class: 'money-strip-side' }, h('div', { class: 'badges' }, badge(`单笔 ≤ ${fmtCents(m.perTransactionLimitCents)}`, 'muted'), w.authenticated ? badge('Link 已连接', 'ok') : badge('Link 没连接', 'warn')), h('label', { class: 'freeze' }, freeze, h('span', {}, h('strong', { text: w.frozen ? '已冻结' : '冻结花钱' }), h('span', { class: 'muted small', text: w.frozen ? '它一分钱也花不了，直到你解冻' : '一键停掉它所有的花钱' })))),
        ),
      );
    }
    fill(summary, ...kids);
  }

  function paintConnect() {
    const w = M.w;
    if (w.authenticated) {
      const d = w.details || {};
      const who = ['email', 'name', 'country'].map((k) => (typeof d[k] === 'string' ? d[k] : null)).filter(Boolean).join(' · ');
      const disc = btn('断开', { kind: 'ghost', size: 'sm' });
      let armed = false;
      disc.addEventListener('click', () => {
        if (!armed) {
          armed = true;
          setLabel(disc, '确定断开？');
          return;
        }
        busy(disc, async () => {
          await post('/v1/control/wallet/disconnect');
          M.w = await api('/v1/control/wallet');
          paintAll();
          toast('Link 断开了');
        });
      });
      fill(connectCard, stepHead(1, 'wallet-title', 'Link 钱包连上了', who || '它会拿到一次性虚拟卡，每一笔都要你在 Link app 里批准。', true, disc));
      connectCard.classList.add('is-done');
      return;
    }
    connectCard.classList.remove('is-done');
    const err = errBox();
    if (M.connecting) {
      const c = M.connecting;
      const url = safeUrl(c.verificationUrl);
      fill(connectCard,
        stepHead(1, 'wallet-title', '在 Link 里批准', '打开 Link app（或下面的链接），核对这句话一模一样，然后批准。'),
        c.phrase ? h('div', { class: 'phrase', 'aria-label': `核对短语：${c.phrase}` }, h('span', { class: 'phrase-label', text: '核对短语' }), h('span', { class: 'phrase-text', text: c.phrase })) : null,
        h('div', { class: 'actions' }, url ? btn('打开 Link 批准页', { kind: 'primary', size: 'lg', href: url, trail: 'ext' }) : null, url ? copyBtn(url, '链接', { label: '复制链接', kind: 'ghost' }) : null),
        h('div', { class: 'waiting', role: 'status' }, spinner(), h('span', { text: '正在等你批准……批准后这一页会自己往下走。' })),
        h('div', { class: 'actions' }, btn('取消', { kind: 'ghost', size: 'sm', onClick: () => ((M.connecting = null), M.connectPoll?.stop(), paintConnect()) })),
      );
      return;
    }
    const go = btn('连接 Link', { kind: 'primary', size: 'lg', icon: 'wallet' });
    go.addEventListener('click', () =>
      busy(
        go,
        async () => {
          const r = await post('/v1/control/wallet/connect');
          if (r.already) {
            M.w = await api('/v1/control/wallet');
            paintAll();
            return;
          }
          M.connecting = r;
          paintConnect();
          M.connectPoll?.stop();
          M.connectPoll = poll(async () => {
            const w = await api('/v1/control/wallet');
            if (!w.authenticated) return false;
            M.w = w;
            M.connecting = null;
            paintAll();
            toast('Link 批准了，钱包连上了');
            const next = M.w.mandate ? 'test' : 'mandate';
            document.getElementById(next)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
            return true;
          }, 3000);
        },
        err,
      ),
    );
    fill(connectCard,
      stepHead(1, 'wallet-title', '连接 Link 钱包', '用你自己的 Stripe Link 账号（仅美国/加拿大）。它拿到的是一次性虚拟卡，每一笔都要你在 Link app 里批准。'),
      err,
      h('div', { class: 'actions' }, go),
    );
  }

  function statement() {
    return `我授权 ${name} 每月最多花 ${fmtCents(M.monthly)}，单笔不超过 ${fmtCents(M.perTx)}。这个数字是我愿意让它搞砸的最大金额。`;
  }

  function paintMandate() {
    const m = M.w.mandate;
    mandateCard.classList.toggle('is-done', Boolean(m) && !M.editing);
    if (m && !M.editing) {
      const labelOf = (id) => cats.find((c) => c.id === id)?.label || id;
      fill(mandateCard,
        stepHead(2, 'mandate-title', '零花钱授权书签好了', `每月 ${fmtCents(m.monthlyLimitCents)}，单笔 ${fmtCents(m.perTransactionLimitCents)}`, true),
        h(
          'div',
          { class: 'paper' },
          h('p', { class: 'paper-text', text: m.parentStatement || '' }),
          h('div', { class: 'paper-cats' }, h('span', { class: 'muted small', text: '可以买' }), h('div', { class: 'chips' }, (m.allowedCategories || []).map((c) => h('span', { class: 'chip static', text: labelOf(c) })))),
          h('div', { class: 'paper-cats' }, h('span', { class: 'muted small', text: '永远不买' }), h('div', { class: 'chips' }, (m.blockedCategories || []).map((c) => h('span', { class: 'chip static blocked' }, icon('lock'), h('span', { text: labelOf(c) }))))),
          h('p', { class: 'paper-sign' }, h('span', { text: `签字：${m.signedBy || parentName}` }), h('span', { class: 'muted', text: ` · ${fmtTime(m.signedAt)}` }), m.hash ? h('span', { class: 'mono muted small', text: ` · ${m.hash.slice(0, 12)}…` }) : null),
        ),
        h('div', { class: 'actions' }, btn('改额度（重新签）', { kind: 'ghost', size: 'sm', onClick: () => ((M.editing = true), resetMandateDraft(), paintMandate()) })),
      );
      return;
    }
    const err = errBox();
    const stmt = h('p', { class: 'paper-text', text: statement() });
    const perTx = input({ type: 'number', inputmode: 'decimal', min: '1', step: '1', value: String(M.perTx / 100), class: 'input narrow mono', 'aria-label': '单笔最多（美元）' });
    const custom = input({ type: 'number', inputmode: 'decimal', min: '1', step: '1', value: M.custom ? String(M.monthly / 100) : '', placeholder: '比如 30', class: 'input narrow mono', 'aria-label': '每月最多（美元）', hidden: !M.custom });
    const refresh = () => {
      if (!M.perTxTouched) {
        M.perTx = Math.max(100, Math.round(M.monthly / 2));
        perTx.value = String(M.perTx / 100);
      }
      stmt.textContent = statement();
    };
    const presetChips = h(
      'div',
      { class: 'chips presets', role: 'radiogroup', 'aria-label': '每月最多' },
      [...PRESETS, 'custom'].map((p) => {
        const on = p === 'custom' ? M.custom : !M.custom && M.monthly === p;
        const c = h('button', { type: 'button', class: 'chip preset', role: 'radio', 'aria-checked': String(on) }, p === 'custom' ? '自定义' : fmtDollars(p));
        c.addEventListener('click', () => {
          for (const x of presetChips.children) x.setAttribute('aria-checked', String(x === c));
          M.custom = p === 'custom';
          custom.hidden = !M.custom;
          if (M.custom) {
            custom.focus();
            const v = Math.round(Number(custom.value) * 100);
            if (v > 0) M.monthly = v;
          } else M.monthly = p;
          refresh();
        });
        return c;
      }),
    );
    custom.addEventListener('input', () => {
      const v = Math.round(Number(custom.value) * 100);
      if (v > 0) {
        M.monthly = v;
        refresh();
      }
    });
    perTx.addEventListener('input', () => {
      const v = Math.round(Number(perTx.value) * 100);
      if (v > 0) {
        M.perTx = v;
        M.perTxTouched = true;
        stmt.textContent = statement();
      }
    });
    const allowable = cats.filter((c) => !c.blocked);
    const blocked = cats.filter((c) => c.blocked);
    const sign = btn('我同意，签字', { kind: 'primary', size: 'lg', icon: 'check' });
    sign.addEventListener('click', () => {
      if (!(M.monthly > 0)) return showErr(err, '先选一个每月额度');
      if (!(M.perTx > 0)) return showErr(err, '单笔上限要大于 0');
      if (M.perTx > M.monthly) return showErr(err, '单笔上限不能超过每月额度');
      busy(
        sign,
        async () => {
          const r = await post('/v1/control/mandate', { monthlyCents: M.monthly, perTxCents: M.perTx, allowed: [...M.allowed], consent: '我同意' });
          M.w.mandate = r.mandate;
          M.w.mandateIntact = true;
          M.editing = false;
          paintAll();
          toast(`签好了，${name} 用自己的签名密钥确认了`);
          if (M.w.authenticated) document.getElementById('test')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
        },
        err,
      );
    });
    fill(mandateCard,
      stepHead(2, 'mandate-title', '零花钱', '授权只发生在这一刻：之后它在额度内自己花，不再逐笔请示你。'),
      h('div', { class: 'money-form' }, h('div', { class: 'field' }, h('span', { class: 'field-label', text: '每月最多' }), h('div', { class: 'preset-row' }, presetChips, custom)), h('div', { class: 'field' }, h('label', { class: 'field-label', for: perTx.id, text: '单笔最多' }), h('div', { class: 'inline-money' }, h('span', { class: 'muted', text: '$' }), perTx, h('span', { class: 'muted small', text: '默认是每月的一半' })))),
      h(
        'div',
        { class: 'field' },
        h('span', { class: 'field-label', text: '它可以买' }),
        h(
          'div',
          { class: 'chips', role: 'group', 'aria-label': '它可以买' },
          allowable.map((c) =>
            chip(c.label, M.allowed.has(c.id), (v) => {
              if (v) M.allowed.add(c.id);
              else M.allowed.delete(c.id);
            }),
          ),
        ),
      ),
      blocked.length ? h('div', { class: 'field' }, h('span', { class: 'field-label', text: '永远不买' }), h('div', { class: 'chips' }, blocked.map((c) => h('span', { class: 'chip static blocked' }, icon('lock'), h('span', { text: c.label })))), h('p', { class: 'field-help', text: '这些是诈骗套现的常见出口，谁也改不了。' })) : null,
      h('div', { class: 'paper' }, h('span', { class: 'paper-label', text: '授权书' }), stmt, h('p', { class: 'paper-sign' }, h('span', { text: `签字：${parentName}` }), h('span', { class: 'muted', text: ` · ${fmtTime(new Date().toISOString())}` }))),
      err,
      h('div', { class: 'actions' }, sign, m ? btn('不改了', { kind: 'ghost', onClick: () => ((M.editing = false), paintMandate()) }) : null),
    );
  }

  function paintTest() {
    const w = M.w;
    const ready = w.authenticated && w.mandate && !w.frozen;
    const T = M.test;
    const kids = [stepHead(3, 'test-title', '试一笔 $1（可选）', '测试模式，不扣钱：看看一笔批准在 Link app 里是什么样子。', T?.status === 'done' && T.result?.status === 'approved')];
    if (!ready) {
      kids.push(h('p', { class: 'muted small', text: w.frozen ? '冻结时不能试。' : '连上 Link、签好授权书之后就能试。' }));
    } else if (T) {
      const notes = (T.notes || []).map((n) => {
        const m = /(https?:\/\/\S+)/.exec(n);
        const url = m ? safeUrl(m[1]) : null;
        return h('li', {}, url ? [n.slice(0, m.index), h('a', { class: 'link', href: url, target: '_blank', rel: 'noopener noreferrer', text: shortUrl(url) }), n.slice(m.index + m[1].length)] : n);
      });
      if (T.status === 'running') kids.push(h('div', { class: 'waiting', role: 'status' }, spinner(), h('span', { text: '已经发出测试申请，在 Link app 里批准它……' })));
      if (notes.length) kids.push(h('ul', { class: 'op-notes muted small' }, notes));
      if (T.status === 'done') {
        const r = T.result || {};
        kids.push(
          r.status === 'approved'
            ? h('div', { class: 'result-box ok' }, h('span', { class: 'result-icon' }, icon('check')), h('div', {}, h('strong', { text: '批准了' }), h('p', { text: `一次性卡${r.last4 ? `尾号 ${r.last4}` : ''}。测试模式，没有扣钱。` })))
            : h('div', { class: 'result-box bad' }, h('span', { class: 'result-icon' }, icon('alert')), h('div', {}, h('strong', { text: `没有批准（${SPEND_STATUS[r.status]?.[0] || r.status || '未知'}）` }), r.reason ? h('p', { text: r.reason }) : null)),
        );
      }
      if (T.status === 'error') kids.push(h('div', { class: 'result-box bad' }, h('span', { class: 'result-icon' }, icon('alert')), h('div', {}, h('strong', { text: '没试成' }), h('p', { text: T.error || '' }))));
      if (T.status !== 'running') kids.push(h('div', { class: 'actions' }, testBtn('再试一笔')));
    } else {
      kids.push(h('div', { class: 'actions' }, testBtn('做一笔 $1 测试')));
    }
    fill(testCard, ...kids);
    testCard.classList.toggle('is-muted', !ready);
  }

  function testBtn(label) {
    const err = errBox();
    const b = btn(label, { kind: 'secondary', icon: 'wallet' });
    b.addEventListener('click', () =>
      busy(
        b,
        async () => {
          const { opId } = await post('/v1/control/wallet/test');
          M.test = { status: 'running', notes: [] };
          paintTest();
          poll(async () => {
            const op = await api(`/v1/control/ops/${encodeURIComponent(opId)}`);
            M.test = { status: op.status, result: op.result, error: op.error, notes: op.notes || (op.note ? [op.note] : M.test.notes) };
            paintTest();
            if (op.status === 'running') return false;
            M.w = await api('/v1/control/wallet');
            paintSpend();
            paintSummary();
            return true;
          }, 2000);
        },
        err,
      ),
    );
    return h('span', { class: 'btn-wrap' }, b, err);
  }

  function paintSpend() {
    const rows = (M.w.spend || []).slice().reverse();
    fill(spendCard,
      cardHead('花过的钱', rows.length ? h('span', { class: 'muted small', text: `${rows.length} 笔` }) : null),
      rows.length
        ? h(
            'ul',
            { class: 'rows' },
            rows.map((s) => {
              const [label, tone] = SPEND_STATUS[s.status] || [s.status, 'muted'];
              return h(
                'li',
                { class: 'row spend-row' },
                h('span', { class: 'row-title' }, h('strong', { text: s.merchant_name || s.merchantName || '' }), h('span', { class: 'muted small', text: ` ${fmtTime(s.created_at || s.createdAt)}${s.last4 ? ` · 卡尾号 ${s.last4}` : ''}` })),
                h('span', { class: 'badges' }, s.test ? badge('测试', 'muted') : null, badge(label, tone)),
                h('span', { class: 'amount mono', text: fmtCents(s.amount_cents ?? s.amountCents) }),
              );
            }),
          )
        : h('p', { class: 'muted', text: '还没花过钱。每一笔它都会事后在 Telegram 里告诉你。' }),
    );
  }

  paintAll();
  if (parts[0]) root.vfAfter = scrollToId(parts[0]);
  else if (!M.w.authenticated && !M.w.mandate) root.vfAfter = () => window.scrollTo(0, 0);
  return root;
}

// ---------------- 对话 (Telegram) ----------------

async function viewChat() {
  const [tg0, keys, ov] = await Promise.all([api('/v1/control/telegram'), savedKeys(), S.overview ? Promise.resolve(S.overview) : overview()]);
  const name = ov.agent?.name || S.agent?.name || 'Fox';
  const slug = (ov.agent?.slug || S.agent?.slug || 'fox').replace(/-/g, '_');
  const preset = savedKey(keys, 'telegram_bot_token');
  const T = { tg: tg0, replacing: false };
  const root = h('div', { class: 'page' });
  const body = h('div', {});
  put(root, pageHead('对话', '你和它说话的渠道。第一版用 Telegram：你在 Telegram 里发的话就是任务。'), body);

  function paint() {
    const tg = T.tg;
    if (tg.bound && !T.replacing) {
      const url = tg.handle ? `https://t.me/${tg.handle.replace(/^@/, '')}` : null;
      fill(body,
        h(
          'section',
          { class: 'card' },
          h('div', { class: 'result-box ok' }, h('span', { class: 'result-icon' }, icon('check')), h('div', {}, h('strong', { text: '已认领' }), h('p', {}, '你和 ', h('span', { class: 'mono', text: tg.handle || '' }), ' 连上了。直接在 Telegram 里给它发消息就是布置任务。'))),
          h('div', { class: 'actions' }, url ? btn('在 Telegram 里打开', { kind: 'primary', href: url, trail: 'ext' }) : null, btn('换一个 bot', { kind: 'ghost', size: 'sm', onClick: () => ((T.replacing = true), paint()) })),
        ),
      );
      return;
    }
    if (tg.handle && !tg.bound && !T.replacing) return paintClaim();
    paintSetup();
  }

  function paintClaim() {
    const tg = T.tg;
    const url = safeUrl(tg.claimUrl);
    fill(body,
      h(
        'section',
        { class: 'card flow-step' },
        h('header', { class: 'flow-head' }, h('span', { class: 'flow-num', 'aria-hidden': 'true', text: '✓' }), h('div', {}, h('h2', { text: '最后一步：认领它' }), h('p', {}, h('span', { class: 'mono', text: tg.handle }), ' 准备好了。打开下面的链接，在 Telegram 里点 Start。'))),
        h('div', { class: 'actions' }, url ? btn(`在 Telegram 里打开 ${tg.handle}`, { kind: 'primary', size: 'lg', href: url, trail: 'ext' }) : null, url ? copyBtn(url, '认领链接', { label: '复制链接' }) : null),
        h('div', { class: 'waiting', role: 'status' }, spinner(), h('span', { text: '等你在 Telegram 里点 Start……（它在后台运行时才会回应）' })),
        h('div', { class: 'actions' }, btn('换一个 bot', { kind: 'ghost', size: 'sm', onClick: () => ((T.replacing = true), paint()) })),
      ),
    );
    T.claimPoll?.stop();
    T.claimPoll = poll(async () => {
      const t = await api('/v1/control/telegram');
      if (!t.bound) return false;
      T.tg = t;
      paint();
      toast('已认领：你们连上了');
      overview().then(paintDots, () => {});
      return true;
    }, 3000);
  }

  function paintSetup() {
    const err = errBox();
    const uname = `${slug}_vibefox_bot`;
    const connect = async (reqBody) => {
      const r = await post('/v1/control/telegram', reqBody);
      T.tg = { handle: r.handle, claimUrl: r.claimUrl, bound: false };
      T.replacing = false;
      paint();
      toast(`bot ${r.handle} 准备好了`);
    };
    const tokenWrap = secretInput({ placeholder: '123456789:AA…' });
    const tokenEl = $('input', tokenWrap);
    const pasteBtn = btn('连接', { kind: preset ? 'secondary' : 'primary', type: 'submit' });
    const pasteForm = h('form', { class: 'keyform', novalidate: true }, field('Bot token', tokenWrap, { help: 'BotFather 回给你的那一长串，格式是 数字:字母。' }), h('div', { class: 'actions' }, pasteBtn));
    pasteForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const token = tokenEl.value.trim();
      if (!/^\d+:[\w-]{20,}$/.test(token)) return showErr(err, 'token 的格式像 123456789:AAH…，再看一眼');
      busy(pasteBtn, () => connect({ token }), err);
    });
    let presetBlock = null;
    if (preset) {
      const use = btn(`用存好的 token（${preset.tail || '…'}）`, { kind: 'primary', size: 'lg', icon: 'key' });
      use.addEventListener('click', () => busy(use, () => connect({ usePreset: true }), err));
      presetBlock = h('div', { class: 'preset-block' }, use, h('details', { class: 'alt' }, h('summary', { text: '或者粘贴一个新的' }), pasteForm));
    }
    fill(body,
      h(
        'section',
        { class: 'card' },
        cardHead('连上 Telegram', T.replacing ? btn('不换了', { kind: 'ghost', size: 'sm', onClick: () => ((T.replacing = false), paint()) }) : null, '只有真人的 Telegram 账号能创建 bot，所以这一步要你来。三步，一分钟。'),
        h(
          'ol',
          { class: 'howto' },
          h('li', {}, h('div', {}, h('strong', { text: '在 Telegram 里打开 @BotFather，发 /newbot' })), h('div', { class: 'actions tight' }, btn('打开 @BotFather', { kind: 'secondary', size: 'sm', href: 'https://t.me/BotFather', trail: 'ext' }), copyBtn('/newbot', '命令', { label: '复制 /newbot' }))),
          h('li', {}, h('div', {}, h('strong', { text: '名字和用户名' }), h('p', { class: 'muted small', text: '用户名要以 bot 结尾；被占了就加几个字。' })), h('div', { class: 'vlines tight' }, h('div', { class: 'vline' }, h('span', { class: 'vline-label', text: '名字' }), h('span', { class: 'vline-value mono', text: name }), copyBtn(name, '名字')), h('div', { class: 'vline' }, h('span', { class: 'vline-label', text: '用户名' }), h('span', { class: 'vline-value mono', text: uname }), copyBtn(uname, '用户名')))),
          h('li', {}, h('div', {}, h('strong', { text: '把 token 交给它' }), h('p', { class: 'muted small', text: '它会把 bot 的名字、简介和命令菜单改成自己的。' })), presetBlock || pasteForm),
        ),
        err,
      ),
    );
  }

  paint();
  return root;
}

// ---------------- 大脑 ----------------

const PROVIDERS = [
  { id: 'openrouter', label: 'OpenRouter', tag: '推荐', desc: '几百个模型，一个 key；key 的额度就是它的"脑子预算"。', keyName: 'openrouter_api_key', keyUrl: 'https://openrouter.ai/settings/keys', placeholder: 'sk-or-v1-…' },
  { id: 'anthropic', label: 'Anthropic', desc: '直接用 Claude 模型。', keyName: 'anthropic_api_key', keyUrl: 'https://console.anthropic.com/settings/keys', placeholder: 'sk-ant-…' },
  { id: 'deepseek', label: 'DeepSeek', desc: '便宜的 DeepSeek 模型。', keyName: 'deepseek_api_key', keyUrl: 'https://platform.deepseek.com/api_keys', placeholder: 'sk-…' },
];

async function viewBrain() {
  const [keys, ov, res, cat] = await Promise.all([savedKeys(), overview(), api('/v1/control/resources').catch(() => ({ resources: [] })), catalog().catch(() => ({ groups: [], kinds: [] }))]);
  const brainsOf = (list) => (list || []).filter((r) => (kindOf(cat, r.kind)?.group === 'brain' || /^brain/.test(r.kind)) && r.status !== 'failed');
  let brains = brainsOf(res.resources);
  const B = { provider: (PROVIDERS.find((p) => savedKey(keys, p.keyName)) || PROVIDERS[0]).id, paste: false, result: null };
  const root = h('div', { class: 'page' });
  const status = h('div', {});
  const picker = h('section', { class: 'card' });
  put(root, pageHead('大脑', '它用什么模型思考。router（它自己）每条消息都要想，默认用便宜的模型；难活交给更强的 worker。'), status, picker);

  function paintStatus() {
    fill(status,
      ov.ready?.brain
        ? h('div', { class: 'note ok' }, icon('check'), h('span', {}, '它能思考了', brains.length ? `：${brains.map((b) => `${b.label}${b.handle ? `（${b.handle}）` : ''}`).join('、')}` : '。'))
        : h('div', { class: 'note warn' }, icon('alert'), h('span', { text: '还没有大脑：没有模型 key，它没法想事情，也不能接任务。' })),
    );
  }

  function paint() {
    const p = PROVIDERS.find((x) => x.id === B.provider);
    const saved = savedKey(keys, p.keyName);
    const err = errBox();
    const result = h('div', { class: 'result', role: 'status', 'aria-live': 'polite' });
    const connect = async (reqBody, button) => {
      const r = await post('/v1/control/brain', { provider: p.id, ...reqBody });
      B.result = r;
      if (r.ok) {
        ov.ready = { ...(ov.ready || {}), brain: true };
        api('/v1/control/resources').then((x) => {
          brains = brainsOf(x.resources);
          paintStatus();
        }, () => {});
        paintStatus();
        overview().then(paintDots, () => {});
        toast('接上了，它能思考了');
      }
      paintResult(result, r);
      setLabel(button, r.ok ? '再测一次' : '再试一次');
    };
    const cards = h(
      'div',
      { class: 'provider-grid', role: 'radiogroup', 'aria-label': '模型供应商' },
      PROVIDERS.map((x) => {
        const on = x.id === B.provider;
        const has = savedKey(keys, x.keyName);
        const c = h(
          'button',
          { type: 'button', class: 'provider', role: 'radio', 'aria-checked': String(on), tabindex: on ? '0' : '-1' },
          h('span', { class: 'provider-top' }, h('strong', { text: x.label }), x.tag ? badge(x.tag, 'accent') : null),
          h('span', { class: 'muted small', text: x.desc }),
          has ? h('span', { class: 'provider-key small' }, icon('key'), h('span', { text: `存好了 ${has.tail || ''}` })) : null,
        );
        c.addEventListener('click', () => {
          B.provider = x.id;
          B.paste = false;
          B.result = null;
          paint();
          $('.provider[aria-checked=true]', picker)?.focus();
        });
        return c;
      }),
    );
    cards.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const i = PROVIDERS.findIndex((x) => x.id === B.provider);
      const n = PROVIDERS[(i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : PROVIDERS.length - 1)) % PROVIDERS.length];
      e.preventDefault();
      $(`.provider:nth-child(${PROVIDERS.indexOf(n) + 1})`, cards)?.click();
    });
    let action;
    if (saved && !B.paste) {
      const use = btn(`用存好的 key（${saved.tail || '…'}）`, { kind: 'primary', size: 'lg', icon: 'key' });
      use.addEventListener('click', () => busy(use, () => connect({ usePreset: true }, use), err));
      action = h('div', { class: 'preset-block' }, use, h('button', { type: 'button', class: 'link quiet', text: '粘贴别的 key', onclick: () => ((B.paste = true), paint(), $('.brain-form input', picker)?.focus()) }));
    } else {
      const keyIn = secretInput({ placeholder: p.placeholder });
      const keyEl = $('input', keyIn);
      const go = btn('接上', { kind: 'primary', type: 'submit' });
      action = h('form', { class: 'keyform brain-form', novalidate: true }, field(`${p.label} API key`, keyIn, { help: '只存在它自己的钥匙串里。接上时当场测试模型能不能用。' }), h('p', { class: 'small' }, h('a', { class: 'link', href: p.keyUrl, target: '_blank', rel: 'noopener noreferrer' }, `去 ${shortUrl(p.keyUrl).split('/')[0]} 拿 key`, icon('ext'))), h('div', { class: 'actions' }, go, saved ? btn('还是用存好的', { kind: 'ghost', onClick: () => ((B.paste = false), paint()) }) : null));
      action.addEventListener('submit', (e) => {
        e.preventDefault();
        const key = keyEl.value.trim();
        if (!key) return showErr(err, `先粘贴 ${p.label} 的 key`);
        busy(go, () => connect({ key }, go), err);
      });
    }
    fill(picker, cardHead('选一个模型供应商'), cards, h('div', { class: 'provider-action' }, action, err, result));
    if (B.result) paintResult(result, B.result);
  }

  function paintResult(el, r) {
    const lines = String(r.detail || '')
      .split(/[；;\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    fill(el,
      h(
        'div',
        { class: ['result-box', r.ok ? 'ok' : 'bad'] },
        h('span', { class: 'result-icon' }, icon(r.ok ? 'check' : 'alert')),
        h('div', {}, h('strong', { text: r.ok ? '接上了' : '没接上' }), r.ok && r.routerModel ? h('p', {}, 'router（它自己）用 ', h('span', { class: 'mono', text: r.routerModel })) : null, lines.length ? h('ul', { class: 'detail-lines small' }, lines.map((l) => h('li', { class: 'mono', text: l }))) : null),
      ),
    );
  }

  paintStatus();
  paint();
  return root;
}

// ---------------- workers ----------------

const TIER = { 1: ['便宜档', 'muted'], 2: ['日常', 'info'], 3: ['最强档', 'accent'] };

async function viewWorkers() {
  const r = await api('/v1/control/workers');
  const list = r.workers || [];
  const root = h('div', { class: 'page' });
  put(root, pageHead('Worker', 'worker 是它的手：harness × 模型。谁来干由它按派活规则决定，你也可以在任务里点名。所有 worker 有一样的工具和权限。'));
  if (!list.length) {
    put(root, h('div', { class: 'card empty' }, h('span', { class: 'empty-icon' }, icon('tool')), h('h2', { text: '还没有 worker' }), h('p', { class: 'muted', text: '先接上大脑，或者在这台 Mac 上装好 Claude Code / OpenCode。' }), btn('接上大脑', { kind: 'primary', href: '#/brain' })));
    return root;
  }
  const on = list.filter((w) => w.enabled && w.available).length;
  put(root,
    h(
      'section',
      { class: 'card' },
      cardHead(`${on} 个待命`, null),
      h(
        'ul',
        { class: 'worker-list' },
        list.map((w) => {
          const row = h('li', { class: ['worker', !w.available && 'unavailable'] });
          const paintRow = () => {
            const id = `w-${w.id}`;
            const sw = switchEl(Boolean(w.enabled && w.available), {
              id,
              label: `启用 ${w.label}`,
              disabled: !w.available,
              onChange: async (v, s) => {
                s.disabled = true;
                try {
                  const res = await post(`/v1/control/workers/${encodeURIComponent(w.id)}`, { enabled: v });
                  Object.assign(w, res.worker || { enabled: v });
                  toast(`${v ? '启用' : '停用'}了 ${w.label}`);
                } catch (e) {
                  s.checked = !v;
                  if (e.status !== 401) toast(e.message, 'bad');
                } finally {
                  paintRow();
                }
              },
            });
            const [tier, tone] = TIER[w.tier] || [`${w.tier} 档`, 'muted'];
            fill(row,
              h('label', { class: 'worker-main', for: id }, h('span', { class: 'worker-title' }, h('strong', { text: w.label }), badge(tier, tone)), h('span', { class: 'mono muted small', text: [w.harness, w.model].filter(Boolean).join(' · ') }), !w.available && w.reason ? h('span', { class: 'worker-reason small' }, icon('alert'), h('span', { text: w.reason })) : null),
              sw,
            );
          };
          paintRow();
          return row;
        }),
      ),
    ),
  );
  return root;
}

boot();
