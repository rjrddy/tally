"""README figures are read only from actual saved runs."""

import json
from pathlib import Path

root = Path("docs/results")
ledger = json.loads((root / "ledger.json").read_text())
decision = json.loads((root / "decisions.json").read_text())
recon = json.loads((root / "reconciliation.json").read_text())
enrichment = json.loads((root / "enrichment.json").read_text())
load = decision["latencies"][-1]
site = (
    json.loads(Path("deploy/published.json").read_text())["url"]
    if Path("deploy/published.json").exists()
    else "not deployed"
)
readme = f"""# Tally

1. **Problem:** Concurrent retries, changing rules and ambiguous financial records can silently break balances or erase the reasons behind a decision.

2. **Result:**

- Journal: {ledger["posted"]["count"]:,} real HTTP posts across two API processes; {ledger["replay"]["events"]:,} events replayed to identical balances; {ledger["concurrent_replays"]} concurrent retries created {ledger["duplicate_event_ids"]} event. API SIGKILL, lost-response retry and projection corruption/repair passed. [Raw journal campaign](docs/results/ledger.json)
- Decisions: HTTP p99 {load["p99_ms"]:.3f} ms at concurrency {load["concurrency"]}, {load["count"]} samples, {load["failures"]} failures; {decision["replay"]["exact"]:,}/{decision["replay"]["decisions"]:,} stored decisions replayed exactly. Local round trips include durable audit commits; the latency target is not a production SLO. [Samples](docs/results/decisions.json)
- Matching: {recon["matches"]}/{recon["bank_records"]} bank records matched, precision {recon["precision"]:.2%}, recall {recon["recall"]:.2%}, {recon["false_matches"]} false matches on injected noise; descriptor accuracy {enrichment["accuracy"]:.2%} on {enrichment["samples"]} synthetic labeled strings. [Reconciliation](docs/results/reconciliation.json) · [Enrichment](docs/results/enrichment.json)

3. **Architecture:**

```mermaid
flowchart LR
    U[React operations console] --> A[NestJS / sessions / CSRF]
    A --> L[Postgres posting function / idempotency / lock]
    L --> E[(Immutable journal and signed lines)]
    E --> R[Hash-checked replay]
    R --> B[(Rebuildable balance projection)]
    A --> D[Versioned decision rules / bounded response budget]
    D --> P[(Input + rule + result audit)]
    A --> M[Mutual fuzzy matching / review queue]
    M --> P
    A --> F[Synthetic feed health / versioned enrichment]
```

4. **Run it:**

```sh
python3 scripts/configure.py
docker compose up --build --wait
open http://localhost:8084
```

Use the generated operator password from ignored `.env`. Node and Postgres run inside Compose; migration and idempotent synthetic seeding are part of startup. Docker Compose and Python are prerequisites. Native development and benchmark commands are in [REPRODUCE](docs/REPRODUCE.md).

5. **Decisions and limits:**

**Partial for persistent interactive hosting.** Public evidence hosting: {site}. The site presents the real console recording and measured runs; it does not run a durable ledger. Every financial record, merchant and feed value is synthetic. No financial network, bank, employer code or real customer data is used.

Money is bounded integer strings over JSON, BigInt in TypeScript and exact Postgres NUMERIC. Each journal uses one currency; account currency, conservation, idempotency and optional no-overdraft guards are enforced transactionally. The runtime role cannot directly update journal facts or balances. A global ledger lock serializes the chain; high availability, sharding, live hosted latency, multi-tenant accounting, FX, tax and regulatory accounting policy are not measured or implemented. A database administrator able to rewrite the whole chain is outside the integrity boundary.

A decision deadline can leave its commit outcome unknown to a caller. Retry the same request ID; admission remains occupied until actual database work ends. Reconciliation deliberately abstains on amount/date drift and ambiguity. Its selected fixture is not evidence of real banking accuracy. Manual review checks the frozen snapshot, amount/currency, version and uniqueness; a human can still make a wrong selection. Source health uses event timestamps, not recent ingestion; feed values are simulated.

Reproduce the core proof with `make lint test bench`. See [caught replay ordering failure](docs/results/initial-replay-order-failure.log), [current checks](docs/results/checks.log), [design](docs/DESIGN.md), [ADRs](docs/adr/), [quality checkpoint](docs/QUALITY.md), [interview guide](INTERVIEW.md), [drill](docs/DRILL.md), and [migration provenance](docs/migration/tally.md). The benchmark catches unbalanced input, conflicting keys, direct mutation attempts, projection drift and a real SQL-blocked decision deadline.

6. **Next:**

Host the persistent backend with explicitly configured Postgres credentials; add backup/restore and replicated failover campaigns, tenant isolation, hold/capture/reversal semantics, accounting policy, reviewed rule activation and independently designed matching fixtures. Add distributed tracing and pagination/retention beyond the bounded demo. Keep these limits separate from the measured local correctness and latency results.
"""
Path("README.md").write_text(readme)
print("README rendered from saved command results.")
