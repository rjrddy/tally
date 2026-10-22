# Native reproduction and local recording

The README's Docker Compose run creates the private database, migrates, seeds synthetic data and starts the API. Use the generated operator password in ignored `.env`. Do not supply real financial records.

For native checks, install Node LTS matching `.nvmrc`, Python and local Postgres utilities. Configure credentials, install dependencies, build and start a separate owned loopback database:

```sh
python3 scripts/configure.py
make setup build native-db
make lint test bench scan
```

`native-db` creates only `.cache/postgres/` under this repository, listens on loopback port 55440, enables password authentication and retains fsync/synchronous commits. The benchmark creates a uniquely named `tally_bench_*` schema in that private database and drops only its own schema after stopping its child API processes. Tests similarly use isolated schemas. Native and Linux CI environments are saved separately; do not label native numbers as cloud capacity.

The benchmark exercises two real HTTP API processes, concurrent duplicate posts, a SIGKILL while a request waits on the database journal lock, a proxy that consumes then drops a successful response, drift injection/repair, all decision status/latency samples, a SQL-blocked deadline, and labeled synthetic matching/enrichment. Sources and outputs live under `docs/results/`. The failed lexical replay-order test is preserved rather than overwritten. `make bench` requires the compiled sources; build first after changing TypeScript.

Run the local console after the checks:

```sh
node --env-file=.env dist/scripts/seed.js
node --env-file=.env dist/src/main.js
```

Visit http://127.0.0.1:8084. The seed is idempotent and retains its original source timestamps; a seed feed can become stale over time. That is intentional source-age monitoring, not a simulated live feed.

For an actual recording install Chromium using `.venv/bin/playwright install chromium`, keep the local console running, then execute `.venv/bin/python scripts/browser_check.py`. The script performs real operations and saves the screen recording, desktop/mobile screenshots and assertions. Use `ffprobe -v error -show_format -show_streams -of json docs/results/demo.webm > docs/results/demo-probe.json` for media metadata. The recording flow creates synthetic posts and review records; reruns may need a new synthetic reconciliation batch after its review items have been resolved.

Interrupt the API and run `make native-stop` to stop the owned database. Benchmark API ports are 18401/18402, the response-dropping proxy is 18403, and the console is 8084. Stop owned processes before reusing those ports.

CI runs the native core against a real Postgres service, then clones the repository independently and starts the Docker stack. The Compose check verifies seed, real authenticated posting, rejection, replay, cookie/CSRF/logout and identical balance projection after an actual database-container restart. Uploaded artifacts contain the raw checks and container logs.
