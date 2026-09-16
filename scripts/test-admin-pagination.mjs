import assert from "node:assert/strict";
import { test } from "node:test";
import { readAllRows } from "../supabase/functions/app-api/pagination.ts";

test("includes members beyond 500 and wallets beyond 1000", async () => {
  const expected = Array.from({ length: 1253 }, (_, id) => ({ id }));
  const rows = await readAllRows(async (from, to) => ({
    data: expected.slice(from, to + 1), error: null,
  }));
  assert.deepEqual(rows, expected);
});

test("handles a server cap smaller than the requested page", async () => {
  const expected = Array.from({ length: 550 }, (_, id) => ({ id }));
  assert.deepEqual(await readAllRows(async (from) => ({
    data: expected.slice(from, from + 100), error: null,
  })), expected);
});

test("does not return misleading partial results when a later page fails", async () => {
  await assert.rejects(readAllRows(async (from) => from === 0
    ? { data: [{ id: 1 }], error: null }
    : { data: null, error: { message: "Connection lost" } }), /Connection lost/);
});

test("handles an empty member list", async () => {
  assert.deepEqual(await readAllRows(async () => ({ data: [], error: null })), []);
});
