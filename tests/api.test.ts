import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import type { INestApplication } from "@nestjs/common";
import type pg from "pg";
import { createApp } from "../src/app.js";
import { migrate, pool } from "../src/db.js";
import { defaultRules } from "../src/service.js";
const schema = "tally_http_" + randomBytes(5).toString("hex");
process.env.TALLY_SCHEMA = schema;
let admin: pg.Pool, app: INestApplication, url: string;
const machine = {
  Authorization: "Bearer " + process.env.TALLY_TOKEN,
  "Content-Type": "application/json",
};
before(async () => {
  admin = pool(true);
  await migrate(admin);
  app = await createApp();
  await app.listen(0, "127.0.0.1");
  url = await app.getUrl();
});
after(async () => {
  await app?.close();
  await admin?.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin?.end();
});
const post = (
  path: string,
  body: unknown,
  headers: Record<string, string> = machine,
) => fetch(url + path, { method: "POST", headers, body: JSON.stringify(body) });
test("real HTTP cookie login, CSRF, logout and revocation", async () => {
  assert.equal((await fetch(url + "/api/state")).status, 401);
  const login = await post(
    "/api/login",
    { password: process.env.TALLY_PASSWORD },
    { "Content-Type": "application/json" },
  );
  assert.equal(login.status, 201);
  const csrf = ((await login.json()) as { csrf: string }).csrf,
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  assert.equal(
    (await fetch(url + "/api/state", { headers: { Cookie: cookie } })).status,
    200,
  );
  assert.equal(
    (
      await post("/api/rules", defaultRules, {
        "Content-Type": "application/json",
        Cookie: cookie,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await post("/api/rules", defaultRules, {
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-CSRF-Token": csrf,
      })
    ).status,
    201,
  );
  assert.equal(
    (
      await post(
        "/api/logout",
        {},
        {
          "Content-Type": "application/json",
          Cookie: cookie,
          "X-CSRF-Token": csrf,
        },
      )
    ).status,
    201,
  );
  assert.equal(
    (await fetch(url + "/api/state", { headers: { Cookie: cookie } })).status,
    401,
  );
});
test("real HTTP retains money strings above Number safe integer bounds", async () => {
  for (const [id, negative] of [
    ["big_cash", false],
    ["big_external", true],
  ] as const)
    assert.equal(
      (
        await post("/api/accounts", {
          id,
          currency: "USD",
          allow_negative: negative,
        })
      ).status,
      201,
    );
  const body = {
    idempotency_key: "large",
    currency: "USD",
    day: "2026-01-01",
    description: "Synthetic large integer fixture",
    lines: [
      { account_id: "big_cash", amount_minor: "999999999999999999" },
      { account_id: "big_external", amount_minor: "-999999999999999999" },
    ],
  };
  assert.equal((await post("/api/ledger/post", body)).status, 201);
  const state = (await (
    await fetch(url + "/api/state", { headers: machine })
  ).json()) as { accounts: { id: string; balance: string }[] };
  assert.equal(
    state.accounts.find((a) => a.id === "big_cash")!.balance,
    "999999999999999999",
  );
  const replay = await post("/api/ledger/replay", {});
  assert.equal(
    ((await replay.json()) as { projection_equal: boolean }).projection_equal,
    true,
  );
});
test("real HTTP rejects float money and conflicting idempotency", async () => {
  const body = {
    idempotency_key: "large",
    currency: "USD",
    day: "2026-01-01",
    description: "Synthetic large integer fixture",
    lines: [
      { account_id: "big_cash", amount_minor: "1000" },
      { account_id: "big_external", amount_minor: "-1000" },
    ],
  };
  assert.equal((await post("/api/ledger/post", body)).status, 409);
  assert.equal(
    (
      await post("/api/ledger/post", {
        ...body,
        lines: [
          { account_id: "big_cash", amount_minor: 1.5 },
          { account_id: "big_external", amount_minor: -1.5 },
        ],
      })
    ).status,
    422,
  );
});
test("real HTTP input bounds and authenticated metrics", async () => {
  assert.equal(
    (await post("/api/ledger/post", { large: "x".repeat(600000) })).status,
    413,
  );
  assert.equal((await fetch(url + "/metrics")).status, 401);
  const r = await fetch(url + "/metrics", { headers: machine });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /tally_requests_total/);
  assert.equal(
    (await fetch(url + "/api/not-found", { headers: machine })).status,
    404,
  );
});
