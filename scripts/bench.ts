import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import { once } from "node:events";
import { pool, migrate, schemaName } from "../src/db.js";
import { Tally, defaultRules, defaultCatalog } from "../src/service.js";
import { reconciliationFixture, descriptorFixture } from "../src/fixtures.js";
import { monitor, normalize, reconcile, Enricher } from "../src/analysis.js";

const out = "docs/results";
await mkdir(out, { recursive: true });
process.env.TALLY_SCHEMA = "tally_bench_" + randomBytes(5).toString("hex");
const schema = schemaName(),
  admin = pool(true);
await migrate(admin);
const db = pool(),
  t = new Tally(db);
const children: ChildProcess[] = [],
  log = createWriteStream(out + "/benchmark-processes.log");
const headers = {
  Authorization: "Bearer " + process.env.TALLY_TOKEN,
  "Content-Type": "application/json",
};
async function request(base: string, path: string, body?: unknown) {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = (await response.json()) as Record<string, unknown>;
  return { status: response.status, value };
}
async function ready(base: string) {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(base + "/health")).ok) return;
    } catch {
      /* readiness retry */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw Error("API readiness timeout");
}
async function api(port: number) {
  const child = spawn(process.execPath, ["dist/src/main.js"], {
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout!.pipe(log, { end: false });
  child.stderr!.pipe(log, { end: false });
  children.push(child);
  await ready("http://127.0.0.1:" + port);
  return child;
}
async function stop(p: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
  if (p.exitCode !== null || p.signalCode !== null) return;
  p.kill(signal);
  await Promise.race([
    once(p, "exit"),
    new Promise<void>((r) =>
      setTimeout(() => {
        p.kill("SIGKILL");
        r();
      }, 5000).unref(),
    ),
  ]);
}
async function campaign(
  count: number,
  concurrency: number,
  run: (
    i: number,
  ) => Promise<{ status: number; value: Record<string, unknown> }>,
) {
  let next = 0;
  const samples: { id: number; latency_ms: number; status: number }[] = [];
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < count) {
        const id = next++,
          start = performance.now(),
          result = await run(id);
        samples.push({
          id,
          latency_ms: performance.now() - start,
          status: result.status,
        });
      }
    }),
  );
  samples.sort((a, b) => a.id - b.id);
  const ordered = samples.map((s) => s.latency_ms).sort((a, b) => a - b);
  return {
    count,
    concurrency,
    p50_ms: ordered[Math.floor((ordered.length - 1) * 0.5)]!,
    p99_ms: ordered[Math.floor((ordered.length - 1) * 0.99)]!,
    failures: samples.filter((s) => s.status < 200 || s.status >= 300).length,
    samples,
  };
}
const a = "http://127.0.0.1:18401",
  b = "http://127.0.0.1:18402";
