import { createHash } from "node:crypto";
import { z } from "zod";

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return (
      "{" +
      Object.keys(record)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(record[k]))
        .join(",") +
      "}"
    );
  }
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error("unsupported canonical value");
  return text;
}
export const sha = (text: string): string =>
  createHash("sha256").update(text).digest("hex");
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 409,
  ) {
    super(code);
  }
}
export const identity = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
export const currency = z.enum(["USD", "EUR", "JPY"]);
export const minor = z.string().regex(/^-?[1-9][0-9]{0,17}$/);
export const positive = z.string().regex(/^[1-9][0-9]{0,17}$/);
export const day = z
  .string()
  .regex(/^20[0-9]{2}-[0-9]{2}-[0-9]{2}$/)
  .refine((s) => {
    const n = Date.parse(s + "T00:00:00Z");
    return Number.isFinite(n) && new Date(n).toISOString().slice(0, 10) === s;
  }, "invalid calendar day");
export const accountSchema = z
  .object({ id: identity, currency, allow_negative: z.boolean() })
  .strict();
export const postingSchema = z
  .object({
    idempotency_key: identity,
    currency,
    day,
    description: z.string().min(1).max(120),
    lines: z
      .array(z.object({ account_id: identity, amount_minor: minor }).strict())
      .min(2)
      .max(40),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (new Set(p.lines.map((l) => l.account_id)).size !== p.lines.length)
      ctx.addIssue({ code: "custom", message: "distinct accounts required" });
    if (p.lines.reduce((sum, l) => sum + BigInt(l.amount_minor), 0n) !== 0n)
      ctx.addIssue({ code: "custom", message: "unbalanced posting" });
  });
export type Posting = z.infer<typeof postingSchema>;
export function posting(input: unknown): Posting {
  const p = postingSchema.parse(input);
  return {
    ...p,
    lines: [...p.lines].sort((a, b) =>
      a.account_id < b.account_id ? -1 : a.account_id > b.account_id ? 1 : 0,
    ),
  };
}
export interface JournalEvent {
  seq: string;
  event_id: string;
  request_key: string;
  request_text: string;
  request_digest: string;
  event_text: string;
  previous_hash: string;
  hash: string;
  currency: string;
}
export function replay(events: JournalEvent[]): {
  balances: Record<string, string>;
  head: string;
  events: number;
} {
  const balances: Record<string, bigint> = {};
  let head = "0".repeat(64),
    previous = 0n;
  const keys = new Set<string>(),
    ids = new Set<string>();
  for (const e of events) {
    if (
      BigInt(e.seq) <= previous ||
      keys.has(e.request_key) ||
      ids.has(e.event_id)
    )
      throw new DomainError("replay_identity_corruption");
    const p = posting(JSON.parse(e.request_text) as unknown);
    if (
      canonical(p) !== e.request_text ||
      p.idempotency_key !== e.request_key ||
      p.currency !== e.currency ||
      sha(e.request_text) !== e.request_digest
    )
      throw new DomainError("replay_request_corruption");
    const raw = JSON.parse(e.event_text) as {
      event_id: string;
      seq: string;
      request: unknown;
    };
    if (
      raw.event_id !== e.event_id ||
      raw.seq !== e.seq ||
      canonical(raw.request) !== e.request_text ||
      e.previous_hash !== head ||
      sha(head + e.event_text) !== e.hash
    )
      throw new DomainError("replay_chain_corruption");
    for (const line of p.lines) {
      const key = p.currency + ":" + line.account_id;
      balances[key] = (balances[key] ?? 0n) + BigInt(line.amount_minor);
    }
    previous = BigInt(e.seq);
    head = e.hash;
    keys.add(e.request_key);
    ids.add(e.event_id);
  }
  return {
    balances: Object.fromEntries(
      Object.keys(balances)
        .sort()
        .map((k) => [k, String(balances[k])]),
    ),
    head,
    events: events.length,
  };
}
