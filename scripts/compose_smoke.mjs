import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
const base = "http://127.0.0.1:8084";
const headers = {
  Authorization: "Bearer " + process.env.TALLY_TOKEN,
  "Content-Type": "application/json",
};
const post = async (path, body = {}) => {
  const r = await fetch(base + path, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};
assert.equal((await fetch(base + "/")).status, 200);
assert.equal((await fetch(base + "/api/state")).status, 401);
const health = await fetch(base + "/health");
assert.equal(health.status, 200);
const state = await (await fetch(base + "/api/state", { headers })).json();
assert.ok(state.events.length > 0);
assert.ok(state.batches.length > 0);
if (process.env.TALLY_SMOKE_AFTER_RESTART) {
  const before = JSON.parse(
    await readFile("docs/results/compose-before-restart.json", "utf8"),
  );
  const replay = await post("/api/ledger/replay");
  assert.equal(replay.status, 201);
  assert.equal(replay.body.projection_equal, true);
  assert.equal(replay.body.projection_sha256, before.digest);
  await writeFile(
    "docs/results/compose-after-restart.json",
    JSON.stringify(
      { durable_restart_equal: true, replay: replay.body },
      null,
      2,
    ),
  );
  console.log(
    "Actual Postgres container restart retained the identical ledger projection.",
  );
} else {
  const body = {
    idempotency_key: "compose_post",
    currency: "USD",
    day: "2026-01-01",
    description: "Synthetic Compose transfer",
    lines: [
      { account_id: "cash", amount_minor: "-100" },
      { account_id: "clearing", amount_minor: "100" },
    ],
  };
  const first = await post("/api/ledger/post", body),
    again = await post("/api/ledger/post", body);
  assert.equal(first.status, 201);
  assert.equal(again.body.replayed, true);
  assert.equal(first.body.event_id, again.body.event_id);
  const bad = await post("/api/ledger/post", {
    ...body,
    idempotency_key: "compose_bad",
    lines: [
      { account_id: "cash", amount_minor: "-100" },
      { account_id: "clearing", amount_minor: "99" },
    ],
  });
  assert.equal(bad.status, 422);
  const rule = await post("/api/rules", {
    max_amount_minor: "100000",
    risk_ceiling: 60,
    allowed_countries: ["US", "CA", "GB"],
  });
  assert.equal(rule.status, 201);
  const decision = await post("/api/decisions", {
    request_id: "compose_decision",
    rule_version: rule.body.version,
    amount_minor: "1000",
    risk_points: 40,
    country: "US",
  });
  assert.equal(decision.body.approved, true);
  const replay = await post("/api/ledger/replay");
  assert.equal(replay.body.projection_equal, true);
  const login = await fetch(base + "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: process.env.TALLY_PASSWORD }),
  });
  assert.equal(login.status, 201);
  const csrf = (await login.json()).csrf,
    cookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal(
    (
      await fetch(base + "/api/ledger/replay", {
        method: "POST",
        headers: { Cookie: cookie },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(base + "/api/logout", {
        method: "POST",
        headers: { Cookie: cookie, "X-CSRF-Token": csrf },
      })
    ).status,
    201,
  );
  assert.equal(
    (await fetch(base + "/api/state", { headers: { Cookie: cookie } })).status,
    401,
  );
  await writeFile(
    "docs/results/compose-before-restart.json",
    JSON.stringify(
      {
        digest: replay.body.projection_sha256,
        posting: first.body,
        replay: again.body,
        imbalance_status: bad.status,
        decision: decision.body,
        auth_csrf_logout: true,
        seeded_batches: state.batches.length,
      },
      null,
      2,
    ),
  );
  console.log(
    "Fresh-clone Compose: seeded live React/API, idempotent posting, imbalance rejection, decision, cookie/CSRF/logout passed.",
  );
}