try {
  let worker = await api(18401);
  await api(18402);
  await t.account({ id: "bench_a", currency: "USD", allow_negative: true });
  await t.account({ id: "bench_b", currency: "USD", allow_negative: true });
  const posting = (key: string, amount = "1000") => ({
    idempotency_key: key,
    currency: "USD",
    day: "2026-01-01",
    description: "Synthetic benchmark journal",
    lines: [
      { account_id: "bench_a", amount_minor: amount },
      { account_id: "bench_b", amount_minor: String(-BigInt(amount)) },
    ],
  });
  const posted = await campaign(1000, 8, (i) =>
    request(
      i % 2 ? a : b,
      "/api/ledger/post",
      posting("load_" + i, String(1000 + i)),
    ),
  );
  assert.equal(posted.failures, 0);
  const duplicates = await Promise.all(
    Array.from({ length: 24 }, (_, i) =>
      request(i % 2 ? a : b, "/api/ledger/post", posting("repeated")),
    ),
  );
  assert.ok(duplicates.every((r) => r.status === 201));
  assert.equal(new Set(duplicates.map((r) => r.value.event_id)).size, 1);
  assert.equal(duplicates.filter((r) => r.value.replayed === false).length, 1);
  const rejected = await request(a, "/api/ledger/post", {
    ...posting("unbalanced"),
    lines: [
      { account_id: "bench_a", amount_minor: "1000" },
      { account_id: "bench_b", amount_minor: "-999" },
    ],
  });
  assert.equal(rejected.status, 422);
  const conflict = await request(
    b,
    "/api/ledger/post",
    posting("repeated", "1001"),
  );
  assert.equal(conflict.status, 409);
  const lock = await admin.connect();
  await lock.query("BEGIN");
  await lock.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    schema + ":ledger",
  ]);
  const interrupted = request(a, "/api/ledger/post", posting("killed_request"))
    .then((r) => ({ http: r.status }))
    .catch(() => ({ transport_error: true }));
  for (let i = 0; i < 100; i++) {
    const waiting = (
      await admin.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE '%post_ledger%' ",
      )
    ).rows[0]!.n;
    if (waiting) break;
    await new Promise((r) => setTimeout(r, 10));
    if (i === 99) throw Error("did not observe blocked posting");
  }
  await stop(worker, "SIGKILL");
  await lock.query("COMMIT");
  lock.release();
  const interruptedOutcome = await interrupted;
  const retried = await request(
    b,
    "/api/ledger/post",
    posting("killed_request"),
  );
  assert.equal(retried.status, 201);
  worker = await api(18401);
  // An actual HTTP proxy consumes the committed response and closes the client connection.
  const proxy = http.createServer((req, res) => {
    const upstream = http.request(
      b + req.url,
      { method: req.method, headers: req.headers },
      (response) => {
        response.resume();
        response.on("end", () => res.destroy());
      },
    );
    req.pipe(upstream);
    upstream.on("error", () => res.destroy());
  });
  await new Promise<void>((resolve) =>
    proxy.listen(18403, "127.0.0.1", resolve),
  );
  let lostAck = false;
  try {
    await request(
      "http://127.0.0.1:18403",
      "/api/ledger/post",
      posting("lost_ack"),
    );
  } catch {
    lostAck = true;
  } finally {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
  assert.equal(lostAck, true);
  const acknowledged = await request(
    a,
    "/api/ledger/post",
    posting("lost_ack"),
  );
  assert.equal(acknowledged.value.replayed, true);
  const replay = await t.rebuild();
  assert.equal(replay.events, 1003);
  assert.equal(replay.projection_equal, true);
  await admin.query(
    `UPDATE ${schema}.accounts SET balance=balance+1 WHERE id='bench_a'`,
  );
  const drift = await t.rebuild();
  assert.equal(drift.projection_equal, false);
  await t.rebuild(true);
  const repaired = await t.rebuild();
  assert.equal(repaired.projection_equal, true);
  assert.equal(repaired.projection_sha256, replay.projection_sha256);
  const journal = {
    scope:
      "Actual HTTP across two Node processes and shared durable Postgres; no network deployment throughput claim",
    posted,
    concurrent_replays: 24,
    duplicate_event_ids: new Set(duplicates.map((r) => r.value.event_id)).size,
    unbalanced_status: rejected.status,
    conflicting_key_status: conflict.status,
    kill_during_db_lock: {
      signal: "SIGKILL",
      interrupted: interruptedOutcome,
      retry: retried,
    },
    lost_response: { proxy_consumed_and_dropped: true, retry: acknowledged },
    replay: {
      events: replay.events,
      equal: replay.projection_equal,
      digest: replay.projection_sha256,
      head: replay.head,
    },
    projection_fault: {
      detected: drift.drift,
      repaired_equal: repaired.projection_equal,
      digest: repaired.projection_sha256,
    },
  };
  await writeFile(
    out + "/ledger.json",
    JSON.stringify(journal, null, 2) + "\n",
  );
  const rules = await t.publishRule(defaultRules),
    changed = await t.publishRule({ ...defaultRules, risk_ceiling: 20 }),
    latencies = [];
  for (const concurrency of [1, 4, 16]) {
    const result = await campaign(400, concurrency, (i) =>
      request(i % 2 ? a : b, "/api/decisions", {
        request_id: "decision_" + concurrency + "_" + i,
        rule_version: rules.version,
        amount_minor: String(1000 + i),
        risk_points: i % 100,
        country: i % 7 === 0 ? "ZZ" : "US",
      }),
    );
    latencies.push({
      ...result,
      budget_ms: 100,
      budget_met: result.p99_ms < 100 && result.failures === 0,
    });
  }
  const oldInput = {
    request_id: "versioned",
    rule_version: rules.version,
    amount_minor: "9000",
    risk_points: 40,
    country: "US",
  };
  const original = await request(a, "/api/decisions", oldInput),
    newRule = await request(b, "/api/decisions", {
      ...oldInput,
      request_id: "versioned_new",
      rule_version: changed.version,
    });
  assert.equal(original.value.approved, true);
  assert.equal(newRule.value.approved, false);
  assert.deepEqual(
    (await request(b, "/api/decisions", oldInput)).value,
    original.value,
  );
  const decisionLock = await admin.connect();
  await decisionLock.query("BEGIN");
  await decisionLock.query(
    `LOCK TABLE ${schema}.decisions IN ACCESS EXCLUSIVE MODE`,
  );
  const deadlineStart = performance.now();
  let deadline;
  let deadlineElapsedMs = 0;
  try {
    deadline = await request(a, "/api/decisions", {
      ...oldInput,
      request_id: "blocked_decision",
    });
    deadlineElapsedMs = performance.now() - deadlineStart;
    assert.equal(deadline.status, 504);
  } finally {
    await decisionLock.query("ROLLBACK");
    decisionLock.release();
  }
  const decisionReplay = await t.replayDecisions();
  assert.equal(decisionReplay.exact, decisionReplay.decisions);
  await writeFile(
    out + "/decisions.json",
    JSON.stringify(
      {
        scope:
          "Client HTTP round trip including database audit commit; all statuses included; percentile is observed nearest-rank sample",
        latencies,
        versioned: { original, newRule },
        deadline: {
          ...deadline,
          elapsed_ms: deadlineElapsedMs,
        },
        replay: decisionReplay,
      },
      null,
      2,
    ) + "\n",
  );
  const fixture = reconciliationFixture(),
    idMap = new Map<string, string>();
  await t.account({ id: "recon_cash", currency: "USD", allow_negative: true });
  await t.account({
    id: "recon_external",
    currency: "USD",
    allow_negative: true,
  });
  for (const l of fixture.ledger) {
    const result = await t.post({
      idempotency_key: l.id,
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
    idMap.set(l.id, result.event_id);
  }
  const recon = await request(a, "/api/reconcile", {
    batch_id: "measured_reconciliation",
    account_id: "recon_cash",
    bank: fixture.bank,
  });
  assert.equal(recon.status, 201);
  const result = recon.value.result as ReturnType<typeof reconcile>,
    truth = Object.fromEntries(
      Object.entries(fixture.truth).map(([id, l]) => [
        id,
        l === null ? null : idMap.get(l),
      ]),
    ),
    correct = result.matches.filter((m) => truth[m.bank] === m.ledger).length,
    wrong = result.matches.length - correct,
    truthCount = Object.values(truth).filter((v) => v !== null).length;
  await writeFile(
    out + "/reconciliation.json",
    JSON.stringify(
      {
        scope: fixture.scope,
        seed: fixture.seed,
        bank_records: fixture.bank.length,
        ledger_records: fixture.ledger.length,
        true_pairs: truthCount,
        matches: result.matches.length,
        correct,
        false_matches: wrong,
        match_rate: result.matches.length / fixture.bank.length,
        precision: correct / result.matches.length,
        false_match_rate: wrong / result.matches.length,
        recall: correct / truthCount,
        exceptions: result.exceptions.length,
        bank: fixture.bank,
        truth,
        result,
      },
      null,
      2,
    ) + "\n",
  );
  const catalog = await t.publishCatalog(defaultCatalog),
    descriptors = descriptorFixture(),
    predictions: {
      descriptor: string;
      truth: string | null;
      actual: unknown;
      result: Record<string, unknown>;
    }[] = [];
  const enrichment = await campaign(descriptors.length, 4, async (i) => {
    const row = descriptors[i]!,
      r = await request(a, "/api/enrich", {
        descriptor: row.descriptor,
        catalog_version: catalog.version,
      });
    predictions.push({ ...row, actual: r.value.id, result: r.value });
    return r;
  });
  assert.equal(enrichment.failures, 0);
  const correctDescriptors = predictions.filter(
      (r) => r.actual === r.truth,
    ).length,
    known = predictions.filter((r) => r.truth !== null),
    unknown = predictions.filter((r) => r.truth === null);
  const cache = new Enricher();
  cache.run(defaultCatalog[0]!.name, defaultCatalog);
  cache.run(defaultCatalog[0]!.name, defaultCatalog);
  const secondCatalog = defaultCatalog.map((m, i) =>
    i === 0 ? { ...m, name: "Synthetic New Name" } : m,
  );
  const afterChange = cache.run(defaultCatalog[0]!.name, secondCatalog);
  assert.equal(afterChange.id, null);
  await writeFile(
    out + "/enrichment.json",
    JSON.stringify(
      {
        scope:
          "Synthetic catalog and labeled descriptor corruptions; similarity is not calibrated probability",
        catalog_version: catalog.version,
        samples: predictions.length,
        accuracy: correctDescriptors / predictions.length,
        known_correct: known.filter((r) => r.actual === r.truth).length,
        known_samples: known.length,
        unknown_correct: unknown.filter((r) => r.actual === null).length,
        unknown_samples: unknown.length,
        cache_version_changed: afterChange.catalog_version !== catalog.version,
        latency: enrichment,
        predictions,
      },
      null,
      2,
    ) + "\n",
  );
  const now = Date.parse("2026-01-01T12:00:00Z"),
    config = {
      id: "synthetic_feed",
      budget_ms: 60000,
      expected_ids: ["a", "b", "c"],
    };
  const health = monitor(
    config,
    [
      { id: "a", source_at: "2026-01-01T10:00:00Z", value_minor: "1000" },
      { id: "b", source_at: "2026-01-01T11:00:00Z", value_minor: "100000" },
      {
        id: "future",
        source_at: "2026-01-02T11:00:00Z",
        value_minor: "100000",
      },
    ],
    now,
  );
  for (const kind of ["missing", "stale", "outlier", "future_timestamp"])
    assert.ok(health.alerts.some((a) => a.kind === kind));
  await writeFile(
    out + "/freshness.json",
    JSON.stringify({ virtual_clock_fixture: true, report: health }, null, 2) +
      "\n",
  );
  const environment = (
    await admin.query(
      "SELECT version(),current_setting('fsync') AS fsync,current_setting('synchronous_commit') AS synchronous_commit",
    )
  ).rows[0];
  await writeFile(
    out + "/environment.json",
    JSON.stringify(
      {
        node: process.version,
        postgres: environment,
        normalization_example: normalize("SQ* Synthetic Café #12345"),
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    JSON.stringify(
      {
        posted: posted.count,
        ledger_replayed: replay.events,
        duplicates_effects: 0,
        decision_p99_ms: latencies.map((r) => ({
          concurrency: r.concurrency,
          p99_ms: r.p99_ms,
          failures: r.failures,
          budget_met: r.budget_met,
        })),
        reconciliation: {
          matches: result.matches.length,
          precision: correct / result.matches.length,
          recall: correct / truthCount,
          wrong,
        },
        enrichment_accuracy: correctDescriptors / predictions.length,
      },
      null,
      2,
    ),
  );
} finally {
  for (const child of children) await stop(child);
  log.end();
  await db.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
}
