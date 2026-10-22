# Follow-up drill

1. **The client retries after a network timeout.** Reuse the same immutable key and payload. The original commit may already exist; returning its event is safer than assuming failure.
2. **The key is reused with another amount.** Reject the conflict before any new effect. A retry key is not a mutable transaction name.
3. **Two API processes see the same starting balance.** The database lock and update boundary decide the winner; process memory does not establish correctness.
4. **The service dies while waiting for the lock.** The surviving process can retry the same key. The fault campaign observes the blocked query before the actual SIGKILL.
5. **The response disappears after commit.** The HTTP proxy test consumes and drops it. Retry returns the already committed event without another balance effect.
6. **A projection changes without a journal entry.** Replay derives the expected state independently, reports the drift and can rebuild under the journal lock. Runtime direct edits are denied.
7. **An administrator rewrites the whole chain.** That exceeds the trust boundary. Local hashes do not provide external notarization or protect against the database owner.
8. **Sequence values are not consecutive.** Aborted allocations can leave gaps. Strict numeric ordering and identity checks are sufficient; lexical sorting was a real caught bug.
9. **A request sends a floating number.** Reject it. Exact minor-unit strings are part of the API contract rather than silently rounding.
10. **A journal mixes currencies.** The request names one currency and database account/currency foreign keys prevent mismatches. FX is outside this version.
11. **A rule is edited after a decision.** Publish a new content version. The old immutable snapshot and decision result remain replayable.
12. **The database stalls behind a lock.** Statement/response deadlines produce an error, with no approval implied. Admission remains occupied until actual work settles.
13. **A request times out but later commits.** This is an uncertain acknowledgement, not permission to generate a new ID. Idempotent retry is the recovery mechanism.
14. **Every fuzzy candidate looks similar.** Abstain. Scores are string evidence and not calibrated probabilities; the queue exposes the ambiguity.
15. **Two bank rows claim one ledger row.** Mutual competition rejects automatic assignment, and database uniqueness protects manual review.
16. **A reviewer submits stale state.** The expected exception version and row lock reject the write. Successful resolution and audit commit together.
17. **The catalog changes while cache entries remain.** The content version changes the key. Old and new results remain separate rather than using time-based invalidation alone.
18. **A feed has a future source timestamp.** Flag it and exclude it from the newest valid source age. It must not make stale data appear fresh.
19. **Someone calls this a hosted financial system.** Correct the scope: a synthetic local Postgres system with a public evidence site. No bank integration or persistent public backend is established.
20. **Why not scale immediately?** First measure where serialization or replay memory becomes limiting, then add partitions/snapshots and failure campaigns. Current local latency is not evidence of distributed correctness.
