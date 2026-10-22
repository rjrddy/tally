import { randomUUID } from "node:crypto";
import type pg from "pg";
import { z } from "zod";
import {
  catalogSchema,
  decide,
  decisionSchema,
  Enricher,
  feedSchema,
  monitor,
  pointSchema,
  reconcile,
  ruleSchema,
  type Merchant,
  type ReconRecord,
} from "./analysis.js";
import {
  accountSchema,
  canonical,
  DomainError,
  identity,
  posting,
  replay,
  sha,
  type JournalEvent,
} from "./model.js";
import { schemaName } from "./db.js";

export function databaseError(error: unknown): never {
  if (error instanceof DomainError || error instanceof z.ZodError) throw error;
  const e = error as { code?: string; message?: string };
  const known = [
    "idempotency_conflict",
    "insufficient_balance",
    "account_currency_mismatch",
    "invalid_posting",
    "unbalanced_posting",
  ];
  if (e.code === "P0001" && e.message && known.includes(e.message))
    throw new DomainError(
      e.message,
      e.message === "invalid_posting" || e.message === "unbalanced_posting"
        ? 422
        : 409,
    );
  if (e.code === "23505") throw new DomainError("concurrent_identity_conflict");
  if (e.code === "57014") throw new DomainError("database_deadline", 504);
  throw new DomainError("database_unavailable", 503);
}
export class Tally {
  private readonly enricher = new Enricher();
  private activeDecisions = 0;
  constructor(public readonly db: pg.Pool) {}
  async onApplicationShutdown(): Promise<void> {
    await this.db.end();
  }
  async audit(
    kind: string,
    body: unknown,
    client: pg.Pool | pg.PoolClient = this.db,
  ): Promise<void> {
    await client.query("INSERT INTO audit(kind,body) VALUES($1,$2)", [
      kind,
      body,
    ]);
  }
  async account(input: unknown) {
    const value = accountSchema.parse(input);
    const c = await this.db.connect();
    try {
      await c.query("BEGIN");
      const inserted = await c.query(
        "INSERT INTO accounts(id,currency,allow_negative) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING RETURNING id",
        [value.id, value.currency, value.allow_negative],
      );
      const row = (
        await c.query<{
          id: string;
          currency: string;
          allow_negative: boolean;
          balance: string;
        }>("SELECT * FROM accounts WHERE id=$1", [value.id])
      ).rows[0]!;
      if (
        row.currency !== value.currency ||
        row.allow_negative !== value.allow_negative
      )
        throw new DomainError("account_identity_conflict");
      if (inserted.rowCount) await this.audit("account_created", value, c);
      await c.query("COMMIT");
      return row;
    } catch (error) {
      await c.query("ROLLBACK");
      return databaseError(error);
    } finally {
      c.release();
    }
  }
  async post(input: unknown) {
    const request = posting(input);
    try {
      return (
        await this.db.query<{
          result: {
            event_id: string;
            seq: string;
            hash: string;
            replayed: boolean;
          };
        }>("SELECT post_ledger($1) AS result", [canonical(request)])
      ).rows[0]!.result;
    } catch (error) {
      return databaseError(error);
    }
  }
  async rebuild(repair = false) {
    const c = await this.db.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        schemaName() + ":ledger",
      ]);
      const records = (
        await c.query<JournalEvent>(
          "SELECT seq::text,event_id::text,request_key,currency,request_text,request_digest,event_text,previous_hash,hash FROM ledger_events ORDER BY ledger_events.seq",
        )
      ).rows;
      const result = replay(records);
      const accounts = (
        await c.query<{ id: string; currency: string; balance: string }>(
          "SELECT id,currency,balance::text FROM accounts ORDER BY currency,id",
        )
      ).rows;
      const expected = Object.fromEntries(
        accounts.map((a) => [
          a.currency + ":" + a.id,
          result.balances[a.currency + ":" + a.id] ?? "0",
        ]),
      );
      const actual = Object.fromEntries(
        accounts.map((a) => [a.currency + ":" + a.id, a.balance]),
      );
      const drift = accounts
        .filter((a) => a.balance !== expected[a.currency + ":" + a.id])
        .map((a) => a.id);
      if (repair) await c.query("SELECT repair_balances()");
      await c.query("COMMIT");
      return {
        ...result,
        balances: expected,
        actual_balances: actual,
        projection_equal: drift.length === 0,
        drift,
        rebuilt: repair,
        projection_sha256: sha(canonical(expected)),
      };
    } catch (error) {
      await c.query("ROLLBACK");
      if (error instanceof DomainError) throw error;
      return databaseError(error);
    } finally {
      c.release();
    }
  }
  async publishRule(input: unknown) {
    const rules = ruleSchema.parse(input);
    rules.allowed_countries.sort();
    const snapshot = canonical(rules),
      version = sha(snapshot);
    await this.db.query(
      "INSERT INTO rules(version,snapshot_text) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [version, snapshot],
    );
    return { version, rules };
  }
  async evaluate(input: unknown) {
    const request = decisionSchema.parse(input);
    if (this.activeDecisions >= 32)
      throw new DomainError("decision_capacity", 429);
    this.activeDecisions++;
    const work = this.persistDecision(request).finally(() => {
      this.activeDecisions--;
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new DomainError("decision_deadline_retry_same_id", 504)),
            100,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  private async persistDecision(request: z.infer<typeof decisionSchema>) {
    const c = await this.db.connect();
    try {
      await c.query("BEGIN");
      await c.query("SET LOCAL statement_timeout='80ms'");
      const stored = (
        await c.query<{ snapshot_text: string }>(
          "SELECT snapshot_text FROM rules WHERE version=$1",
          [request.rule_version],
        )
      ).rows[0];
      if (!stored) throw new DomainError("unknown_rule_version", 404);
      if (sha(stored.snapshot_text) !== request.rule_version)
        throw new DomainError("rule_integrity");
      const result = decide(
          request,
          ruleSchema.parse(JSON.parse(stored.snapshot_text) as unknown),
        ),
        text = canonical(request);
      const inserted = await c.query(
        "INSERT INTO decisions(request_id,input_text,version,result_text) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING request_id",
        [request.request_id, text, request.rule_version, canonical(result)],
      );
      const existing = (
        await c.query<{ input_text: string; result_text: string }>(
          "SELECT input_text,result_text FROM decisions WHERE request_id=$1",
          [request.request_id],
        )
      ).rows[0]!;
      if (existing.input_text !== text)
        throw new DomainError("decision_idempotency_conflict");
      if (inserted.rowCount)
        await this.audit(
          "decision_recorded",
          {
            request_id: request.request_id,
            version: request.rule_version,
            approved: result.approved,
          },
          c,
        );
      await c.query("COMMIT");
      return JSON.parse(existing.result_text) as ReturnType<typeof decide>;
    } catch (error) {
      await c.query("ROLLBACK");
      return databaseError(error);
    } finally {
      c.release();
    }
  }
  async replayDecisions() {
    const rows = (
      await this.db.query<{
        input_text: string;
        result_text: string;
        version: string;
        snapshot_text: string;
      }>(
        "SELECT d.input_text,d.result_text,d.version,r.snapshot_text FROM decisions d JOIN rules r ON r.version=d.version ORDER BY d.request_id",
      )
    ).rows;
    let exact = 0;
    for (const row of rows) {
      if (sha(row.snapshot_text) !== row.version)
        throw new DomainError("rule_integrity");
      const input = decisionSchema.parse(JSON.parse(row.input_text) as unknown);
      if (
        input.rule_version !== row.version ||
        canonical(
          decide(
            input,
            ruleSchema.parse(JSON.parse(row.snapshot_text) as unknown),
          ),
        ) !== row.result_text
      )
        throw new DomainError("decision_replay_mismatch");
      exact++;
    }
    return { decisions: rows.length, exact };
  }
  async publishCatalog(input: unknown) {
    const catalog = catalogSchema
        .parse(input)
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
      text = canonical(catalog),
      version = sha(text);
    await this.db.query(
      "INSERT INTO catalogs(version,snapshot_text) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [version, text],
    );
    return { version, catalog };
  }
  async enrich(input: unknown) {
    const request = z
      .object({
        descriptor: z.string().min(1).max(256),
        catalog_version: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .parse(input);
    const row = (
      await this.db.query<{ snapshot_text: string }>(
        "SELECT snapshot_text FROM catalogs WHERE version=$1",
        [request.catalog_version],
      )
    ).rows[0];
    if (!row) throw new DomainError("unknown_catalog_version", 404);
    if (sha(row.snapshot_text) !== request.catalog_version)
      throw new DomainError("catalog_integrity");
    const catalog = catalogSchema.parse(
      JSON.parse(row.snapshot_text) as unknown,
    );
    return {
      ...this.enricher.run(request.descriptor, catalog),
      cache: {
        hits: this.enricher.hits,
        misses: this.enricher.misses,
        size: this.enricher.size,
      },
    };
  }
  async reconciliation(input: unknown) {
    const request = z
      .object({
        batch_id: identity,
        account_id: identity,
        bank: z.array(z.unknown()).max(1000),
      })
      .strict()
      .parse(input);
    const { recordSchema } = await import("./analysis.js");
    const bank = request.bank.map((r) => recordSchema.parse(r));
    if (new Set(bank.map((r) => r.id)).size !== bank.length)
      throw new DomainError("duplicate_bank_identity", 422);
    const digest = sha(canonical(request));
    const c = await this.db.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        schemaName() + ":recon:" + request.batch_id,
      ]);
      const prior = (
        await c.query<{ input_digest: string; summary: unknown }>(
          "SELECT * FROM recon_batches WHERE id=$1",
          [request.batch_id],
        )
      ).rows[0];
      if (prior) {
        if (prior.input_digest !== digest)
          throw new DomainError("batch_idempotency_conflict");
        await c.query("COMMIT");
        return {
          batch_id: request.batch_id,
          result: prior.summary,
          replayed: true,
        };
      }
      const rows = (
        await c.query<{
          id: string;
          amount_minor: string;
          currency: ReconRecord["currency"];
          day: string;
          description: string;
        }>(
          `SELECT e.event_id::text AS id,l.amount::text AS amount_minor,e.currency,e.request_text::jsonb->>'day' AS day,e.request_text::jsonb->>'description' AS description FROM ledger_lines l JOIN ledger_events e ON e.event_id=l.event_id WHERE l.account_id=$1 ORDER BY e.seq LIMIT 1001`,
          [request.account_id],
        )
      ).rows;
      if (rows.length > 1000)
        throw new DomainError("reconciliation_snapshot_limit", 413);
      const result = reconcile(bank, rows);
      await c.query(
        "INSERT INTO recon_batches(id,input_digest,bank,ledger,summary) VALUES($1,$2,$3,$4,$5)",
        [
          request.batch_id,
          digest,
          JSON.stringify(bank),
          JSON.stringify(rows),
          result,
        ],
      );
      for (const row of result.matches)
        await c.query(
          "INSERT INTO recon_matches VALUES($1,$2,$3,'automatic',$4)",
          [request.batch_id, row.bank, row.ledger, row],
        );
      for (const row of result.exceptions)
        await c.query(
          "INSERT INTO recon_exceptions(batch_id,bank_id,reason) VALUES($1,$2,$3)",
          [request.batch_id, row.bank, row.reason],
        );
      await this.audit(
        "reconciliation_recorded",
        {
          batch_id: request.batch_id,
          matches: result.matches.length,
          exceptions: result.exceptions.length,
        },
        c,
      );
      await c.query("COMMIT");
      return { batch_id: request.batch_id, result, replayed: false };
    } catch (error) {
      await c.query("ROLLBACK");
      return databaseError(error);
    } finally {
      c.release();
    }
  }
  async resolve(input: unknown) {
    const request = z
      .object({
        resolution_id: identity,
        batch_id: identity,
        bank_id: identity,
        ledger_id: z.uuid(),
        expected_version: z.number().int().min(0),
        reason: z.string().min(5).max(200),
      })
      .strict()
      .parse(input);
    const digest = sha(canonical(request)),
      c = await this.db.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        schemaName() + ":resolution:" + request.resolution_id,
      ]);
      const prior = (
        await c.query<{ input_digest: string }>(
          "SELECT input_digest FROM resolutions WHERE id=$1",
          [request.resolution_id],
        )
      ).rows[0];
      if (prior) {
        if (prior.input_digest !== digest)
          throw new DomainError("resolution_idempotency_conflict");
        await c.query("COMMIT");
        return { resolved: true, replayed: true };
      }
      const row = (
        await c.query<{ status: string; version: number }>(
          "SELECT status,version FROM recon_exceptions WHERE batch_id=$1 AND bank_id=$2 FOR UPDATE",
          [request.batch_id, request.bank_id],
        )
      ).rows[0];
      if (
        !row ||
        row.status !== "open" ||
        row.version !== request.expected_version
      )
        throw new DomainError("review_version_conflict");
      const batch = (
        await c.query<{ bank: ReconRecord[]; ledger: ReconRecord[] }>(
          "SELECT bank,ledger FROM recon_batches WHERE id=$1",
          [request.batch_id],
        )
      ).rows[0]!;
      const bank = batch.bank.find((r) => r.id === request.bank_id),
        ledger = batch.ledger.find((r) => r.id === request.ledger_id);
      if (
        !bank ||
        !ledger ||
        bank.currency !== ledger.currency ||
        bank.amount_minor !== ledger.amount_minor
      )
        throw new DomainError("incompatible_review_selection", 422);
      await c.query(
        "INSERT INTO recon_matches VALUES($1,$2,$3,'reviewed',$4)",
        [
          request.batch_id,
          request.bank_id,
          request.ledger_id,
          { reason: request.reason },
        ],
      );
      await c.query(
        "UPDATE recon_exceptions SET status='resolved',version=version+1 WHERE batch_id=$1 AND bank_id=$2",
        [request.batch_id, request.bank_id],
      );
      await c.query(
        "INSERT INTO resolutions(id,batch_id,bank_id,ledger_id,reason,input_digest) VALUES($1,$2,$3,$4,$5,$6)",
        [
          request.resolution_id,
          request.batch_id,
          request.bank_id,
          request.ledger_id,
          request.reason,
          digest,
        ],
      );
      await this.audit(
        "exception_resolved",
        {
          resolution_id: request.resolution_id,
          batch_id: request.batch_id,
          bank_id: request.bank_id,
          ledger_id: request.ledger_id,
          reason: request.reason,
        },
        c,
      );
      await c.query("COMMIT");
      return { resolved: true, replayed: false };
    } catch (error) {
      await c.query("ROLLBACK");
      return databaseError(error);
    } finally {
      c.release();
    }
  }
  async feed(input: unknown) {
    const f = feedSchema.parse(input);
    await this.db.query(
      "INSERT INTO feeds(id,budget_ms,expected_ids) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET budget_ms=excluded.budget_ms,expected_ids=excluded.expected_ids",
      [f.id, f.budget_ms, JSON.stringify(f.expected_ids)],
    );
    await this.audit("feed_configured", f);
    return f;
  }
  async point(feedId: string, input: unknown) {
    identity.parse(feedId);
    const p = pointSchema.parse(input);
    const rows = await this.db.query(
      "INSERT INTO points(feed_id,id,source_at,value) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING id",
      [feedId, p.id, p.source_at, p.value_minor],
    );
    const prior = (
      await this.db.query<{ source_at: Date; value: string }>(
        "SELECT source_at,value::text FROM points WHERE feed_id=$1 AND id=$2",
        [feedId, p.id],
      )
    ).rows[0];
    if (
      !prior ||
      prior.source_at.toISOString() !== new Date(p.source_at).toISOString() ||
      prior.value !== p.value_minor
    )
      throw new DomainError("feed_identity_conflict");
    return { accepted: Boolean(rows.rowCount) };
  }
  async freshness() {
    const feeds = (
      await this.db.query<{
        id: string;
        budget_ms: number;
        expected_ids: string[];
      }>("SELECT * FROM feeds ORDER BY id")
    ).rows;
    const result = [];
    for (const feed of feeds) {
      const points = (
        await this.db.query<{
          id: string;
          source_at: Date;
          value_minor: string;
        }>(
          "SELECT id,source_at,value::text AS value_minor FROM points WHERE feed_id=$1 ORDER BY source_at,id LIMIT 1001",
          [feed.id],
        )
      ).rows;
      if (points.length > 1000)
        throw new DomainError("feed_snapshot_limit", 413);
      result.push(
        monitor(
          feed,
          points.map((p) => ({ ...p, source_at: p.source_at.toISOString() })),
          Date.now(),
        ),
      );
    }
    return result;
  }
  async state() {
    const [
      accounts,
      events,
      rules,
      decisions,
      catalogs,
      batches,
      exceptions,
      matches,
      audit,
    ] = await Promise.all([
      this.db.query(
        "SELECT id,currency,allow_negative,balance::text FROM accounts ORDER BY currency,id",
      ),
      this.db.query(
        "SELECT seq::text,event_id::text,request_key,currency,request_text,hash,created_at FROM ledger_events ORDER BY ledger_events.seq DESC LIMIT 40",
      ),
      this.db.query("SELECT * FROM rules ORDER BY created_at DESC LIMIT 20"),
      this.db.query(
        "SELECT request_id,version,result_text,created_at FROM decisions ORDER BY created_at DESC LIMIT 40",
      ),
      this.db.query("SELECT * FROM catalogs ORDER BY created_at DESC LIMIT 20"),
      this.db.query(
        "SELECT id,summary,ledger,bank,created_at FROM recon_batches ORDER BY created_at DESC LIMIT 10",
      ),
      this.db.query(
        "SELECT * FROM recon_exceptions ORDER BY batch_id,bank_id LIMIT 200",
      ),
      this.db.query(
        "SELECT * FROM recon_matches ORDER BY batch_id,bank_id LIMIT 200",
      ),
      this.db.query("SELECT * FROM audit ORDER BY id DESC LIMIT 80"),
    ]);
    return {
      accounts: accounts.rows,
      events: events.rows,
      rules: rules.rows,
      decisions: decisions.rows,
      catalogs: catalogs.rows,
      batches: batches.rows,
      exceptions: exceptions.rows,
      matches: matches.rows,
      audit: audit.rows,
      trace_scope: "API request IDs; not distributed tracing",
      synthetic_only: true,
    };
  }
}
export function uniqueId(prefix: string): string {
  return prefix + "_" + randomUUID().replaceAll("-", "");
}
export const defaultRules = {
  max_amount_minor: "100000",
  risk_ceiling: 60,
  allowed_countries: ["US", "CA", "GB"],
};
export const defaultCatalog: Merchant[] = [
  ["Juniper Cafe", "food"],
  ["Orion Tools", "hardware"],
  ["Meadow Books", "books"],
  ["Cedar Market", "groceries"],
  ["Beacon Transit", "transport"],
  ["Aster Studio", "creative"],
  ["Lumen Cycles", "sport"],
  ["Harbor Garden", "garden"],
].map(([name, category], i) => ({
  id: "merchant_" + i,
  name: "Synthetic " + name!,
  category: category!,
}));
