import { z } from "zod";
import {
  canonical,
  currency,
  day,
  identity,
  minor,
  positive,
  sha,
} from "./model.js";

export const ruleSchema = z
  .object({
    max_amount_minor: positive,
    risk_ceiling: z.number().int().min(0).max(100),
    allowed_countries: z
      .array(z.string().regex(/^[A-Z]{2}$/))
      .min(1)
      .max(20)
      .refine((a) => new Set(a).size === a.length),
  })
  .strict();
export const decisionSchema = z
  .object({
    request_id: identity,
    amount_minor: positive,
    risk_points: z.number().int().min(0).max(100),
    country: z.string().regex(/^[A-Z]{2}$/),
    rule_version: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type DecisionInput = z.infer<typeof decisionSchema>;
export function decide(input: DecisionInput, rule: z.infer<typeof ruleSchema>) {
  const reasons: string[] = [];
  if (BigInt(input.amount_minor) > BigInt(rule.max_amount_minor))
    reasons.push("amount_above_cap");
  if (input.risk_points > rule.risk_ceiling) reasons.push("risk_above_cap");
  if (!rule.allowed_countries.includes(input.country))
    reasons.push("country_not_allowed");
  return {
    request_id: input.request_id,
    rule_version: input.rule_version,
    approved: reasons.length === 0,
    reasons,
    score: 100 - input.risk_points,
  };
}
export function normalize(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/^(sq|tst|pos)\s*\*\s*/, "")
    .replace(/\s*#\d+.*$/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  let prior = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next.push(
        Math.min(
          next[j - 1]! + 1,
          prior[j]! + 1,
          prior[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
        ),
      );
    prior = next;
  }
  return 1 - prior[b.length]! / Math.max(a.length, b.length);
}
export const recordSchema = z
  .object({
    id: identity,
    amount_minor: minor,
    currency,
    day,
    description: z.string().min(1).max(120),
  })
  .strict();
export type ReconRecord = z.infer<typeof recordSchema>;
export interface Match {
  bank: string;
  ledger: string;
  score: number;
  reason: string;
}
export interface Exception {
  bank: string;
  reason: string;
  candidates: { ledger: string; score: number }[];
}
export function reconcile(
  bank: ReconRecord[],
  ledger: ReconRecord[],
): { matches: Match[]; exceptions: Exception[] } {
  if (
    bank.length > 1000 ||
    ledger.length > 1000 ||
    new Set(bank.map((r) => r.id)).size !== bank.length ||
    new Set(ledger.map((r) => r.id)).size !== ledger.length
  )
    throw new Error("bounded unique records required");
  const edges = new Map<string, { ledger: string; score: number }[]>(),
    reverse = new Map<string, { bank: string; score: number }[]>();
  for (const b of bank) {
    const options = [];
    for (const l of ledger) {
      if (b.currency !== l.currency || b.amount_minor !== l.amount_minor)
        continue;
      const days = Math.abs(Date.parse(b.day) - Date.parse(l.day)) / 86400000;
      if (days > 2) continue;
      const text = similarity(
        normalize(b.description),
        normalize(l.description),
      );
      if (text < 0.72) continue;
      const score = text - days * 0.03;
      if (score < 0.7) continue;
      options.push({ ledger: l.id, score });
      const reversed = reverse.get(l.id) ?? [];
      reversed.push({ bank: b.id, score });
      reverse.set(l.id, reversed);
    }
    options.sort((a, b) => b.score - a.score || (a.ledger < b.ledger ? -1 : 1));
    edges.set(b.id, options);
  }
  for (const rows of reverse.values())
    rows.sort((a, b) => b.score - a.score || (a.bank < b.bank ? -1 : 1));
  const matches: Match[] = [],
    exceptions: Exception[] = [];
  for (const b of [...bank].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const options = edges.get(b.id)!;
    const best = options[0];
    let reason = "no_compatible_candidate";
    if (best) {
      const reversed = reverse.get(best.ledger)!;
      if (options[1] && best.score - options[1].score < 0.12)
        reason = "ambiguous_candidates";
      else if (
        reversed[0]!.bank !== b.id ||
        (reversed[1] && reversed[0]!.score - reversed[1].score < 0.12)
      )
        reason = "competing_bank_records";
      else {
        matches.push({
          bank: b.id,
          ledger: best.ledger,
          score: best.score,
          reason:
            "exact amount/currency; date window; mutual unambiguous descriptor similarity",
        });
        continue;
      }
    }
    exceptions.push({ bank: b.id, reason, candidates: options.slice(0, 5) });
  }
  return { matches, exceptions };
}
export const merchantSchema = z
  .object({
    id: identity,
    name: z.string().min(2).max(100),
    category: z.string().min(1).max(40),
  })
  .strict();
export const catalogSchema = z
  .array(merchantSchema)
  .min(2)
  .max(100)
  .refine(
    (a) =>
      new Set(a.map((m) => m.id)).size === a.length &&
      new Set(a.map((m) => normalize(m.name))).size === a.length,
    "unique IDs and normalized names required",
  );
export type Merchant = z.infer<typeof merchantSchema>;
export interface Enrichment {
  catalog_version: string;
  id: string | null;
  name: string | null;
  category: string;
  similarity: number;
  method: string;
}
export class Enricher {
  private readonly cache = new Map<string, Enrichment>();
  hits = 0;
  misses = 0;
  run(descriptor: string, catalog: Merchant[]): Enrichment {
    const version = sha(canonical(catalog)),
      name = normalize(descriptor),
      key = version + ":" + name;
    const found = this.cache.get(key);
    if (found) {
      this.hits++;
      this.cache.delete(key);
      this.cache.set(key, found);
      return found;
    }
    this.misses++;
    const ranked = catalog
      .map((m) => ({ m, score: similarity(name, normalize(m.name)) }))
      .sort((a, b) => b.score - a.score || (a.m.id < b.m.id ? -1 : 1));
    const top = ranked[0]!;
    const accepted =
      top.score >= 0.86 && (!ranked[1] || top.score - ranked[1].score >= 0.04);
    const result: Enrichment = accepted
      ? {
          catalog_version: version,
          ...top.m,
          similarity: top.score,
          method: top.score === 1 ? "normalized_exact" : "conservative_fuzzy",
        }
      : {
          catalog_version: version,
          id: null,
          name: null,
          category: "unknown",
          similarity: top.score,
          method: "abstained",
        };
    this.cache.set(key, result);
    if (this.cache.size > 512)
      this.cache.delete(this.cache.keys().next().value!);
    return result;
  }
  get size(): number {
    return this.cache.size;
  }
}
export const feedSchema = z
  .object({
    id: identity,
    budget_ms: z.number().int().min(1000).max(86400000),
    expected_ids: z
      .array(identity)
      .min(1)
      .max(256)
      .refine((a) => new Set(a).size === a.length),
  })
  .strict();
export const pointSchema = z
  .object({
    id: identity,
    source_at: z.iso.datetime({ offset: true }),
    value_minor: positive,
  })
  .strict();
export type FeedPoint = z.infer<typeof pointSchema>;
export function monitor(
  config: z.infer<typeof feedSchema>,
  points: FeedPoint[],
  now: number,
) {
  const alerts: { kind: string; id?: string; age_ms?: number }[] = [];
  const found = new Set(points.map((p) => p.id));
  for (const id of config.expected_ids)
    if (!found.has(id)) alerts.push({ kind: "missing", id });
  const valid = points
    .filter((p) => Date.parse(p.source_at) <= now)
    .sort(
      (a, b) =>
        Date.parse(a.source_at) - Date.parse(b.source_at) ||
        (a.id < b.id ? -1 : 1),
    );
  for (const p of points)
    if (Date.parse(p.source_at) > now)
      alerts.push({ kind: "future_timestamp", id: p.id });
  for (let i = 1; i < valid.length; i++) {
    const a = BigInt(valid[i - 1]!.value_minor),
      b = BigInt(valid[i]!.value_minor);
    if (a > 10n * b || b > 10n * a)
      alerts.push({ kind: "outlier", id: valid[i]!.id });
  }
  const age = valid.length ? now - Date.parse(valid.at(-1)!.source_at) : null;
  if (age === null || age > config.budget_ms)
    alerts.push({ kind: "stale", ...(age === null ? {} : { age_ms: age }) });
  return {
    source: config.id,
    as_of: new Date(now).toISOString(),
    age_ms: age,
    budget_ms: config.budget_ms,
    points: points.length,
    healthy: alerts.length === 0,
    alerts,
    scope: "synthetic source timestamps; not a market-data integration",
  };
}
