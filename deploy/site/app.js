/* Finite project-context motion; no fake live progress. */
(()=>{
/** Finite, event-driven motion. No entrance timeline, polling, layout reads, or content delays. */
function installMotion(profile) {
    const preference = matchMedia('(prefers-reduced-motion: no-preference)');
    const running = new Set();
    const owned = new WeakMap();
    let observer;
    let events;
    let frame = 0;
    let interacted = false;
    const pending = new Map();
    const snapshots = new WeakMap();
    document.documentElement.dataset.motionProfile = profile.name;
    const play = (element, frames, duration) => {
        if (!preference.matches || !element.isConnected || document.hidden || typeof element.animate !== 'function')
            return;
        if (!(element instanceof HTMLElement) || element.matches('input,textarea,[contenteditable],.drag-handle,.note-body') || element.querySelector('input:focus,textarea:focus,[contenteditable]:focus'))
            return;
        // Stream updates never restart an in-flight effect; each owns at most one compositor animation.
        if (owned.get(element)?.playState === 'running')
            return;
        const animation = element.animate(frames, { duration, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', iterations: 1, fill: 'none' });
        owned.set(element, animation);
        running.add(animation);
        const clear = () => { running.delete(animation); if (owned.get(element) === animation)
            owned.delete(element); };
        animation.onfinish = clear;
        animation.oncancel = clear;
    };
    const flush = () => {
        frame = 0;
        for (const [rule, groups] of pending)
            for (const group of groups) {
                const targets = rule.targets === ':self' ? [group] : Array.from(group.querySelectorAll(rule.targets)).slice(0, 6);
                const history = snapshots.get(group) || new Map();
                const previous = history.get(rule) || [];
                const current = [];
                for (const [index, target] of targets.entries()) {
                    const signature = (group.getAttribute('class') || '') + '|' + group.hasAttribute('open') + '|' + (target.textContent || '').slice(0, 2048) + '|' + target.getAttribute('class') + '|' + target.getAttribute('aria-pressed') + '|' + target.getAttribute('aria-current');
                    current.push(signature);
                    if (previous[index] !== signature) {
                        if (interacted)
                            play(target, rule.frames, rule.duration);
                    }
                }
                history.set(rule, current);
                snapshots.set(group, history);
            }
        pending.clear();
    };
    const enqueue = (rule, group) => {
        if (!group)
            return;
        if (!pending.has(rule))
            pending.set(rule, new Set());
        const groups = pending.get(rule);
        if (groups.size < 4)
            groups.add(group);
        if (!frame)
            frame = requestAnimationFrame(flush);
    };
    const stop = () => {
        observer?.disconnect();
        events?.abort();
        if (frame)
            cancelAnimationFrame(frame);
        frame = 0;
        pending.clear();
        for (const animation of running)
            animation.cancel();
        running.clear();
    };
    const start = () => {
        stop();
        if (!preference.matches)
            return;
        events = new AbortController();
        const signal = events.signal;
        const press = (event) => {
            if (event instanceof KeyboardEvent && !['Enter', ' '].includes(event.key))
                return;
            const source = event.target instanceof Element ? event.target : null;
            const control = source?.closest('button,summary,a.button');
            if (!control || control.matches(':disabled,[aria-disabled="true"],.drag-handle,.note-body'))
                return;
            interacted = true;
            play(control, profile.press, 160);
            if (control.matches(profile.neighbors)) {
                for (const sibling of Array.from(control.parentElement?.children || []).filter(x => x !== control && x.matches(profile.neighbors)).slice(0, 2)) {
                    play(sibling, [{ transform: 'translateX(0) scaleX(1)' }, { transform: 'translateX(2px) scaleX(0.985)', offset: 0.28 }, { transform: 'translateX(0) scaleX(1)' }], 190);
                }
            }
        };
        // Animate only once click targeting is committed; shrinking a pressed hitbox can otherwise lose edge clicks.
        document.addEventListener('click', press, { capture: true, signal });
        document.addEventListener('keydown', press, { capture: true, signal });
        for (const event of ['click', 'change'])
            document.addEventListener(event, () => { interacted = true; }, { capture: true, signal });
        observer = new MutationObserver(records => {
            for (const record of records) {
                const source = record.target instanceof Element ? record.target : record.target.parentElement;
                if (!source)
                    continue;
                for (const rule of profile.rules) {
                    enqueue(rule, source.closest(rule.watch));
                    for (const added of Array.from(record.addedNodes).slice(0, 6))
                        if (added instanceof Element) {
                            enqueue(rule, added.matches(rule.watch) ? added : added.querySelector(rule.watch));
                        }
                }
            }
        });
        observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'aria-current', 'aria-pressed', 'open'] });
    };
    preference.addEventListener('change', () => preference.matches ? start() : stop());
    window.addEventListener('pagehide', stop, { once: true });
    window.addEventListener('pageshow', event => { if (event.persisted && preference.matches)
        start(); });
    start();
}
installMotion({
    "name": "tally",
    "press": [
        {
            "transform": "scaleX(0.97)"
        },
        {
            "transform": "scaleX(1)"
        }
    ],
    "neighbors": ".fault-tabs button,.instrument-keys button",
    "rules": [
        {
            "watch": ".fault-result",
            "targets": "strong,b",
            "frames": [
                {
                    "transform": "translateX(-5px)"
                },
                {
                    "transform": "translateX(0)"
                }
            ],
            "duration": 180
        },
        {
            "watch": "#accounts",
            "targets": "td:last-child",
            "frames": [
                {
                    "transform": "translateX(5px)"
                },
                {
                    "transform": "translateX(0)"
                }
            ],
            "duration": 180
        },
        {
            "watch": ".details",
            "targets": "summary",
            "frames": [
                {
                    "transform": "translateX(-5px)"
                },
                {
                    "transform": "translateX(0)"
                }
            ],
            "duration": 180
        }
    ]
});

})();
const proof = await fetch("/proof.json").then((r) => {
  if (!r.ok) throw Error("Evidence unavailable");
  return r.json();
});
const { ledger: l, decisions: d, reconciliation: r, recording } = proof;
const element = (tag, text, cls) => {
  const e = document.createElement(tag);
  e.textContent = text;
  if (cls) e.className = cls;
  return e;
};
const load = d.latencies.at(-1);
for (const [value, label, scope] of [
  [
    l.replay.events.toLocaleString(),
    "Journal events replayed",
    "Same balance digest after drift repair",
  ],
  [
    load.p99_ms.toFixed(3) + " ms",
    "Decision HTTP p99",
    `${load.count} requests · concurrency ${load.concurrency} · ${load.failures} failures`,
  ],
  [
    `${r.matches} / ${r.bank_records}`,
    "Bank records matched",
    `${r.false_matches} false matches · ${(r.recall * 100).toFixed(2)}% recall`,
  ],
]) {
  const card = element("article", "");
  card.append(
    element("strong", value),
    element("h3", label),
    element("p", scope, "muted"),
  );
  document.querySelector("#metrics").append(card);
}
const cases = {
  duplicates: {
    title: "One immutable identity, one event.",
    body: `${l.concurrent_replays} concurrent HTTP retries across separate API processes produced ${l.duplicate_event_ids} event identity. A changed payload returned HTTP ${l.conflicting_key_status}.`,
    evidence: {
      event_identities: l.duplicate_event_ids,
      concurrent_retries: l.concurrent_replays,
      changed_payload_status: l.conflicting_key_status,
    },
  },
  kill: {
    title: "Kill the process. Retry through the survivor.",
    body: "The harness observed a posting blocked on the database journal lock, killed its API process with SIGKILL, released the lock and retried the same key through another process.",
    evidence: l.kill_during_db_lock,
  },
  lost: {
    title: "The commit survives the missing acknowledgement.",
    body: "An actual HTTP proxy consumed the upstream response and closed the client connection. Retrying the same posting returned its committed event.",
    evidence: l.lost_response,
  },
  drift: {
    title: "Detect a changed balance. Rebuild the same view.",
    body: `The campaign changed a balance outside the application, detected drift in ${l.projection_fault.detected.join(", ")}, and repaired it to the original projection digest.`,
    evidence: l.projection_fault,
  },
};
function show(key) {
  const value = cases[key],
    container = document.querySelector("#fault");
  container.replaceChildren(
    element("h3", value.title),
    element("p", value.body),
    element("pre", JSON.stringify(value.evidence, null, 2)),
  );
  for (const b of document.querySelectorAll("[data-case]")) {
    const selected = b.dataset.case === key;
    b.setAttribute("aria-selected", String(selected));
    b.tabIndex = selected ? 0 : -1;
  }
  container.setAttribute("aria-labelledby", "fault-tab-" + key);
}
const faultTabs = [...document.querySelectorAll("[data-case]")];
document.querySelector("#fault").setAttribute("role", "tabpanel");
document.querySelector("#fault").tabIndex = 0;
for (const b of faultTabs) {
  b.id = "fault-tab-" + b.dataset.case;
  b.setAttribute("aria-controls", "fault");
  b.addEventListener("click", () => show(b.dataset.case));
  b.addEventListener("keydown", (event) => {
    const i = faultTabs.indexOf(b);
    const next = {
      ArrowRight: (i + 1) % faultTabs.length,
      ArrowLeft: (i + faultTabs.length - 1) % faultTabs.length,
      Home: 0,
      End: faultTabs.length - 1,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    show(faultTabs[next].dataset.case);
    faultTabs[next].focus();
  });
}
show("duplicates");
for (const row of d.latencies) {
  const tr = element("tr", "");
  for (const value of [
    row.concurrency,
    row.count,
    row.p99_ms.toFixed(3) + " ms",
    row.failures,
  ])
    tr.append(element("td", String(value)));
  document.querySelector("#latencies").append(tr);
}
document.querySelector("#decision-replay").textContent =
  `${d.replay.exact.toLocaleString()} of ${d.replay.decisions.toLocaleString()} stored decisions replayed exactly. SQL-stall response: HTTP ${d.deadline.status} in ${d.deadline.elapsed_ms.toFixed(3)} ms.`;
document.querySelector("#matching").textContent =
  `${(r.precision * 100).toFixed(2)}% precision and ${(r.recall * 100).toFixed(2)}% recall over ${r.true_pairs} labeled true pairs. ${r.exceptions} records remained exceptions.`;
const accepted = element("span", ""),
  exceptions = element("span", "", "exceptions");
accepted.style.width = (r.matches / r.bank_records) * 100 + "%";
exceptions.style.width = (r.exceptions / r.bank_records) * 100 + "%";
document.querySelector("#match-bar").append(accepted, exceptions);
document
  .querySelector("#match-legend")
  .append(
    element("strong", r.matches + " matched"),
    element("strong", r.exceptions + " exceptions"),
  );
document.querySelector("#recording").textContent =
  `Actual console recording: ${Number(recording.format.duration).toFixed(2)} seconds. Real NestJS API and Postgres operations on synthetic data.`;
