// Run with PGLITE_MODULE pointing to @electric-sql/pglite/dist/index.js.
// Entirely isolated: no live users, money, or messages are touched.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

const { PGlite } = await import(pathToFileURL(process.env.PGLITE_MODULE).href);
const migrations = new URL("../supabase/migrations/", import.meta.url);

test("rollback removes reminder triggers and WhatsApp objects while preserving notifications and presence", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE SCHEMA auth;
      CREATE TABLE auth.users(id uuid PRIMARY KEY, email text, created_at timestamptz DEFAULT now(), last_sign_in_at timestamptz, deleted_at timestamptz, banned_until timestamptz);
      CREATE TABLE profiles(id uuid PRIMARY KEY REFERENCES auth.users(id), phone text, account_frozen boolean DEFAULT false, welcome_bonus_credited_at timestamptz, account_id text, first_name text, surname text);
      CREATE TABLE transactions(user_id uuid, reference text);
      CREATE TABLE signup_risk_signals(user_id uuid, signal_type text, signal_hash text);
      CREATE TABLE signup_identity_history(first_user_id uuid, signal_type text, signal_hash text, bonus_claimed_at timestamptz);
      CREATE TABLE bonus_test_installations(signal_hash text);
      CREATE TABLE user_presence(user_id uuid PRIMARY KEY REFERENCES auth.users(id), last_seen_at timestamptz);
      CREATE TABLE withdrawable_credit_email_queue(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_key text UNIQUE,
        user_id uuid, recipient_email text, recipient_name text, recipient_phone text,
        currency text, amount numeric, reason text, notification_kind text,
        cycle_label text, maturity_date timestamptz, created_at timestamptz DEFAULT now(),
        next_attempt_at timestamptz, sms_status text, sms_next_attempt_at timestamptz
      );
      INSERT INTO auth.users(id,email) VALUES ('00000000-0000-0000-0000-000000000001','member@example.test');
      INSERT INTO profiles(id,phone,first_name) VALUES ('00000000-0000-0000-0000-000000000001','+27820000000','Member');
      INSERT INTO withdrawable_credit_email_queue(event_key,sms_status) VALUES ('existing-notification','sent');
    `);
    for (const file of (await readdir(migrations)).filter(f => /^20260916/.test(f)).sort()) {
      await db.exec(await readFile(new URL(file, migrations), "utf8"));
    }
    // Re-running the reversal is also safe.
    await db.exec(await readFile(new URL("20260916140000_restore_email_sms_notifications.sql", migrations), "utf8"));
    const removed = await db.query(`
      SELECT proname FROM pg_proc WHERE pronamespace='public'::regnamespace
      AND (proname LIKE '%whatsapp%' OR proname LIKE '%welcome_bonus%reminder%' OR proname LIKE '%welcome_bonus_sms%')
    `);
    assert.equal(removed.rows.length, 0);
    const columns = await db.query("SELECT column_name FROM information_schema.columns WHERE table_name='withdrawable_credit_email_queue' AND column_name LIKE 'whatsapp%'");
    assert.equal(columns.rows.length, 0);
    const triggers = await db.query("SELECT tgname FROM pg_trigger WHERE tgname IN ('track_welcome_bonus_sms_activity','enqueue_welcome_note_whatsapp')");
    assert.equal(triggers.rows.length, 0);
    await db.exec(`
      SELECT enqueue_fund_notification('new-notification','00000000-0000-0000-0000-000000000001','ZAR',100,'Deposit approved','deposit_approved');
      INSERT INTO auth.users(id,email) VALUES ('00000000-0000-0000-0000-000000000002','new@example.test');
      INSERT INTO user_presence VALUES ('00000000-0000-0000-0000-000000000001',now()),('00000000-0000-0000-0000-000000000002',now());
    `);
    assert.deepEqual((await db.query("SELECT event_key,sms_status FROM withdrawable_credit_email_queue ORDER BY event_key")).rows, [
      { event_key: "existing-notification", sms_status: "sent" },
      { event_key: "new-notification", sms_status: "pending" },
    ]);
    assert.deepEqual((await db.query("SELECT admin_user_counts() AS counts")).rows[0].counts,
      { count: 1, onlineCount: 1, authUserCount: 2 });
    await db.exec("UPDATE user_presence SET last_seen_at=now()-interval '3 minutes'");
    assert.equal((await db.query("SELECT admin_user_counts() AS counts")).rows[0].counts.onlineCount, 0);
    assert.equal((await db.query("SELECT has_function_privilege('authenticated','admin_user_counts()','execute') AS allowed")).rows[0].allowed, false);
  } finally {
    await db.close();
  }
});
