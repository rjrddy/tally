import type { ReconRecord } from "./analysis.js";
import { defaultCatalog } from "./service.js";
export function random(seed = 42): () => number {
  let x = seed;
  return () => {
    x = (Math.imul(1664525, x) + 1013904223) >>> 0;
    return x / 4294967296;
  };
}
export function reconciliationFixture(seed = 42, count = 200) {
  const rng = random(seed),
    bank: ReconRecord[] = [],
    ledger: ReconRecord[] = [],
    truth: Record<string, string | null> = {};
  for (let i = 0; i < count; i++) {
    const b: ReconRecord = {
      id: "bank_" + i,
      currency: "USD",
      amount_minor: String(10000 + i * 127 + Math.floor(rng() * 100)),
      day: "2026-01-" + String(1 + (i % 20)).padStart(2, "0"),
      description:
        defaultCatalog[i % defaultCatalog.length]!.name + " order " + i,
    };
    bank.push(b);
    truth[b.id] = null;
    if (i < Math.floor(count * 0.9)) {
      const l = { ...b, id: "ledger_" + i };
      truth[b.id] = l.id;
      if (i % 17 === 0) l.amount_minor = String(BigInt(l.amount_minor) + 1n);
      if (i % 19 === 0) l.day = "2026-02-15";
      if (i % 7 === 0)
        b.description =
          "POS* " + b.description.replace("Juniper", "Junipre") + " #12345";
      ledger.push(l);
      if (i % 23 === 0 && i % 17 !== 0 && i % 19 !== 0)
        ledger.push({ ...l, id: "ambiguous_" + i });
    }
  }
  if (count > 55) {
    bank[55] = { ...bank[54]!, id: "bank_55" };
    truth["bank_55"] = null;
  }
  return {
    bank,
    ledger,
    truth,
    seed,
    scope:
      "Synthetic records; amount/date drift, formatting, typo, ambiguous and missing-counterpart injections.",
  };
}
export function descriptorFixture(count = 400) {
  const rng = random();
  return Array.from({ length: count }, (_, i) => {
    const merchant = defaultCatalog[i % defaultCatalog.length]!;
    const unknown = i % 5 === 0;
    const descriptor = unknown
      ? "UNLISTED SYNTHETIC VENDOR " + i
      : ["SQ* ", "TST* ", "POS* ", ""][Math.floor(rng() * 4)]! +
        (i % 7 === 0
          ? merchant.name.replace("Juniper", "Junipre")
          : merchant.name) +
        " #" +
        String(10000 + i);
    return { descriptor, truth: unknown ? null : merchant.id };
  });
}
