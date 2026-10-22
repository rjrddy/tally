import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import {
  canonical,
  posting,
  replay,
  sha,
  type JournalEvent,
} from "../src/model.js";
import {
  decide,
  Enricher,
  monitor,
  reconcile,
  type ReconRecord,
} from "../src/analysis.js";
import { defaultCatalog } from "../src/service.js";
const property = { seed: 42, numRuns: 120 };
function event(amount: bigint): JournalEvent {
  const p = posting({
    idempotency_key: "x",
    currency: "USD",
    day: "2026-01-01",
    description: "Synthetic fixture",
    lines: [
      { account_id: "a", amount_minor: String(amount) },
      { account_id: "b", amount_minor: String(-amount) },
    ],
  });
  const text = canonical(p),
    raw = JSON.stringify({ event_id: "event-x", seq: "1", request: p }),
    previous_hash = "0".repeat(64);
  return {
    seq: "1",
    event_id: "event-x",
    request_key: "x",
    currency: "USD",
    request_text: text,
    request_digest: sha(text),
    event_text: raw,
    previous_hash,
    hash: sha(previous_hash + raw),
  };
}
test("property: exact conservation beyond safe JavaScript integer range", () => {
  fc.assert(
    fc.property(fc.bigInt({ min: 1n, max: 999999999999999999n }), (a) => {
      const r = replay([event(a)]);
      assert.equal(
        BigInt(r.balances["USD:a"]!) + BigInt(r.balances["USD:b"]!),
        0n,
      );
    }),
    property,
  );
});
test("property: posting line order is semantically idempotent", () => {
  fc.assert(
    fc.property(fc.bigInt({ min: 1n, max: 999999999999999999n }), (a) => {
      const p = JSON.parse(event(a).request_text) as { lines: unknown[] };
      assert.equal(
        canonical(posting(p)),
        canonical(posting({ ...p, lines: [...p.lines].reverse() })),
      );
    }),
    property,
  );
});
test("property: every nonzero imbalance is rejected", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 1000000 }), (a) => {
      const p = JSON.parse(event(BigInt(a)).request_text) as {
        lines: { amount_minor: string }[];
      };
      p.lines[0]!.amount_minor = String(a + 1);
      assert.throws(() => posting(p));
    }),
    property,
  );
});
test("property: floating point money is rejected", () => {
  fc.assert(
    fc.property(fc.double({ noNaN: true, noDefaultInfinity: true }), (a) => {
      const p = JSON.parse(event(1n).request_text) as {
        lines: { amount_minor: unknown }[];
      };
      p.lines[0]!.amount_minor = a;
      assert.throws(() => posting(p));
    }),
    property,
  );
});
test("property: duplicate accounts cannot create a fake balanced journal", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 100000 }), (a) => {
      const p = JSON.parse(event(BigInt(a)).request_text) as {
        lines: { account_id: string }[];
      };
      p.lines[1]!.account_id = p.lines[0]!.account_id;
      assert.throws(() => posting(p));
    }),
    property,
  );
});
test("property: a changed event body fails its original hash binding", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 100000 }), (a) => {
      const e = event(BigInt(a));
      assert.throws(
        () => replay([{ ...e, event_text: e.event_text + " " }]),
        /corruption/,
      );
    }),
    property,
  );
});
test("property: a replayed event identity is rejected", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 100000 }), (a) =>
      assert.throws(() => replay([event(BigInt(a)), event(BigInt(a))])),
    ),
    property,
  );
});
test("property: request digest changes never pass replay", () => {
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 100000 }), (a) =>
      assert.throws(() =>
        replay([{ ...event(BigInt(a)), request_digest: "f".repeat(64) }]),
      ),
    ),
    property,
  );
});
test("property: decision boundaries use exact integer comparison", () => {
  fc.assert(
    fc.property(fc.bigInt({ min: 1n, max: 999999999999999998n }), (n) => {
      const input = {
          request_id: "q",
          amount_minor: String(n),
          risk_points: 20,
          country: "US",
          rule_version: "a".repeat(64),
        },
        rules = {
          max_amount_minor: String(n),
          risk_ceiling: 20,
          allowed_countries: ["US"],
        };
      assert.equal(decide(input, rules).approved, true);
      assert.equal(
        decide({ ...input, amount_minor: String(n + 1n) }, rules).approved,
        false,
      );
    }),
    property,
  );
});
test("property: reconciliation is input-order independent", () => {
  const rows: ReconRecord[] = Array.from({ length: 12 }, (_, i) => ({
    id: "b" + i,
    currency: "USD",
    amount_minor: String(1000 + i),
    day: "2026-01-01",
    description: "Synthetic cafe " + i,
  }));
  const ledger = rows.map((r, i) => ({ ...r, id: "l" + i }));
  fc.assert(
    fc.property(
      fc.shuffledSubarray(rows, {
        minLength: rows.length,
        maxLength: rows.length,
      }),
      (permutation) =>
        assert.deepEqual(
          reconcile(permutation, [...ledger].reverse()),
          reconcile(rows, ledger),
        ),
    ),
    property,
  );
});
test("reconciliation abstains on duplicate bank competition", () => {
  const record: ReconRecord = {
    id: "b",
    amount_minor: "1000",
    currency: "USD",
    day: "2026-01-01",
    description: "Synthetic cafe",
  };
  const r = reconcile(
    [record, { ...record, id: "b2" }],
    [{ ...record, id: "l" }],
  );
  assert.equal(r.matches.length, 0);
  assert.equal(r.exceptions.length, 2);
});
test("merchant cache is keyed by catalog version and bounded", () => {
  const e = new Enricher();
  const first = e.run(defaultCatalog[0]!.name, defaultCatalog);
  assert.equal(first.id, defaultCatalog[0]!.id);
  e.run(defaultCatalog[0]!.name, defaultCatalog);
  assert.equal(e.hits, 1);
  const changed = defaultCatalog.map((m, i) => ({
    ...m,
    name: i === 0 ? "Synthetic Different Vendor" : m.name,
  }));
  assert.notEqual(
    e.run(defaultCatalog[0]!.name, changed).catalog_version,
    first.catalog_version,
  );
  for (let i = 0; i < 520; i++) e.run("Unlisted " + i, defaultCatalog);
  assert.equal(e.size, 512);
});
test("freshness does not mistake ingestion time or a future point for freshness", () => {
  const now = Date.parse("2026-01-01T12:00:00Z"),
    config = { id: "feed", budget_ms: 60000, expected_ids: ["a", "b", "c"] };
  const r = monitor(
    config,
    [
      { id: "a", source_at: "2026-01-01T10:00:00Z", value_minor: "100" },
      { id: "b", source_at: "2026-01-01T11:00:00Z", value_minor: "10000" },
      { id: "future", source_at: "2026-01-02T12:00:00Z", value_minor: "10000" },
    ],
    now,
  );
  for (const kind of ["missing", "stale", "outlier", "future_timestamp"])
    assert.ok(r.alerts.some((a) => a.kind === kind));
});
