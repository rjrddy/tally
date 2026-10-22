# Salvage record

All old repositories remain intact. No old measurement is reused.

| Source | Adapted idea | Rewrite |
| --- | --- | --- |
| F1 `src/ledger.py` and property tests | Integer postings, idempotency, hash-checked replay | TypeScript validation/BigInt replay and database-owned Postgres posting with immutable facts, projection repair and concurrency checks |
| F2 `src/engine.py` | Immutable rule snapshots and replayable audited decisions | Explicit versioned rules, Postgres uniqueness, real HTTP budget/load measurements and admission/deadline behavior |
| F4 `src/main.py` | Amount/currency/date constraints and fuzzy descriptors | Mutual unambiguous candidate selection, persisted batches, optimistic review and uniqueness across reviewers |
| F6 `src/main.py` | Missingness, outlier and source-age monitoring | Synthetic-only feeds with future timestamp handling, persisted observations and a live source-health view |
| F7 `src/main.py` | Descriptor normalization, unknown result and bounded cache | Version-keyed catalog snapshots, conservative matching and separately labeled evaluation |

The process-local locks, append-only JSON demo store, TestClient latency numbers, public financial filing data and greedy order-dependent matching are not carried forward. API, Postgres schema, database privileges and React console are new implementations.
