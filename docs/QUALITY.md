# Tally checkpoint

Status: **partial for persistent interactive hosting**. The local stack is a working NestJS/Postgres/React system; the public Vercel page presents a real recording and measured evidence.

| Required check | Evidence | Status |
| --- | --- | --- |
| Hard core written and explained | Database-owned posting, exact replay, versioned decisions, mutual matching, [design](DESIGN.md) | local implementation |
| Fresh-clone runtime | [Compose CI](https://github.com/rjrddy/tally/actions/workflows/ci.yml) builds/migrates/seeds and tests an actual Postgres restart | result in exact-commit run |
| Live local UI | [Browser assertions](results/browser.json), screenshots and [actual console recording](results/demo.webm) | pass |
| Tests, integration and property/chaos | [checks](results/checks.log), [ledger faults](results/ledger.json), [deadline](results/decisions.json) | local pass |
| Saved measurements | [ledger](results/ledger.json), [decisions](results/decisions.json), [matching](results/reconciliation.json), [enrichment](results/enrichment.json), [freshness](results/freshness.json) | pass |
| Caught failure retained | [lexical replay ordering failure](results/initial-replay-order-failure.log), rejected imbalance and actual projection fault | pass |
| ADRs | [design decisions](adr/) | pass |
| Interview and drill | [INTERVIEW](../INTERVIEW.md), [DRILL](DRILL.md) | pass |
| CI green | All pushes run build/lint/tests/bench/scans and independent Compose | [![CI](https://github.com/rjrddy/tally/actions/workflows/ci.yml/badge.svg)](https://github.com/rjrddy/tally/actions/workflows/ci.yml) |
| Measured claims | README generated from saved local command output | pass for stated workload |
| Persistent interactive deployment | No live Postgres backend configured for public access | partial |

## Scope boundaries

All records, merchants, rules and feed values are synthetic. This is not real-money movement, financial guidance, a bank integration or regulatory accounting validation. The native database version and commit durability settings are recorded in environment results. Linux CI exercises a separate real Postgres version; its artifacts are independent evidence, not a substitute for the native latency sample.

The journal is serialized globally and each entry has one currency. Runtime permissions and database constraints protect facts from the application role. A database administrator can rewrite or bypass the whole chain; external notarization is not implemented. Replay rebuilds balance projections, while account metadata is immutable reference configuration with creation audit. Large-history streaming, snapshots, backups, replicated failover, FX, accounting policy and tenant authorization are unfinished.

The deadline is a bounded response policy subject to runtime scheduling. It can leave commit outcome unknown; retry the same ID. Raw latency samples include all statuses in each clean-load profile; intentionally injected SQL-stall behavior is reported separately. These samples do not establish a cloud SLO.

Matching is deliberately conservative. The fixture contains amount/date drift, formatting changes, duplicate competition, ambiguity and missing counterparts; recall includes abstention on those known pairs. Manual review enforces compatibility, version and unique assignment but does not prove the selected economic identity. Enrichment accuracy is on its synthetic labeled corruption set only. Similarity is not calibrated probability. Feed source age is distinct from ingestion age, and future timestamps are explicit alerts.

## Demo flow

Post a synthetic transfer; retry the same key; inject a rejected imbalance; verify the journal; publish a stricter rule and observe a changed decision under the new version; replay old decisions; resolve a reconciliation exception; inspect descriptor enrichment and source health; reload persisted state. Follow [REPRODUCE](REPRODUCE.md) for the local commands and actual recording script.

No original repository, previous flagship or existing portfolio was moved, archived, tagged or deleted. Stop before Tether for review.
