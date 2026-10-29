// Isolated checks: no production database access and no real emails.
// Optional module paths allow running without installing the full application.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
const { default: ts } = await import(process.env.TYPESCRIPT_MODULE || 'typescript');
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const source = await readFile(new URL('../supabase/functions/admin-maturity-alert-email/index.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source.replace(/^import .*;\r?\n/gm, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

test('daily email includes activity, escapes HTML, authenticates resends and fails closed', async () => {
  let handler, fail = false;
  const requests = [], calls = [];
  const metrics = { date: '2026-10-29', windowStart: '2026-10-28T22:00:00Z', windowEnd: '2026-10-29T12:00:00Z',
    activeLoggedInUsers: [{ name: '<script>Member</script>', accountId: 'SP1', loginCount: 2, lastSeenAt: 'login-time' }],
    transactionsList: [{ name: 'Member', accountId: 'SP1', amount: 42, currency: 'ZAR', status: 'completed', type: 'withdrawal', id: 'tx-1', createdAt: 'tx-time' }],
    transfersList: [{ senderAccountId: 'SP1', recipientAccountId: 'SP2', amount: 10, currency: 'ZAR', status: 'pending', id: 'transfer-1' }],
    settingsList: [{ accountId: 'SP1', changedFields: ['bank_name'], occurredAt: 'settings-time', actor: 'user' }] };
  vm.runInNewContext(compiled, { Response, crypto, console,
    Deno: { env: { get: key => ({ SUPABASE_URL: 'https://example.test', SUPABASE_SERVICE_ROLE_KEY: 'service-test', RESEND_API_KEY: 'resend-test' })[key] } },
    serve: cb => { handler = cb; },
    createClient: () => ({ rpc: async (name, args) => {
      calls.push({ name, args });
      return fail ? { error: { message: 'database unavailable' } } : { data: metrics };
    } }),
    fetch: async (_, options) => { requests.push(options); return new Response('{"id":"mail-test"}', { status: 200 }); },
  });
  const invoke = (authorized, period) => handler(new Request('https://example.test', { method: 'POST',
    headers: authorized ? { Authorization: 'Bearer service-test' } : {}, body: JSON.stringify({ kind: 'daily_report', period }) }));
  assert.equal((await invoke(false, 'today')).status, 401);
  assert.equal(requests.length, 0);
  assert.equal((await invoke(true, 'today')).status, 200);
  assert.equal(calls[0].args.p_today, true);
  const mail = JSON.parse(requests[0].body);
  assert.deepEqual(mail.to, ['sparkleinsure@gmail.com']);
  for (const expected of ['SP1', 'SP2', 'tx-1', 'transfer-1', 'bank_name', 'login-time', 'settings-time']) {
    assert.ok(mail.text.includes(expected), expected);
    assert.ok(mail.html.includes(expected), expected);
  }
  assert.ok(!mail.html.includes('<script>'));
  assert.ok(mail.html.includes('&lt;script&gt;'));
  await invoke(true, 'previous_day');
  assert.equal(calls[1].args.p_today, false);
  assert.ok(requests[1].headers['Idempotency-Key'].endsWith('/day/2026-10-29'));
  fail = true;
  assert.equal((await invoke(true, 'today')).status, 500);
  assert.equal(requests.length, 2, 'database failures must not send an empty report');
});

test('SQL logs only changed settings, retains logins, and respects SAST day boundaries', async () => {
  const db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS 'SELECT null::uuid';
    CREATE TABLE auth.users(id uuid PRIMARY KEY, last_sign_in_at timestamptz, email text, phone text, encrypted_password text);
    CREATE TABLE public.profiles(id uuid PRIMARY KEY, account_id text, first_name text, surname text, email text, phone text,
      created_at timestamptz DEFAULT now(), welcome_bonus_credited_at timestamptz, bank_name text, kyc_status text);
    CREATE TABLE public.deposit_tranches(user_id uuid, status text, remaining numeric, current_balance numeric, currency text);
    CREATE TABLE public.transactions(id uuid, user_id uuid, type text, amount numeric, currency text, status text, reference text, description text, created_at timestamptz);
    CREATE TABLE public.member_wallet_transfers(id uuid, sender_id uuid, recipient_id uuid, amount numeric, currency text, status text, created_at timestamptz, completed_at timestamptz, reviewed_at timestamptz);
    INSERT INTO auth.users(id) VALUES ('00000000-0000-0000-0000-000000000001');
    INSERT INTO public.profiles(id,account_id,first_name) VALUES ('00000000-0000-0000-0000-000000000001','SP1','Member');`);
  await db.exec(await readFile(new URL('../supabase/migrations/20261029120000_daily_user_activity_report.sql', import.meta.url), 'utf8'));
  await db.exec(`UPDATE public.profiles SET bank_name='Secret Bank';
    UPDATE public.profiles SET bank_name='Secret Bank';
    UPDATE public.profiles SET kyc_status='verified';
    UPDATE auth.users SET last_sign_in_at=now() - interval '1 minute';
    UPDATE auth.users SET encrypted_password='never include this';
    INSERT INTO public.transactions(id,user_id,type,amount,currency,status,created_at)
      SELECT gen_random_uuid(),id,'withdrawal',42,'ZAR','completed',
        (now() AT TIME ZONE 'Africa/Johannesburg')::date::timestamp AT TIME ZONE 'Africa/Johannesburg' FROM auth.users;
    INSERT INTO public.transactions(id,user_id,type,amount,currency,status,created_at)
      SELECT gen_random_uuid(),id,'deposit',99,'USD','completed',
        ((now() AT TIME ZONE 'Africa/Johannesburg')::date::timestamp AT TIME ZONE 'Africa/Johannesburg') - interval '1 microsecond' FROM auth.users;
    INSERT INTO public.member_wallet_transfers(id,sender_id,recipient_id,amount,currency,status,created_at,completed_at)
      SELECT gen_random_uuid(),id,id,10,'ZAR','completed',now()-interval '2 days',now()-interval '1 second' FROM auth.users;`);
  const activities = (await db.query('SELECT * FROM user_daily_activity')).rows;
  assert.equal(activities.filter(a => a.kind === 'settings').length, 2);
  assert.ok(!JSON.stringify(activities).includes('Secret Bank'));
  assert.ok(!JSON.stringify(activities).includes('never include this'));
  assert.ok(activities.some(a => a.changed_fields.includes('password')));
  const today = (await db.query('SELECT collect_admin_daily_activity(true) AS report')).rows[0].report;
  const previous = (await db.query('SELECT collect_admin_daily_activity(false) AS report')).rows[0].report;
  assert.equal(today.transactionsList.length, 1);
  assert.equal(today.transactionsList[0].amount, 42);
  assert.equal(previous.transactionsList.length, 1);
  assert.equal(previous.transactionsList[0].currency, 'USD');
  assert.equal(today.transfersList.length, 1, 'include transfers requested earlier but completed today');
  assert.equal(today.settingsList.length, 2);
  assert.equal(today.activeLoggedInCount, 1);
  await assert.rejects(db.exec('SET ROLE authenticated; SELECT * FROM public.user_daily_activity;'), /permission denied/);
  await db.exec('RESET ROLE');
  await assert.rejects(db.exec('SET ROLE authenticated; SELECT collect_admin_daily_activity(true);'), /permission denied/);
  await db.close();
});
