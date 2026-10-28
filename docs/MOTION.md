# Double-entry registration

Profile: **tally**. Finite motion responds to actual control activation and changed data, not page entry, scrolling, fake progress or time-based reveals. The app never waits for animation completion. Each effect lasts 150–210ms with cubic-bezier(0.16, 1, 0.3, 1); only transform/opacity are permitted. Text remains present and selectable. Controls share a small physical key response; the project-specific data effects are:

- `.tablewrap` → `td.numeric`: 180ms, `[{"transform": "translateX(-5px)"}, {"transform": "translateX(0)"}]`.
- `.decision-replay` → `strong,.mono`: 180ms, `[{"transform": "translateX(5px)"}, {"transform": "translateX(0)"}]`.
- `.verification` → `:self`: 170ms, `[{"transform": "translateX(3px)"}, {"transform": "translateX(-0.6px)", "offset": 0.65}, {"transform": "translateX(0)"}]`.

Neighbor compression only applies to the listed related controls, never an entire page/card grid. Live editor and drag targets are excluded. Stream updates do not restart in-flight effects. A batched MutationObserver is bounded to four groups and six targets per rule; there are no layout measurements, animation loops, dependencies, request changes or global permanent will-change layers.

All animation creation is guarded by `prefers-reduced-motion: no-preference`; changing to reduce immediately disconnects the observer/listeners and cancels owned in-flight effects. CSS also disables legacy transitions/animation under reduce. Pagehide cleans up; persisted pageshow reinstalls. No keyboard events are prevented, no content is gated, and disabled controls are ignored.

Accessibility reference: [W3C SCR40](https://www.w3.org/WAI/WCAG21/Techniques/client-side-script/SCR40). A transform-only implementation reduces avoidable layout work; a locked 60/120fps is **not measured** and cannot be guaranteed on all devices. Browser proof records actual durations, keyframe properties, reduced-motion cancellation and immediate usability, not invented frame-rate numbers.

## Verification

`docs/results/motion/contract.json` exercises the shipped runtime on a synthetic DOM contract: durations/properties, zero entrance delay, unchanged polling snapshots, keyboard/pointer activation, live reduced-motion cancellation, and cleanup. `built-smoke.json` checks the actual built page at desktop/mobile widths. A static console preview deliberately has no backend and keeps unavailable actions disabled; it is not an end-to-end backend test.

The authenticated backend was not restarted for this UI-only change. The console connection/login surface and built frontend were checked; existing saved campaign results and guarantees were not remeasured.

The existing public evidence page is covered by `showcase-contract.json`, `showcase-built-smoke.json`, and its screenshots. It continues to show saved measurements, not a simulated live backend.

Button feedback begins when click targeting is committed, so the first press does not shrink a hitbox underneath the pointer. Editable/dragging surfaces are excluded. Backend APIs, ranking/math policies, measurements, and document source data were not changed.

## Separate CI dependency repair

The first motion commit passed application tests but CI found existing body-parser/multer security advisories. The affected Nest Express adapter was updated to 12.3.2 and body-parser's supported lockfile range was refreshed. No ledger policy or schema changed. A temporary isolated PostgreSQL run passed all 27 Node unit/integration/property tests, build/lint and npm audit with zero vulnerabilities. See `security-gates.log`, `security-fix.log`, and `caught-ci-security-failure.log`. This is a separate maintenance change, not a motion dependency.

References: https://github.com/advisories/GHSA-27r3-jxmh-p828 and https://github.com/advisories/GHSA-q7qp-rjg7-q26m .

Connected controls recoil only with their immediate previous/next matching siblings. The left sibling moves left, the right moves right; distant controls do not react. The runtime reads sibling references, not geometry.
