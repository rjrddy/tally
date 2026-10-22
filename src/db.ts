import { readFile } from "node:fs/promises";
import pg from "pg";
import { sha } from "./model.js";
export function schemaName(): string {
  const schema = process.env.TALLY_SCHEMA ?? "tally_v1";
  if (!/^tally_[a-z0-9_]{1,45}$/.test(schema))
    throw new Error("invalid isolated schema");
  return schema;
}
export function pool(admin = false): pg.Pool {
  const url =
    process.env[admin ? "TALLY_MIGRATION_DATABASE_URL" : "TALLY_DATABASE_URL"];
  const result = new pg.Pool(
    url
      ? {
          connectionString: url,
          max: 12,
          connectionTimeoutMillis: 1000,
          statement_timeout: 3000,
          options: `-c search_path=${schemaName()},pg_catalog`,
        }
      : {
          host: process.env.PGHOST ?? "127.0.0.1",
          port: Number(process.env.PGPORT ?? 55440),
          database: process.env.PGDATABASE ?? "tally",
          user: admin ? "tally_admin" : "tally_app",
          password:
            process.env[
              admin ? "TALLY_DB_ADMIN_PASSWORD" : "TALLY_DB_PASSWORD"
            ],
          max: 12,
          connectionTimeoutMillis: 1000,
          statement_timeout: 3000,
          options: `-c search_path=${schemaName()},pg_catalog`,
        },
  );
  result.on("error", () =>
    console.error(JSON.stringify({ event: "postgres_idle_connection_error" })),
  );
  return result;
}
export async function migrate(admin: pg.Pool): Promise<void> {
  const schema = schemaName(),
    sql = await readFile("db/001.sql", "utf8");
  const client = await admin.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('tally:migrations',0))",
    );
    const role = await client.query(
      "SELECT 1 FROM pg_roles WHERE rolname='tally_app'",
    );
    if (!role.rowCount) {
      const secret = process.env.TALLY_DB_PASSWORD;
      if (!secret || secret.length < 24)
        throw new Error("configure application DB password");
      const quoted = await client.query<{ sql: string }>(
        "SELECT format('CREATE ROLE tally_app LOGIN PASSWORD %L',$1::text) AS sql",
        [secret],
      );
      await client.query(quoted.rows[0]!.sql);
    }
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${schema}.migration(version text PRIMARY KEY,digest text NOT NULL)`,
    );
    const prior = await client.query<{ digest: string }>(
      `SELECT digest FROM ${schema}.migration WHERE version='001'`,
    );
    if (prior.rows[0]) {
      if (prior.rows[0].digest !== sha(sql))
        throw new Error("immutable migration checksum changed");
    } else {
      await client.query(sql.replaceAll("__SCHEMA__", schema));
      await client.query(`INSERT INTO ${schema}.migration VALUES('001',$1)`, [
        sha(sql),
      ]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
