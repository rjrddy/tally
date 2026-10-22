import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import fc from "fast-check";
import { migrate, pool } from "../src/db.js";
import { Tally, defaultRules } from "../src/service.js";
import { canonical, sha } from "../src/model.js";
import type pg from "pg";
const schema = "tally_test_" + randomBytes(5).toString("hex");
process.env.TALLY_SCHEMA = schema;
let db: pg.Pool, admin: pg.Pool, t: Tally;
before(async () => {
  admin = pool(true);
  await migrate(admin);
  db = pool();
  t = new Tally(db);
});
after(async () => {
  await db?.end();
  await admin?.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin?.end();
});
async function accounts(prefix: string, negative = true) {
  await t.account({
    id: prefix + "_a",
    currency: "USD",
    allow_negative: negative,
  });
  await t.account({ id: prefix + "_b", currency: "USD", allow_negative: true });
}
function post(prefix: string, key: string, amount = "1000") {
  return {
    idempotency_key: key,
    currency: "USD",
    day: "2026-01-01",
    description: "Synthetic ledger fixture",
    lines: [
      { account_id: prefix + "_a", amount_minor: amount },
      { account_id: prefix + "_b", amount_minor: String(-BigInt(amount)) },
    ],
  };
}
test("database rejects runtime edits and unbalanced direct-function input atomically", async () => {
  await accounts("permissions");
  await assert.rejects(db.query("UPDATE accounts SET balance=1"), {
    code: "42501",
  });
  await assert.rejects(db.query("DELETE FROM ledger_events"), {
    code: "42501",
  });
  const p = post("permissions", "bad");
  p.lines[1]!.amount_minor = "-999";
  await assert.rejects(
    db.query("SELECT post_ledger($1)", [canonical(p)]),
    /unbalanced_posting/,
  );
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM ledger_events WHERE request_key='bad'",
      )
    ).rows[0].n,
    0,
  );
});
test("concurrent duplicated posting creates one event and one balance effect", async () => {
  await accounts("duplicate");
  const results = await Promise.all(
    Array.from({ length: 24 }, () =>
      t.post(post("duplicate", "duplicate-key")),
    ),
  );
  assert.equal(new Set(results.map((r) => r.event_id)).size, 1);
  assert.equal(results.filter((r) => !r.replayed).length, 1);
  assert.equal(
    (
      await db.query(
        "SELECT balance::text FROM accounts WHERE id='duplicate_a'",
      )
    ).rows[0].balance,
    "1000",
  );
  await assert.rejects(
    t.post(post("duplicate", "duplicate-key", "2000")),
    /idempotency_conflict/,
  );
});
test("database account lock prevents competing overdrafts", async () => {
  await accounts("overdraft", false);
  await t.post(post("overdraft", "fund", "100"));
  const spends = await Promise.allSettled([
    t.post(post("overdraft", "spend1", "-80")),
    t.post(post("overdraft", "spend2", "-80")),
  ]);
  assert.equal(spends.filter((s) => s.status === "fulfilled").length, 1);
  assert.equal(
    (
      await db.query(
        "SELECT balance::text FROM accounts WHERE id='overdraft_a'",
      )
    ).rows[0].balance,
    "20",
  );
});
test("currency mismatch rolls back the entire journal", async () => {
  await t.account({ id: "euros", currency: "EUR", allow_negative: true });
  await accounts("currency");
  const p = post("currency", "wrong-currency");
  p.lines[0]!.account_id = "euros";
  await assert.rejects(t.post(p), /account_currency_mismatch/);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM ledger_events WHERE request_key='wrong-currency'",
      )
    ).rows[0].n,
    0,
  );
});
test("property: actual Postgres postings conserve and replay exactly", async () => {
  await accounts("property");
  let id = 0;
  await fc.assert(
    fc.asyncProperty(
      fc.array(fc.integer({ min: 1, max: 1000000 }), {
        minLength: 1,
        maxLength: 8,
      }),
      async (values) => {
        for (const amount of values)
          await t.post(post("property", "prop_" + id++, String(amount)));
        const r = await t.rebuild();
        assert.equal(r.projection_equal, true);
        assert.equal(
          Object.entries(r.balances)
            .filter(([k]) => k.startsWith("USD:"))
            .reduce((sum, [, v]) => sum + BigInt(v), 0n),
          0n,
        );
      },
    ),
    { seed: 42, numRuns: 25 },
  );
});
test("projection corruption is detected and rebuilds the same balance digest", async () => {
  const before = await t.rebuild();
  await admin.query(
    `UPDATE ${schema}.accounts SET balance=balance+1 WHERE id='duplicate_a'`,
  );
  const corrupted = await t.rebuild();
  assert.equal(corrupted.projection_equal, false);
  assert.ok(corrupted.drift.includes("duplicate_a"));
  await t.rebuild(true);
  const restored = await t.rebuild();
  assert.equal(restored.projection_equal, true);
  assert.equal(restored.projection_sha256, before.projection_sha256);
});
test("rules and decisions remain immutable and exact after new publication", async () => {
  const original = await t.publishRule(defaultRules),
    changed = await t.publishRule({ ...defaultRules, risk_ceiling: 10 });
  const input = {
    request_id: "decision_1",
    rule_version: original.version,
    amount_minor: "1000",
    risk_points: 40,
    country: "US",
  };
  const first = await t.evaluate(input);
  assert.equal(first.approved, true);
  assert.deepEqual(await t.evaluate(input), first);
  await assert.rejects(
    t.evaluate({ ...input, rule_version: changed.version }),
    /idempotency_conflict/,
  );
  assert.equal(
    (
      await t.evaluate({
        ...input,
        request_id: "decision_2",
        rule_version: changed.version,
      })
    ).approved,
    false,
  );
  assert.deepEqual(await t.replayDecisions(), { decisions: 2, exact: 2 });
  await assert.rejects(
    db.query("UPDATE rules SET snapshot_text=$1", [canonical(defaultRules)]),
    { code: "42501" },
  );
  assert.equal(
    sha(
      canonical({
        ...defaultRules,
        allowed_countries: [...defaultRules.allowed_countries].sort(),
      }),
    ),
    original.version,
  );
});
test("a blocked decision query fails its budget instead of returning approval", async () => {
  const rule = await t.publishRule(defaultRules),
    lock = await admin.connect();
  await lock.query("BEGIN");
  await lock.query(`LOCK TABLE ${schema}.decisions IN ACCESS EXCLUSIVE MODE`);
  try {
    await assert.rejects(
      t.evaluate({
        request_id: "blocked_query",
        rule_version: rule.version,
        amount_minor: "1000",
        risk_points: 10,
        country: "US",
      }),
      /deadline/,
    );
  } finally {
    await lock.query("ROLLBACK");
    lock.release();
  }
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM decisions WHERE request_id='blocked_query'",
      )
    ).rows[0].n,
    0,
  );
});
test("reconciliation review races cannot assign one ledger record twice", async () => {
  await accounts("review");
  const event = await t.post(post("review", "review-post"));
  const bank = ["bank_a", "bank_b"].map((id) => ({
    id,
    amount_minor: "1000",
    currency: "USD",
    day: "2026-01-01",
    description: "Synthetic ledger fixture",
  }));
  const batch = await t.reconciliation({
    batch_id: "review_batch",
    account_id: "review_a",
    bank,
  });
  assert.equal(
    (batch.result as { exceptions: unknown[] }).exceptions.length,
    2,
  );
  const results = await Promise.allSettled(
    bank.map((b, i) =>
      t.resolve({
        resolution_id: "resolution_" + i,
        batch_id: "review_batch",
        bank_id: b.id,
        ledger_id: event.event_id,
        expected_version: 0,
        reason: "Operator inspected synthetic fixture",
      }),
    ),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int AS n FROM recon_matches WHERE batch_id='review_batch'",
      )
    ).rows[0].n,
    1,
  );
});
test("source point identity cannot be silently rewritten", async () => {
  await t.feed({ id: "prices", budget_ms: 60000, expected_ids: ["one"] });
  const point = {
    id: "one",
    source_at: "2026-01-01T00:00:00Z",
    value_minor: "1000",
  };
  assert.equal((await t.point("prices", point)).accepted, true);
  assert.equal((await t.point("prices", point)).accepted, false);
  await assert.rejects(
    t.point("prices", { ...point, value_minor: "1001" }),
    /identity_conflict/,
  );
});
