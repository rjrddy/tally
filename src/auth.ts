import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import type { Request, Response } from "express";
import type pg from "pg";
import { z } from "zod";
import { DomainError } from "./model.js";
export interface OperatorRequest extends Request {
  traceId?: string;
  operator?: { csrf: string; machine?: boolean };
}
function equal(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
}
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export function cookie(req: Request): string {
  const items = (req.headers.cookie ?? "")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("tally_session="));
  return items.length === 1 ? items[0]!.slice("tally_session=".length) : "";
}
export class Auth {
  private readonly password = process.env.TALLY_PASSWORD ?? "";
  private readonly token = process.env.TALLY_TOKEN ?? "";
  private readonly budgets = new Map<string, number[]>();
  constructor(private readonly db: pg.Pool) {
    if (this.password.length < 24 || this.token.length < 24)
      throw new Error("configure generated TALLY_PASSWORD and TALLY_TOKEN");
  }
  rate(key: string, max: number): void {
    const now = Date.now(),
      items = (this.budgets.get(key) ?? []).filter((t) => t > now - 60000);
    if (items.length >= max) throw new DomainError("rate_limited", 429);
    items.push(now);
    this.budgets.set(key, items);
  }
  async login(input: unknown, res: Response) {
    this.rate("login", 10);
    const value = z
      .object({ password: z.string().min(1).max(256) })
      .strict()
      .parse(input);
    if (!equal(value.password, this.password))
      throw new DomainError("invalid_credentials", 401);
    const session = randomBytes(32).toString("base64url"),
      csrf = randomBytes(24).toString("base64url"),
      c = await this.db.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        "SELECT pg_advisory_xact_lock(hashtextextended(current_schema()||':sessions',0))",
      );
      await c.query("DELETE FROM sessions WHERE expires<=clock_timestamp()");
      if (
        Number(
          (await c.query("SELECT count(*) FROM sessions")).rows[0].count,
        ) >= 100
      )
        throw new DomainError("session_capacity", 429);
      await c.query(
        "INSERT INTO sessions VALUES($1,$2,clock_timestamp()+interval '1 hour')",
        [digest(session), csrf],
      );
      await c.query("COMMIT");
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    } finally {
      c.release();
    }
    res.cookie("tally_session", session, {
      httpOnly: true,
      secure: process.env.TALLY_COOKIE_SECURE === "1",
      sameSite: "strict",
      maxAge: 3600000,
      path: "/",
    });
    return { csrf };
  }
  async authorize(req: OperatorRequest): Promise<void> {
    const authorization = req.headers.authorization;
    if (authorization) {
      if (!equal(authorization, "Bearer " + this.token))
        throw new DomainError("invalid_machine_token", 401);
      req.operator = { csrf: "", machine: true };
    } else {
      const token = cookie(req);
      const row = token
        ? (
            await this.db.query<{ csrf: string }>(
              "SELECT csrf FROM sessions WHERE hash=$1 AND expires>clock_timestamp()",
              [digest(token)],
            )
          ).rows[0]
        : undefined;
      if (!row) throw new DomainError("sign_in_required", 401);
      if (
        !["GET", "HEAD"].includes(req.method) &&
        !equal(String(req.headers["x-csrf-token"] ?? ""), row.csrf)
      )
        throw new DomainError("csrf_required", 403);
      req.operator = { csrf: row.csrf };
    }
    this.rate(
      ["GET", "HEAD"].includes(req.method) ? "operator-read" : "operator-write",
      6000,
    );
  }
  async logout(req: Request, res: Response) {
    await this.db.query("DELETE FROM sessions WHERE hash=$1", [
      digest(cookie(req)),
    ]);
    res.clearCookie("tally_session", {
      path: "/",
      httpOnly: true,
      sameSite: "strict",
    });
    return { ok: true };
  }
}
@Injectable()
export class OperatorGuard implements CanActivate {
  constructor(private readonly auth: Auth) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    await this.auth.authorize(
      context.switchToHttp().getRequest<OperatorRequest>(),
    );
    return true;
  }
}
