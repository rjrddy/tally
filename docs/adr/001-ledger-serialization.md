# Serialize the journal, not the whole application

Context: concurrent retries must not allocate multiple effects, race an overdraft, or disagree about the previous chain head.

Options: process-local locks, application transactions only, or a database-owned posting function with a transaction-scoped advisory lock.

Decision: the Postgres function validates bounded exact amounts, serializes journal append, locks accounts in stable order, checks immutable request text, and commits the event, lines, projection and audit together. Runtime credentials can call the function and read facts but cannot directly edit balances or journal facts. Deferred constraints reject an incomplete/unbalanced journal independently of the TypeScript validator.

Tradeoffs: a global ledger chain limits posting throughput and creates an availability dependency on Postgres. Sequence gaps after aborted writes are valid. This is one workspace and one currency per journal; FX, accounting policy, tenant isolation and distributed partitioning are unfinished. A database administrator remains trusted. The native database and CI database versions are recorded separately; native latency is not a hosted capacity claim.

References: [Postgres transaction locks](https://www.postgresql.org/docs/18/explicit-locking.html), [security-definer search paths](https://www.postgresql.org/docs/current/sql-createfunction.html).
