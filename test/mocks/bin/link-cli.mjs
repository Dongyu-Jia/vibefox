// Fake link-cli for tests: same commands and JSON shapes as @stripe/link-cli, no network.
import fs from 'node:fs';
const stateFile = process.env.VF_MOCK_LINK_STATE;
const load = () => (fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { authenticated: process.env.VF_MOCK_LINK_AUTH !== '0', requests: {}, seq: 0, calls: [] });
const save = (s) => fs.writeFileSync(stateFile, JSON.stringify(s, null, 2));
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : undefined; };
const has = (name) => args.includes('--' + name);
const out = (o) => process.stdout.write(JSON.stringify([o]) + '\n');
const fail = (msg) => { process.stdout.write(JSON.stringify({ error: { code: 'INVALID_INPUT', message: msg } }) + '\n'); process.exit(1); };
const s = load();
s.calls.push(args.filter((a) => a !== '--format' && a !== 'json'));
const [a, b, c] = args;
// Device login, like the real CLI: `auth login` leaves a pending login in the credential store,
// `auth status` completes it once the parent "approved" (after VF_MOCK_LINK_APPROVE_AFTER status
// polls, default 1; `never` keeps it pending), `auth logout` clears everything.
const approveAfter = Number(process.env.VF_MOCK_LINK_APPROVE_AFTER ?? 1);
const authed = () => ({ authenticated: true, access_token: 'liwlat_mock_00000000...', token_type: 'Bearer', credentials_path: stateFile });
const pendingView = () => (s.pending ? { pending: true, verification_url: s.pending.verification_url, phrase: s.pending.phrase } : {});
if (a === 'auth' && b === 'status') {
  if (!s.authenticated && s.pending) {
    s.pending.polls = (s.pending.polls ?? 0) + 1;
    if (s.pending.polls >= approveAfter) { s.authenticated = true; delete s.pending; }
  }
  save(s);
  out(s.authenticated ? authed() : { authenticated: false, credentials_path: stateFile, ...pendingView() });
}
else if (a === 'auth' && b === 'login') {
  if (s.authenticated) { save(s); out({ authenticated: true, message: 'You are already logged in. To switch accounts, run `link-cli auth logout` first.' }); }
  else {
    s.logins = (s.logins ?? 0) + 1;
    s.pending = { verification_url: `https://app.link.com/device/approve?code=MOCK${String(s.logins).padStart(4, '0')}`, phrase: 'brave-otter-42', client_name: flag('client-name'), polls: 0 };
    if (Number(flag('interval') ?? 0) <= 0) {
      save(s);
      out({ verification_url: s.pending.verification_url, phrase: s.pending.phrase, instruction: 'Present the verification_url to the user and ask them to approve in the Link app. Then call `auth status --interval 5 --max-attempts 60` to poll until authenticated. Do not wait for the user to reply — start polling immediately.', _next: { command: 'auth status --interval 5 --max-attempts 60', poll_interval_seconds: 5, until: 'authenticated is true' } });
    } else {
      // Polling login (the terminal wizard, no --format): status lines as the real CLI prints them, then approved.
      console.log(`verification_url: ${s.pending.verification_url}`);
      console.log(`phrase: ${s.pending.phrase}`);
      console.log('instruction: Present the verification_url to the user and ask them to approve in the Link app. Polling has started automatically — no further action needed.');
      s.authenticated = true; delete s.pending; save(s);
      console.log('authenticated: true');
    }
  }
}
else if (a === 'auth' && b === 'logout') { s.authenticated = false; delete s.pending; save(s); process.stdout.write(JSON.stringify({ authenticated: false }) + '\n'); }
else if (a === 'user-info') { save(s); out({ email: 'parent@example.com', agent_wallet_spend_limits: { per_transaction: { limit: 50000, used: 0, remaining: 50000 }, daily: { limit: 50000, used: 0, remaining: 50000 }, thirty_day: { limit: 2000000, used: 0, remaining: 2000000 } }, agent_wallet_verification_requirement: { status: 'none', action_url: null } }); }
else if (a === 'spend-request' && b === 'create') {
  if (!s.authenticated) fail('Not authenticated. Run link-cli auth login');
  const context = flag('context') ?? '';
  if (context.length < 100) fail('context must be at least 100 characters');
  const id = 'lsrq_' + String(++s.seq).padStart(4, '0');
  s.requests[id] = { id, status: 'created', amount: Number(flag('amount')), currency: flag('currency') ?? 'usd', merchant_name: flag('merchant-name'), merchant_url: flag('merchant-url'), credential_type: 'card', test: has('test'), approval_url: `https://app.link.com/activity/approve/${id}`, context };
  save(s); out(s.requests[id]);
}
else if (a === 'spend-request' && b === 'request-approval') { const r = s.requests[c]; r.status = 'pending_approval'; save(s); out(r); }
else if (a === 'spend-request' && b === 'retrieve') {
  const r = s.requests[c];
  if (!r) fail('no such spend request');
  if (r.status === 'pending_approval' && (Number(flag('interval') ?? 0) > 0)) { r.status = process.env.VF_MOCK_LINK_DECISION ?? 'approved'; r.approved_at = new Date().toISOString(); }
  const res = { ...r };
  if ((flag('include') === 'card') && r.status === 'approved') {
    const card = { brand: 'visa', number: '4000009990001984', cvc: '100', exp_month: 6, exp_year: 2029, billing_address: { name: 'Test Parent', line1: '123 Test St', city: 'Testville', state: 'CA', postal_code: '00000', country: 'US' }, valid_until: new Date(Date.now() + 48 * 3600e3).toISOString() };
    const file = flag('output-file');
    if (file) { fs.writeFileSync(file, JSON.stringify(card, null, 2), { mode: 0o600 }); res.card = { brand: 'visa', last4: '1984', exp_month: 6, exp_year: 2029 }; res.card_output_file = file; }
    else res.card = card;
  }
  save(s); out(res);
}
else { save(s); fail('fake link-cli: unsupported ' + args.join(' ')); }
