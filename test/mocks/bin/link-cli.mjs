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
if (a === 'auth' && b === 'status') { save(s); out({ authenticated: s.authenticated, credentials_path: stateFile }); }
else if (a === 'auth' && b === 'login') {
  console.log('Open https://app.link.com/device and confirm the phrase: brave-otter-42');
  console.log('Waiting for approval in the Link app…');
  s.authenticated = true; save(s); console.log(JSON.stringify({ authenticated: true }));
}
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
