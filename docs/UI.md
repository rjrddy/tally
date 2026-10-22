# The Tally Journal

## Direction

A warm paper ledger, Georgia serif chapter headings, a bookkeeper’s index, ruled tables and restrained red annotations. The public page is arranged as an engineering journal, with a masthead, margin note and invariant entries.

## Outside reference

[Financial Times Visual Vocabulary](https://github.com/Financial-Times/chart-doctor/tree/main/visual-vocabulary), inspected on 2026-10-22. Design takeaway: Choose a visual form that makes the underlying quantity or relationship explicit.

This is an original composition and stylesheet. No reference-site code, logos, photographs or proprietary fonts were imported. Fonts use local system stacks; diagrams are original SVG/CSS. No new runtime dependency or third-party request was added.

## Data and behavior

Balances, journal sequences and decision outcomes still come from Postgres-backed API state. The matching bar uses actual saved matched/exception proportions. No decorative finance charts or invented money movements.

API contracts, authorization, persistence, core algorithms and benchmark datasets were not changed. Existing benchmark outputs remain historical. UI verification and new recordings are saved separately under [docs/results/ui-redesign](results/ui-redesign/).

## Interaction and access

Buttons retain their existing actions and accessible labels. Keyboard focus is visible. Layouts collapse for narrow screens; wide evidence tables scroll inside their own containers. Color is paired with text for status. Motion respects prefers-reduced-motion.

## Review artifacts

- [Actual console](results/ui-redesign/console-desktop.png)
- [Mobile console](results/ui-redesign/console-mobile.png)
- [Browser flow results](results/ui-redesign/browser.json)
- [New console recording](results/ui-redesign/demo.webm)
- [Recording probe](results/ui-redesign/demo-probe.json)
- [Frontend build log](results/ui-redesign/frontend-build.log)

The saved [review-console.py](results/ui-redesign/review-console.py) is the existing real-service browser flow adapted to write into the UI review directory. Run it only against an isolated local demo stack with the normal operator environment configured. Historical performance is not rebenchmarked by this visual review.

Public evidence preview: [desktop](results/ui-redesign/site-desktop.png), [mobile](results/ui-redesign/site-mobile.png), [checks](results/ui-redesign/site-review.json). Publication is a separate approval step.

## Verification disposition

Final build, lint and existing test suites pass. The redesigned console was exercised against actual isolated local services, not mocked counters. The public-page previews use saved evidence and the new actual recording. The local proof was captured before publication. The repository CI workflow reports the currently pushed revision; README lists the public URL where available.

[The initial lint failure](results/ui-redesign/initial-lint-failure.log) caught a long line in the updated screenshot-check path. Formatting was corrected and the final lint/test gates passed.
