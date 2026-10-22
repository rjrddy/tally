# Version data dependencies and show the hosting boundary

Context: a cache can outlive a merchant catalog, and a newly ingested feed can contain old source data. The user requested public Vercel visibility while the ledger requires durable Postgres.

Options: mutable catalog caches and ingestion-age freshness; or content-versioned catalogs, source-event timestamps and explicit unknown/stale outcomes.

Decision: catalog versions participate in the bounded cache key. Similarity is a string score rather than a probability. Feed identities cannot be overwritten; monitoring checks expected IDs, source age, ratio outliers and future timestamps. Every financial record and feed value is synthetic. Public hosting presents saved measured evidence and a real console recording; the full interactive runtime is local Compose until a persistent backend is actually configured and verified.

Tradeoffs: no real bank, merchant network or public financial records are used. Catalog quality is evaluated only on the labeled synthetic corruption set. Feed configuration changes are operator actions and not a complete event-sourced market-data platform. Backup/restore, remote backend operation, distributed tracing and multi-tenant authorization remain unfinished. An optional persistent-host deployment template is not a claim that a paid disk or account has been provisioned.
