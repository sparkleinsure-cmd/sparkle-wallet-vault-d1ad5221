// Isolated database checks; never connects to production or sends mail.
// Run with PGLITE_MODULE pointing to @electric-sql/pglite/dist/index.js.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { withdrawalEmailContent } from "../supabase/functions/admin-withdrawal-request-email/email.ts";

test("email includes the requested details and escapes user-supplied HTML", () => {
  const mail = withdrawalEmailContent({
    notification_id: "test", transaction_id: "withdrawal-test", account_id: "SP123",
    user_name: "<script>Example</script>", bank_name: "Example bank",
    bank_account_number: "0012345678", amount: "123.45", currency: "ZAR",
    submitted_at: "2026-09-26T10:00:00Z",
  });
  for (const detail of ["Account ID: SP123", "Bank account number: 0012345678", "ZAR 123.45", "withdrawal-test"]) {
    assert.ok(mail.text.includes(detail));
  }
  assert.ok(!mail.html.includes("<script>"));
  assert.ok(mail.html.includes("&lt;script&gt;"));
});

test("worker sends only to the admin and records provider failures for retry", async () => {
  const source = await readFile(new URL("../supabase/functions/admin-withdrawal-request-email/index.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source.replace(/^import .*;\r?\n/gm, ""), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const alert = {
    notification_id: "stable-notification", transaction_id: "test-transaction",
    account_id: "SP123", user_name: "Test", bank_name: "Bank",
    bank_account_number: "0012345678", currency: "ZAR", amount: 12,
    submitted_at: "2026-09-26T10:00:00Z",
  };
  let handler;
  let providerOk = true;
  const requests = [];
  const completions = [];
  let claims = 0;
  vm.runInNewContext(compiled, {
    Response, AbortSignal, withdrawalEmailContent,
    Deno: { env: { get: key => ({ SUPABASE_URL: "https://example.test", SUPABASE_SERVICE_ROLE_KEY: "test", RESEND_API_KEY: "test" })[key] } },
    serve: callback => { handler = callback; },
    createClient: () => ({ rpc: async (name, args) => {
      if (name === "claim_admin_withdrawal_request_emails") { claims++; return { data: [alert] }; }
      assert.equal(name, "complete_admin_withdrawal_request_email");
      completions.push(args);
      return { error: null };
    } }),
    fetch: async (url, options) => {
      assert.equal(url, "https://api.resend.com/emails");
      requests.push(options);
      return new Response(JSON.stringify(providerOk ? { id: "provider-test" } : { error: "temporary" }), { status: providerOk ? 200 : 503 });
    },
  });
  assert.equal((await handler(new Request("https://example.test"))).status, 200);
  assert.equal(claims, 0, "health check never claims or sends");
  await handler(new Request("https://example.test", { method: "POST", body: JSON.stringify({ to: "attacker@example.test" }) }));
  assert.deepEqual(JSON.parse(requests[0].body).to, ["sparkleinsure@gmail.com"]);
  assert.equal(completions[0].p_success, true);
  providerOk = false;
  await handler(new Request("https://example.test", { method: "POST" }));
  assert.equal(completions[1].p_success, false);
  assert.equal(requests[0].headers["Idempotency-Key"], requests[1].headers["Idempotency-Key"]);
});

test("withdrawal queue snapshots details, isolates other events, retries and restricts access", async () => {
  const { PGlite } = await import(pathToFileURL(process.env.PGLITE_MODULE).href);
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA net; CREATE SCHEMA cron;
      CREATE TABLE cron.job(jobname text PRIMARY KEY, schedule text, command text);
      CREATE FUNCTION cron.schedule(text,text,text) RETURNS bigint LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO cron.job VALUES ($1,$2,$3); RETURN 1; END; $$;
      CREATE FUNCTION net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer)
        RETURNS bigint LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'dispatcher unavailable'; END; $$;
      CREATE TABLE profiles(id uuid PRIMARY KEY,account_id text,first_name text,surname text,bank_name text,bank_account_number text);
      CREATE TABLE transactions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid,type text,status text,currency text,amount numeric,created_at timestamptz DEFAULT now());
      INSERT INTO profiles VALUES ('00000000-0000-0000-0000-000000000001','SP123','Test','Member','Example bank','0012345678');
      INSERT INTO transactions(user_id,type,status,currency,amount)
        VALUES ('00000000-0000-0000-0000-000000000001','withdrawal','pending','ZAR',99);
    `);
    const migration = (await readFile(new URL("../supabase/migrations/20260926100000_add_admin_withdrawal_request_emails.sql", import.meta.url), "utf8"))
      .replace(/^CREATE EXTENSION[^;]+;\s*/gm, "");
    await db.exec(migration);
    await db.exec(migration);
    assert.equal((await db.query("SELECT * FROM cron.job")).rows.length, 1);
    assert.equal((await db.query("SELECT * FROM admin_withdrawal_request_email_queue")).rows.length, 0, "no old request backfill");
    await db.exec(`
      INSERT INTO transactions(user_id,type,status,currency,amount) VALUES
        ('00000000-0000-0000-0000-000000000001','deposit','pending','ZAR',10),
        ('00000000-0000-0000-0000-000000000001','withdrawal','completed','ZAR',20),
        ('00000000-0000-0000-0000-000000000001','withdrawal','pending','ZAR',123.45);
      UPDATE profiles SET bank_account_number='9999999999';
    `);
    const first = (await db.query("SELECT * FROM claim_admin_withdrawal_request_emails(5)")).rows;
    assert.equal(first.length, 1);
    assert.equal(first[0].bank_account_number, "0012345678", "uses details at request time");
    assert.equal(first[0].account_id, "SP123");
    assert.equal(Number(first[0].amount), 123.45);
    assert.equal((await db.query("SELECT * FROM claim_admin_withdrawal_request_emails(5)")).rows.length, 0, "active claim cannot be claimed twice");
    const id = first[0].notification_id;
    await db.query("SELECT complete_admin_withdrawal_request_email($1,false,NULL,'temporary failure')", [id]);
    assert.equal((await db.query("SELECT * FROM claim_admin_withdrawal_request_emails(5)")).rows.length, 0, "retry waits for backoff");
    await db.exec("UPDATE admin_withdrawal_request_email_queue SET next_attempt_at=now()-interval '1 minute'");
    assert.equal((await db.query("SELECT * FROM claim_admin_withdrawal_request_emails(5)")).rows[0].notification_id, id);
    await db.exec("UPDATE admin_withdrawal_request_email_queue SET locked_at=now()-interval '11 minutes'");
    assert.equal((await db.query("SELECT * FROM claim_admin_withdrawal_request_emails(5)")).rows.length, 1, "stale claims recover");
    await db.query("SELECT complete_admin_withdrawal_request_email($1,true,'provider-test',NULL)", [id]);
    assert.equal((await db.query("SELECT * FROM claim_admin_withdrawal_request_emails(5)")).rows.length, 0, "sent alerts stay sent");
    await db.exec("BEGIN; INSERT INTO transactions(user_id,type,status,currency,amount) VALUES ('00000000-0000-0000-0000-000000000001','withdrawal','pending','ZAR',5); ROLLBACK;");
    assert.equal((await db.query("SELECT * FROM admin_withdrawal_request_email_queue")).rows.length, 1, "rolled-back withdrawals never queue");
    const privileges = (await db.query(`SELECT
      has_table_privilege('authenticated','admin_withdrawal_request_email_queue','SELECT') AS can_read,
      has_function_privilege('anon','claim_admin_withdrawal_request_emails(integer)','EXECUTE') AS can_claim,
      has_function_privilege('service_role','claim_admin_withdrawal_request_emails(integer)','EXECUTE') AS worker_can_claim`)).rows[0];
    assert.deepEqual(privileges, { can_read: false, can_claim: false, worker_can_claim: true });
  } finally { await db.close(); }
});
