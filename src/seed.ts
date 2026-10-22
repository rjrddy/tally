import { reconciliationFixture } from "./fixtures.js";
import { schemaName } from "./db.js";
import { defaultCatalog, defaultRules, type Tally } from "./service.js";
export async function seed(t: Tally) {
  const c = await t.db.connect();
  try {
    await c.query("SELECT pg_advisory_lock(hashtextextended($1,0))", [
      schemaName() + ":seed",
    ]);
    if (
      (
        await c.query(
          "SELECT 1 FROM audit WHERE kind='seed_complete' AND body->>'version'='v1'",
        )
      ).rowCount
    )
      return { seeded: false };
    const existing = (
      await c.query<{ body: { at: string } }>(
        "SELECT body FROM audit WHERE kind='seed_anchor' ORDER BY id LIMIT 1",
      )
    ).rows[0];
    const at = existing?.body.at ?? new Date().toISOString();
    if (!existing) await t.audit("seed_anchor", { at });
    for (const [id, allow_negative] of [
      ["cash", false],
      ["clearing", true],
      ["external", true],
      ["recon_cash", true],
      ["recon_external", true],
    ] as const)
      await t.account({ id, currency: "USD", allow_negative });
    await t.post({
      idempotency_key: "seed_opening",
      currency: "USD",
      day: "2026-01-01",
      description: "Synthetic opening balance",
      lines: [
        { account_id: "cash", amount_minor: "1000000" },
        { account_id: "external", amount_minor: "-1000000" },
      ],
    });
    await t.publishRule(defaultRules);
    await t.publishCatalog(defaultCatalog);
    const fixture = reconciliationFixture(42, 40),
      ids = new Map<string, string>();
    for (const l of fixture.ledger) {
      const event = await t.post({
        idempotency_key: "seed_" + l.id,
        currency: l.currency,
        day: l.day,
        description: l.description,
        lines: [
          { account_id: "recon_cash", amount_minor: l.amount_minor },
          {
            account_id: "recon_external",
            amount_minor: String(-BigInt(l.amount_minor)),
          },
        ],
      });
      ids.set(l.id, event.event_id);
    }
    await t.reconciliation({
      batch_id: "seed_reconciliation",
      account_id: "recon_cash",
      bank: fixture.bank,
    });
    for (const id of ["synthetic_merchant_feed", "synthetic_market_feed"])
      await t.feed({
        id,
        budget_ms: 60000,
        expected_ids: ["point_1", "point_2", "point_3"],
      });
    const clock = Date.parse(at);
    for (let i = 1; i <= 3; i++)
      await t.point("synthetic_merchant_feed", {
        id: "point_" + i,
        source_at: new Date(clock - (3 - i) * 1000).toISOString(),
        value_minor: String(1000 + i),
      });
    await t.point("synthetic_market_feed", {
      id: "point_1",
      source_at: new Date(clock - 7200000).toISOString(),
      value_minor: "1000",
    });
    await t.point("synthetic_market_feed", {
      id: "point_3",
      source_at: new Date(clock - 7100000).toISOString(),
      value_minor: "100000",
    });
    await t.point("synthetic_market_feed", {
      id: "future_point",
      source_at: new Date(clock + 86400000).toISOString(),
      value_minor: "1000",
    });
    await t.audit("seed_complete", {
      version: "v1",
      at,
      recon_ledger_rows: ids.size,
    });
    return { seeded: true, recon_ledger_rows: ids.size };
  } finally {
    await c.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [
      schemaName() + ":seed",
    ]);
    c.release();
  }
}
