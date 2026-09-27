import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

test('existing profiles, signups and legacy currency updates all use ZAR without changing funds', async () => {
  const { PGlite } = await import(pathToFileURL(process.env.PGLITE_MODULE).href);
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated;
      CREATE TABLE profiles(id integer PRIMARY KEY, primary_currency text DEFAULT 'USD');
      CREATE TABLE wallets(user_id integer, currency text, balance numeric);
      CREATE TABLE transactions(user_id integer, currency text, amount numeric);
      INSERT INTO profiles VALUES (1,'USD'),(2,'ZAR');
      INSERT INTO wallets VALUES (1,'USD',10),(1,'ZAR',200);
      INSERT INTO transactions VALUES (1,'USD',10);
    `);
    const balances = (await db.query('SELECT * FROM wallets ORDER BY currency')).rows;
    const history = (await db.query('SELECT * FROM transactions')).rows;
    const migration = await readFile(new URL('../supabase/migrations/20260927100000_standardize_primary_currency_zar.sql', import.meta.url), 'utf8');
    await db.exec(migration);
    await db.exec(migration);
    await db.exec(`INSERT INTO profiles VALUES (3,'USD'); INSERT INTO profiles(id) VALUES (4); UPDATE profiles SET primary_currency='USD' WHERE id=1;`);
    assert.equal((await db.query("SELECT * FROM profiles WHERE primary_currency IS DISTINCT FROM 'ZAR'")).rows.length, 0);
    assert.equal((await db.query('SELECT * FROM profiles')).rows.length, 4);
    assert.deepEqual((await db.query('SELECT * FROM wallets ORDER BY currency')).rows, balances);
    assert.deepEqual((await db.query('SELECT * FROM transactions')).rows, history);
  } finally { await db.close(); }
});
