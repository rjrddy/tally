# Tally interview guide

## Two-minute pitch

Tally is an original synthetic ledger, decision and reconciliation system. The hard part is keeping the same monetary facts when requests race, a process dies, an acknowledgement disappears or rules change.

I moved the posting boundary into Postgres. Exact integer strings enter through NestJS; a database-owned function checks idempotency, currency, conservation and overdraft guards, appends immutable facts and updates balances atomically. Runtime credentials cannot directly edit the journal or balances. TypeScript independently verifies the hash chain and rebuilds the projection.

The real HTTP campaign posted 1,000 journals across independent API processes and replayed 1,003 total events after duplicate, process-kill and lost-response cases. A corrupted projection was detected and rebuilt to the original digest. The decision campaign measured p99 of 14.386 ms at concurrency 16 across 400 requests, with no failures. Reconciliation matched 151 of 200 synthetic bank records without a false match; recall was 84.36%, so abstention is a visible tradeoff. These are bounded local results, not a hosted financial-service SLO. Sources: [ledger](docs/results/ledger.json), [decisions](docs/results/decisions.json), [reconciliation](docs/results/reconciliation.json).

## Ten-minute architecture walkthrough

Start in the posting form. Money is a string so it never crosses an unsafe JSON numeric boundary. The schema rejects non-integer, zero-line, duplicate-account and unbalanced input. A journal names one currency and distinct accounts.

Trace a posting into Postgres. The function takes the journal lock, checks whether the request key already has immutable canonical input, locks the accounts, enforces currency and no-overdraft rules, allocates an event, and updates all related facts and derived balances in one transaction. Sequence values may have gaps. Deferred constraints check that a completed event has balanced lines. Database permissions deny direct fact edits by the application role.

Then kill an API process while its request waits behind the database lock. Retry through the other process with the same key. The effect remains unique, even if the original acknowledgement was lost. A separate HTTP proxy consumes a successful upstream response and closes the client connection; retry returns the committed event. This does not pretend transport delivers exactly once.

Open replay. The service reads events in numeric sequence order, verifies digests, identities and previous links, and reconstructs with BigInt. It compares the derived balances with the stored projection under the same lock. The original tests caught lexical sequence sorting; that failed run remains in results. Deliberate projection corruption then exercises detection and transactional repair.

Move to decisions. Content-addressed immutable rules and validated inputs determine a stable output. A changed rule cannot change an old decision. Each successful response follows a durable record. A database lock demonstrates the deadline error; the client must retry the same request ID if commit status is unknown. Admission is held until actual work ends.

Move to reconciliation. The batch freezes bank input and eligible ledger facts. Exact amount/currency and bounded dates precede fuzzy text ranking. Mutual ambiguity checks prevent greedy input-order wins. Open exceptions require an optimistic version and a unique ledger assignment. Competing reviewers are covered by an actual database race.

Finish with the data-health page: versioned synthetic catalog enrichment, explicit unknowns, bounded cache, stale/missing/outlier/future source checks, and committed audit events. The real React console operates the local NestJS/Postgres stack. Vercel hosts the recording and measured evidence; persistent interactive hosting remains partial.

## Five tradeoffs

- Global journal serialization makes chain order and overdrafts easy to reason about; it limits throughput and does not provide high availability.
- Exact minor-unit strings avoid floating drift and unsafe JSON numbers; the caller must understand currency units, and FX/accounting policy is outside the implementation.
- Independent replay makes drift detectable; replaying the entire history in memory is not a large-ledger snapshot strategy.
- Mutual conservative matching favors precision and exposes exceptions; its recall does not make every batch fully automatic.
- Explicit content versions make replay and cache invalidation inspectable; version publication is not a reviewed policy activation or tenant-scoped authorization system.

## Five failure modes

- Repeated or conflicting posting: the request key returns the same event for identical canonical input and rejects changed input. Database uniqueness and locking operate across processes.
- Concurrent overspend: locked account rows and the balance guard reject the losing transaction atomically; there is no partial journal.
- API crash or lost response: the outcome may be uncertain to the caller, so it retries the same key. The process and proxy fault campaigns test both cases.
- Projection drift or bad replay order: hash-checked numeric replay detects inconsistency and transactionally rebuilds derived balances; the recorded ordering bug was fixed.
- Stale or ambiguous operational evidence: rules retain their versions, matching abstains on competing candidates, reviewers need the current row version, and feed checks use source timestamps rather than ingestion time.

## Fifteen likely questions

1. **Is this exactly-once execution?** No. Requests can execute repeatedly. One key is bound to one canonical posting, so transaction effects are idempotent. Lost acknowledgements still require retry discipline.
2. **Why a database function?** It centralizes the monetary write boundary and lets runtime credentials have less privilege. Application validation improves errors; independent database checks protect monetary facts.
3. **Why both global and account locks?** The global lock serializes the chain. Account locks make the account update boundary explicit and would matter when the chain is partitioned. This version does not claim partitioned concurrency.
4. **Can sequence gaps break replay?** No. Replay needs strictly increasing numeric order, not consecutive values. The lexical ordering bug illustrates why casting for JSON must not control sorting.
5. **What does the hash chain protect?** Changes relative to trusted previous state. A privileged administrator can rewrite the entire chain; external notarization and an independently trusted root are not implemented.
6. **Does replay recreate all application tables?** No. It reconstructs monetary balances from immutable journal facts. Account metadata is reference configuration with creation audit; decisions and review records have their own durable histories.
7. **How are large amounts represented?** JSON strings validated as bounded integers, BigInt in TypeScript, exact NUMERIC in Postgres. HTTP tests cover values beyond JavaScript's safe integer range.
8. **What if two requests spend the same balance?** The database serializes the relevant checks and updates. The losing overdraft request aborts with no event or projection effect.
9. **What if a decision times out after commit?** The client may not know whether it committed. Retry the same request ID and version; different payloads conflict. The service does not turn a deadline into approval.
10. **Why explicit rule versions?** Replay needs the original semantics, not whatever is active later. Input, version and result are retained together, and the snapshot hash is checked.
11. **Why no globally optimal reconciliation assignment?** A mathematically maximal assignment can force dubious matches. Mutual unambiguous selection is inspectable; the exception queue preserves uncertainty rather than hiding it.
12. **Can two reviewers pick the same ledger entry?** A unique database constraint rejects the second assignment in the batch. Expected row versions protect the same exception from stale updates, and the review transaction includes its audit.
13. **How do you prevent stale enrichment cache entries?** The catalog content version is in the key. A changed catalog gives a different version and cannot reuse the old result. Cache hits are process-local and not a global persisted metric.
14. **Does a recent ingestion timestamp mean a feed is fresh?** No. Source event timestamps drive age; future points are flagged and cannot conceal stale history. The feed values are synthetic, not a market-data feed integration.
15. **What do the benchmark numbers establish?** The recorded local workload and injected cases only. Samples, statuses, concurrency, database environment and labels are saved. Real bank accuracy, hosted latency, replicated failover and accounting-policy correctness are not measured.

## With three more months

Add tenant boundaries, reviewed rule activation and richer ledger semantics such as holds, capture and explicit reversal links. Build streaming replay and snapshots, a backup/restore campaign and replicated failover tests. Independently design new matching fixtures before increasing automation. Configure and measure a persistent hosted backend, add pagination/retention and distributed tracing, and keep every new guarantee tied to a saved failure campaign rather than extending the current claims by analogy.
