import "./motion";
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
type Account = {
  id: string;
  currency: string;
  balance: string;
  allow_negative: boolean;
};
type Entry = {
  seq: string;
  event_id: string;
  request_key: string;
  currency: string;
  request_text: string;
  hash: string;
  created_at: string;
};
type Rule = { version: string; snapshot_text: string };
type RecordRow = {
  id: string;
  amount_minor: string;
  currency: string;
  day: string;
  description: string;
};
type Batch = {
  id: string;
  bank: RecordRow[];
  ledger: RecordRow[];
  summary: { matches: unknown[]; exceptions: unknown[] };
};
type State = {
  accounts: Account[];
  events: Entry[];
  rules: Rule[];
  decisions: {
    request_id: string;
    version: string;
    result_text: string;
    created_at: string;
  }[];
  catalogs: { version: string; snapshot_text: string }[];
  batches: Batch[];
  exceptions: {
    batch_id: string;
    bank_id: string;
    reason: string;
    status: string;
    version: number;
  }[];
  matches: {
    batch_id: string;
    bank_id: string;
    ledger_id: string;
    kind: string;
  }[];
  audit: { id: string; kind: string; body: unknown; created_at: string }[];
};
type Feed = {
  source: string;
  age_ms: number | null;
  budget_ms: number;
  points: number;
  healthy: boolean;
  alerts: { kind: string; id?: string; age_ms?: number }[];
};
type Verdict = {
  approved: boolean;
  reasons: string[];
  score: number;
  rule_version: string;
  request_id: string;
};
type Replay = {
  events: number;
  projection_equal: boolean;
  projection_sha256: string;
  head: string;
  drift: string[];
  rebuilt: boolean;
};
type Enriched = {
  id: string | null;
  name: string | null;
  category: string;
  similarity: number;
  catalog_version: string;
  method: string;
  cache: { hits: number; misses: number; size: number };
};
const minor = (v: string) => BigInt(v).toLocaleString("en-US");
function App() {
  const [state, setState] = useState<State | null>(null),
    [ready, setReady] = useState(false),
    [csrf, setCsrf] = useState(""),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [tab, setTab] = useState("Ledger"),
    [trace, setTrace] = useState("");
  const [amount, setAmount] = useState("1250"),
    [postKey, setPostKey] = useState("console_transfer_1"),
    [postResult, setPostResult] = useState<{
      event_id: string;
      replayed: boolean;
      seq: string;
    } | null>(null),
    [replayResult, setReplayResult] = useState<Replay | null>(null);
  const [decisionAmount, setDecisionAmount] = useState("9000"),
    [risk, setRisk] = useState("40"),
    [country, setCountry] = useState("US"),
    [requestId, setRequestId] = useState("console_decision_1"),
    [decision, setDecision] = useState<Verdict | null>(null),
    [riskCap, setRiskCap] = useState("60"),
    [amountCap, setAmountCap] = useState("100000"),
    [published, setPublished] = useState(""),
    [decisionReplay, setDecisionReplay] = useState<{
      decisions: number;
      exact: number;
    } | null>(null);
  const [selection, setSelection] = useState<Record<string, string>>({}),
    [feed, setFeed] = useState<Feed[]>([]),
    [descriptor, setDescriptor] = useState("SQ* Synthetic Juniper Cafe #1947"),
    [enriched, setEnriched] = useState<Enriched | null>(null);
  async function refresh() {
    try {
      const r = await fetch("/api/state");
      if (r.status === 401) {
        setReady(false);
        return;
      }
      if (!r.ok) throw Error("Database-backed service unavailable");
      setState(await r.json());
      setReady(true);
      const [s, f] = await Promise.all([
        fetch("/api/session"),
        fetch("/api/freshness"),
      ]);
      if (s.ok) setCsrf((await s.json()).csrf ?? "");
      if (f.ok) setFeed(await f.json());
    } catch (e) {
      setError(String(e));
    }
  }
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 2500);
    return () => clearInterval(timer);
  }, []);
  async function action<T>(
    path: string,
    body: unknown = {},
  ): Promise<T | undefined> {
    setBusy(true);
    setError("");
    try {
      const r = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
        body: JSON.stringify(body),
      });
      setTrace(r.headers.get("X-Trace-ID") ?? "");
      const value = await r.json();
      if (!r.ok) throw Error(value.error ?? "Action failed");
      await refresh();
      return value as T;
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function login(e: React.FormEvent) {
    e.preventDefault();
    const r = await action<{ csrf: string }>("/api/login", { password });
    if (r) {
      setCsrf(r.csrf);
      setPassword("");
      await refresh();
    }
  }
  const currentRule = published || state?.rules[0]?.version || "";
  const batch = state?.batches[0],
    exceptions =
      state?.exceptions.filter(
        (e) => e.batch_id === batch?.id && e.status === "open",
      ) ?? [],
    matches = state?.matches.filter((m) => m.batch_id === batch?.id) ?? [];
  const currencies = Array.from(
    new Set(state?.accounts.map((a) => a.currency) ?? []),
  );
  const conserved = currencies.every(
    (c) =>
      state!.accounts
        .filter((a) => a.currency === c)
        .reduce((sum, a) => sum + BigInt(a.balance), 0n) === 0n,
  );
  async function post(imbalance = false) {
    const n = BigInt(amount);
    const result = await action<{
      event_id: string;
      seq: string;
      replayed: boolean;
    }>("/api/ledger/post", {
      idempotency_key: postKey,
      currency: "USD",
      day: new Date().toISOString().slice(0, 10),
      description: "Synthetic console transfer",
      lines: [
        { account_id: "cash", amount_minor: String(-n) },
        {
          account_id: "clearing",
          amount_minor: String(n + (imbalance ? 1n : 0n)),
        },
      ],
    });
    if (result) setPostResult(result);
  }
  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="/">
          t/ <span>TALLY</span>
        </a>
        <p className="rail-label">THE BOOKKEEPER’S INDEX</p>
        <nav>
          {[
            "Ledger",
            "Decisions",
            "Reconciliation",
            "Data health",
            "Audit trail",
          ].map((t, i) => (
            <button
              key={t}
              className={tab === t ? "active" : ""}
              aria-current={tab === t ? "page" : undefined}
              onClick={() => setTab(t)}
            >
              <span>{String(i + 1).padStart(2, "0")}</span>
              {t}
            </button>
          ))}
        </nav>
        <div className="rail-note">
          <span className="small-dot" /> Local Postgres journal
          <p>
            Original software.
            <br />
            Synthetic records only.
          </p>
          <a href="https://github.com/rjrddy/tally">Repository ↗</a>
        </div>
      </aside>
      <div className="workspace">
        <header>
          <div>
            <span className="dot" />
            {ready ? "Database connected" : "Operator sign-in"}
            <span className="separator">/</span>
            <span>SINGLE WORKSPACE</span>
          </div>
          {ready && (
            <button
              className="text-button"
              onClick={() =>
                void action("/api/logout").then(() => setReady(false))
              }
            >
              Sign out ↗
            </button>
          )}
        </header>
        <main>
          <div className="heading">
            <div>
              <p className="eyebrow">THE TALLY JOURNAL / {tab.toUpperCase()}</p>
              <h1>Every cent has a history.</h1>
              <p className="intro">
                A journal, a decision, a match. Keep the evidence that connects
                them.
              </p>
            </div>
            <span className="pill neutral">Synthetic environment</span>
          </div>
          {error && (
            <div className="error" role="alert">
              {error}
            </div>
          )}
          {!ready ? (
            <form className="panel login" onSubmit={login}>
              <p className="eyebrow">OPERATOR ACCESS</p>
              <h2>Open the books.</h2>
              <p className="muted">
                Use the password generated in your ignored .env. This console
                does not connect to financial networks or move money.
              </p>
              <label>
                Operator password
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </label>
              <button disabled={busy}>Sign in →</button>
            </form>
          ) : (
            <>
              <div className="stats">
                <div>
                  <span>Book conservation</span>
                  <strong className={conserved ? "good" : "bad"}>
                    {conserved ? "Balanced" : "Drift detected"}
                  </strong>
                  <small>Sum of signed balances, by currency</small>
                </div>
                <div>
                  <span>Journal head</span>
                  <strong>{state?.events[0]?.seq ?? "—"}</strong>
                  <small>Sequence gaps can follow aborted writes</small>
                </div>
                <div>
                  <span>Open review items</span>
                  <strong>{exceptions.length}</strong>
                  <small>Latest frozen reconciliation batch</small>
                </div>
              </div>
              {tab === "Ledger" && (
                <>
                  <div className="grid">
                    <section className="panel">
                      <div className="section-title">
                        <h2>Accounts</h2>
                        <span className="pill">Exact minor units</span>
                      </div>
                      <div className="tablewrap">
                        <table>
                          <thead>
                            <tr>
                              <th>Account</th>
                              <th>Currency</th>
                              <th className="numeric">Balance</th>
                              <th>Guard</th>
                            </tr>
                          </thead>
                          <tbody>
                            {state?.accounts.map((a) => (
                              <tr key={a.id}>
                                <td>
                                  <b>{a.id}</b>
                                </td>
                                <td>{a.currency}</td>
                                <td className="numeric mono">
                                  {minor(a.balance)}
                                </td>
                                <td>
                                  <span className="pill neutral">
                                    {a.allow_negative
                                      ? "Signed balance"
                                      : "No overdraft"}
                                  </span>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <p className="muted">
                        Amounts stay as integer strings over HTTP and exact
                        numbers in Postgres. These are synthetic bookkeeping
                        examples.
                      </p>
                    </section>
                    <section className="panel">
                      <div className="section-title">
                        <h2>Post a transfer</h2>
                        <span className="pill neutral">
                          USD / cash → clearing
                        </span>
                      </div>
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void post();
                        }}
                      >
                        <label>
                          Idempotency key
                          <input
                            value={postKey}
                            onChange={(e) => setPostKey(e.target.value)}
                            required
                            pattern="[A-Za-z0-9_-]{1,80}"
                          />
                        </label>
                        <label>
                          Amount in minor units
                          <input
                            value={amount}
                            onChange={(e) => setAmount(e.target.value)}
                            required
                            pattern="[1-9][0-9]{0,17}"
                            inputMode="numeric"
                          />
                        </label>
                        <div className="actions">
                          <button disabled={busy}>Post transfer</button>
                          <button
                            className="secondary"
                            type="button"
                            onClick={() =>
                              setPostKey("console_" + crypto.randomUUID())
                            }
                          >
                            New key
                          </button>
                        </div>
                      </form>
                      <button
                        className="text-button warning"
                        disabled={busy}
                        onClick={() => void post(true)}
                      >
                        Inject one-cent imbalance ↗
                      </button>
                      {postResult && (
                        <div className="result">
                          <span className="pill">
                            {postResult.replayed
                              ? "Idempotent replay"
                              : "Committed"}
                          </span>
                          <p>Journal sequence {postResult.seq}</p>
                          <code>{postResult.event_id}</code>
                        </div>
                      )}
                      <p className="muted">
                        Retry the same key and payload to return the committed
                        event. Changing the payload under that key produces a
                        conflict.
                      </p>
                    </section>
                  </div>
                  <section className="panel">
                    <div className="section-title">
                      <div>
                        <h2>Journal → projection</h2>
                        <p className="muted">
                          Recompute balances from immutable, hash-checked
                          events.
                        </p>
                      </div>
                      <div className="actions">
                        <button
                          className="secondary"
                          disabled={busy}
                          onClick={() =>
                            void action<Replay>("/api/ledger/replay").then(
                              (r) => r && setReplayResult(r),
                            )
                          }
                        >
                          Verify journal
                        </button>
                        <button
                          disabled={busy}
                          onClick={() =>
                            void action<Replay>("/api/ledger/rebuild").then(
                              (r) => r && setReplayResult(r),
                            )
                          }
                        >
                          Rebuild projection
                        </button>
                      </div>
                    </div>
                    {replayResult && (
                      <div className="verification">
                        <b>
                          {replayResult.rebuilt
                            ? "Projection rebuilt"
                            : replayResult.projection_equal
                              ? "Replay matches balances"
                              : "Projection drift detected"}
                        </b>
                        <span>{replayResult.events} verified events</span>
                        <code>{replayResult.projection_sha256}</code>
                      </div>
                    )}
                    <div className="tablewrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Seq</th>
                            <th>Request key</th>
                            <th>Currency</th>
                            <th>Event digest</th>
                            <th>Committed</th>
                          </tr>
                        </thead>
                        <tbody>
                          {state?.events.map((e) => (
                            <React.Fragment key={e.event_id}>
                              <tr>
                                <td className="mono">{e.seq}</td>
                                <td>
                                  <details>
                                    <summary>{e.request_key}</summary>
                                    <pre>
                                      {JSON.stringify(
                                        JSON.parse(e.request_text),
                                        null,
                                        2,
                                      )}
                                    </pre>
                                  </details>
                                </td>
                                <td>{e.currency}</td>
                                <td className="mono">{e.hash.slice(0, 16)}…</td>
                                <td>
                                  {new Date(e.created_at).toLocaleTimeString()}
                                </td>
                              </tr>
                            </React.Fragment>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="muted">
                      Latest stored events. A database administrator who
                      rewrites the complete chain is outside this integrity
                      boundary.
                    </p>
                  </section>
                </>
              )}
              {tab === "Decisions" && (
                <>
                  <div className="grid">
                    <section className="panel">
                      <h2>Evaluate a synthetic request</h2>
                      <p className="muted">
                        An explicit rule version is persisted with the input and
                        result. The response budget is bounded; this is not
                        financial guidance.
                      </p>
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void action<Verdict>("/api/decisions", {
                            request_id: requestId,
                            amount_minor: decisionAmount,
                            risk_points: Number(risk),
                            country,
                            rule_version: currentRule,
                          }).then((r) => r && setDecision(r));
                        }}
                      >
                        <label>
                          Decision request ID
                          <input
                            value={requestId}
                            onChange={(e) => setRequestId(e.target.value)}
                            required
                          />
                        </label>
                        <div className="form-row">
                          <label>
                            Decision amount, minor units
                            <input
                              value={decisionAmount}
                              onChange={(e) =>
                                setDecisionAmount(e.target.value)
                              }
                              required
                              pattern="[1-9][0-9]{0,17}"
                            />
                          </label>
                          <label>
                            Risk points
                            <input
                              type="number"
                              min="0"
                              max="100"
                              value={risk}
                              onChange={(e) => setRisk(e.target.value)}
                              required
                            />
                          </label>
                        </div>
                        <label>
                          Country
                          <select
                            value={country}
                            onChange={(e) => setCountry(e.target.value)}
                          >
                            {["US", "CA", "GB", "ZZ"].map((c) => (
                              <option key={c}>{c}</option>
                            ))}
                          </select>
                        </label>
                        <code className="digest">
                          Rule {currentRule || "Publish a rule first"}
                        </code>
                        <div className="actions">
                          <button disabled={busy || !currentRule}>
                            Evaluate request
                          </button>
                          <button
                            className="secondary"
                            type="button"
                            onClick={() =>
                              setRequestId("decision_" + crypto.randomUUID())
                            }
                          >
                            New request ID
                          </button>
                        </div>
                      </form>
                      {decision && (
                        <div
                          className={
                            "decision " +
                            (decision.approved ? "allow" : "decline")
                          }
                        >
                          <strong>
                            {decision.approved
                              ? "Approved by demo rules"
                              : "Declined by demo rules"}
                          </strong>
                          <p>
                            {decision.reasons.join(" · ") ||
                              "All configured checks passed"}
                          </p>
                          <code>{decision.rule_version.slice(0, 20)}…</code>
                        </div>
                      )}
                    </section>
                    <section className="panel">
                      <h2>Publish a rule snapshot</h2>
                      <p className="muted">
                        New content creates a new version. Existing decisions
                        retain their original version and remain replayable.
                      </p>
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void action<{ version: string }>("/api/rules", {
                            max_amount_minor: amountCap,
                            risk_ceiling: Number(riskCap),
                            allowed_countries: ["US", "CA", "GB"],
                          }).then((r) => r && setPublished(r.version));
                        }}
                      >
                        <label>
                          Maximum amount, minor units
                          <input
                            value={amountCap}
                            onChange={(e) => setAmountCap(e.target.value)}
                            required
                            pattern="[1-9][0-9]{0,17}"
                          />
                        </label>
                        <label>
                          Maximum risk points
                          <input
                            type="number"
                            min="0"
                            max="100"
                            value={riskCap}
                            onChange={(e) => setRiskCap(e.target.value)}
                            required
                          />
                        </label>
                        <p className="muted">
                          Allowed countries: US, CA, GB (synthetic policy).
                        </p>
                        <button disabled={busy}>Publish immutable rules</button>
                      </form>
                      {published && (
                        <div className="result">
                          <b>Published</b>
                          <code>{published}</code>
                        </div>
                      )}
                      <div className="divider" />
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() =>
                          void action<{ decisions: number; exact: number }>(
                            "/api/decisions/replay",
                          ).then((r) => r && setDecisionReplay(r))
                        }
                      >
                        Replay stored decisions
                      </button>
                      {decisionReplay && (
                        <p className="decision-replay">
                          Exact replays: {decisionReplay.exact} /{" "}
                          {decisionReplay.decisions}
                        </p>
                      )}
                    </section>
                  </div>
                  <section className="panel">
                    <h2>Decision audit</h2>
                    <div className="tablewrap">
                      <table>
                        <thead>
                          <tr>
                            <th>Request</th>
                            <th>Outcome</th>
                            <th>Reasons</th>
                            <th>Rule version</th>
                          </tr>
                        </thead>
                        <tbody>
                          {state?.decisions.map((d) => {
                            const r = JSON.parse(d.result_text) as Verdict;
                            return (
                              <tr key={d.request_id}>
                                <td>{d.request_id}</td>
                                <td>
                                  <span
                                    className={
                                      "pill " + (r.approved ? "" : "block")
                                    }
                                  >
                                    {r.approved ? "Approved" : "Declined"}
                                  </span>
                                </td>
                                <td>
                                  {r.reasons.join(", ") ||
                                    "Configured checks passed"}
                                </td>
                                <td className="mono">
                                  {d.version.slice(0, 16)}…
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </section>
                </>
              )}
              {tab === "Reconciliation" && (
                <>
                  <section className="panel">
                    <div className="section-title">
                      <h2>Reconciliation workspace</h2>
                      <span className="pill neutral">
                        {batch?.id ?? "No batch seeded"}
                      </span>
                    </div>
                    <p className="muted">
                      Amounts and currencies must agree. Date and descriptor
                      similarity support a match only when both sides are
                      unambiguous. The snapshot stays fixed while new journals
                      arrive.
                    </p>
                    <div className="mini-stats">
                      <div>
                        <strong>
                          {matches.filter((m) => m.kind === "automatic").length}
                        </strong>
                        <span>Automatic matches</span>
                      </div>
                      <div>
                        <strong>{exceptions.length}</strong>
                        <span>Open exceptions</span>
                      </div>
                      <div>
                        <strong>
                          {matches.filter((m) => m.kind === "reviewed").length}
                        </strong>
                        <span>Reviewed matches</span>
                      </div>
                    </div>
                  </section>
                  <section className="panel">
                    <h2>Exception queue</h2>
                    <p className="muted">
                      Manual review enforces snapshot membership,
                      amount/currency agreement and one-to-one uniqueness. The
                      expected row version prevents a stale review from
                      overwriting a newer one.
                    </p>
                    {exceptions.length === 0 && (
                      <div className="empty">
                        No open exceptions in this batch.
                      </div>
                    )}
                    {exceptions.slice(0, 40).map((e) => {
                      const bank = batch!.bank.find((b) => b.id === e.bank_id)!,
                        options = batch!.ledger.filter(
                          (l) =>
                            l.amount_minor === bank.amount_minor &&
                            l.currency === bank.currency,
                        );
                      return (
                        <article
                          className="exception"
                          key={e.bank_id}
                          data-bank={e.bank_id}
                        >
                          <div className="section-title">
                            <div>
                              <h3>{bank.description}</h3>
                              <p className="muted">
                                {bank.id} · {bank.currency}{" "}
                                {minor(bank.amount_minor)} · {bank.day}
                              </p>
                            </div>
                            <span className="pill warning">
                              {e.reason.replaceAll("_", " ")}
                            </span>
                          </div>
                          <div className="review-row">
                            <label>
                              Ledger selection
                              <select
                                value={selection[e.bank_id] ?? ""}
                                onChange={(v) =>
                                  setSelection((s) => ({
                                    ...s,
                                    [e.bank_id]: v.target.value,
                                  }))
                                }
                              >
                                <option value="">
                                  {options.length
                                    ? "Choose after reviewing evidence"
                                    : "No amount-compatible ledger row"}
                                </option>
                                {options.map((l) => (
                                  <option value={l.id} key={l.id}>
                                    {l.description} · {l.day}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <button
                              disabled={busy || !selection[e.bank_id]}
                              onClick={() =>
                                void action("/api/reconcile/resolve", {
                                  resolution_id:
                                    "review_" + crypto.randomUUID(),
                                  batch_id: batch!.id,
                                  bank_id: e.bank_id,
                                  ledger_id: selection[e.bank_id],
                                  expected_version: e.version,
                                  reason:
                                    "Operator reviewed this synthetic record and frozen ledger snapshot",
                                })
                              }
                            >
                              Resolve {e.bank_id}
                            </button>
                          </div>
                          <small className="muted">
                            Row version {e.version}. Every successful review
                            appends an audit event.
                          </small>
                        </article>
                      );
                    })}
                  </section>
                </>
              )}
              {tab === "Data health" && (
                <>
                  <div className="grid">
                    <section className="panel">
                      <h2>Descriptor enrichment</h2>
                      <p className="muted">
                        A versioned synthetic merchant catalog. Similarity is a
                        string score, not a calibrated probability; ambiguous
                        names remain unknown.
                      </p>
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void action<Enriched>("/api/enrich", {
                            descriptor,
                            catalog_version: state?.catalogs[0]?.version,
                          }).then((r) => r && setEnriched(r));
                        }}
                      >
                        <label>
                          Payment descriptor
                          <input
                            value={descriptor}
                            onChange={(e) => setDescriptor(e.target.value)}
                            maxLength={256}
                            required
                          />
                        </label>
                        <button disabled={busy || !state?.catalogs.length}>
                          Enrich descriptor
                        </button>
                      </form>
                      {enriched && (
                        <div className="enrichment result">
                          <h3>{enriched.name ?? "Unknown merchant"}</h3>
                          <p>
                            {enriched.category} · {enriched.method} · similarity{" "}
                            {enriched.similarity.toFixed(3)}
                          </p>
                          <code>
                            Catalog {enriched.catalog_version.slice(0, 18)}…
                          </code>
                          <p className="muted">
                            This process cache: {enriched.cache.hits} hits /{" "}
                            {enriched.cache.misses} misses /{" "}
                            {enriched.cache.size} entries
                          </p>
                        </div>
                      )}
                    </section>
                    <section className="panel">
                      <h2>Source freshness</h2>
                      <p className="muted">
                        The source event clock drives freshness. A recent
                        ingestion timestamp or future point cannot conceal old
                        data.
                      </p>
                      {feed.map((f) => (
                        <article className="feed" key={f.source}>
                          <div className="section-title">
                            <h3>{f.source}</h3>
                            <span
                              className={"pill " + (f.healthy ? "" : "warning")}
                            >
                              {f.healthy ? "Healthy" : "Review"}
                            </span>
                          </div>
                          <p className="muted">
                            {f.points} stored points · source age{" "}
                            {f.age_ms === null
                              ? "unknown"
                              : (f.age_ms / 1000).toFixed(0) + "s"}{" "}
                            · budget {(f.budget_ms / 1000).toFixed(0)}s
                          </p>
                          <div className="alerts">
                            {f.alerts.map((a, i) => (
                              <span className="pill warning" key={i}>
                                {a.kind.replaceAll("_", " ")}
                                {a.id ? " / " + a.id : ""}
                              </span>
                            ))}
                          </div>
                        </article>
                      ))}
                    </section>
                  </div>
                </>
              )}
              {tab === "Audit trail" && (
                <section className="panel">
                  <div className="section-title">
                    <h2>Committed audit events</h2>
                    <span className="pill neutral">
                      Append-only runtime permissions
                    </span>
                  </div>
                  <p className="muted">
                    Journal posts, decision snapshots and reviewed exceptions
                    persist with their transaction. Latest stored events are
                    shown below.
                  </p>
                  <div className="timeline">
                    {state?.audit.map((a) => (
                      <article key={a.id}>
                        <time>
                          {new Date(a.created_at).toLocaleTimeString()}
                        </time>
                        <div>
                          <h3>{a.kind.replaceAll("_", " ")}</h3>
                          <pre>{JSON.stringify(a.body, null, 2)}</pre>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
          <footer>
            <span>All records and policies are synthetic.</span>
            <code>
              {trace
                ? "Last action trace: " + trace
                : "Request traces are API-local."}
            </code>
          </footer>
        </main>
      </div>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
