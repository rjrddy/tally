# Audited decisions with explicit versions and bounded responses

Context: the same request must keep its original explanation after rules change. A slow database must not turn an unbounded wait into an apparent approval.

Options: mutable active rules, in-memory decisions, or immutable rule snapshots with durable result records and idempotent IDs.

Decision: rules are content-addressed canonical snapshots. Every request specifies a version; its validated input and deterministic result persist before success. Database statement timeouts and an API response deadline bound the response path. Admission remains occupied until the underlying database work settles, even if the client has already received a deadline error.

Tradeoffs: a lost acknowledgement or response deadline can leave the commit outcome unknown. Retrying the same ID is required; changing its payload is a conflict. Scheduling and transport can exceed a nominal timer under overload, so this is not a hard real-time guarantee. The benchmark reports full observed HTTP latency samples and all statuses, and tests a real query blocked by a database lock. Rule publication is not an approval workflow or a real financial authorization integration.
