# Project-specific interface: The Tally Journal

Status: accepted. Publication authorized on 2026-10-22.

## Context

The existing portfolio consoles shared a generic dashboard vocabulary. This made unrelated engineering problems look alike and hid the project’s primary object. The user explicitly authorized a visual redesign of the five kept projects.

## Decision

A warm paper ledger, Georgia serif chapter headings, a bookkeeper’s index, ruled tables and restrained red annotations. The public page is arranged as an engineering journal, with a masthead, margin note and invariant entries.

Research reference: [Financial Times Visual Vocabulary](https://github.com/Financial-Times/chart-doctor/tree/main/visual-vocabulary). Choose a visual form that makes the underlying quantity or relationship explicit.

Balances, journal sequences and decision outcomes still come from Postgres-backed API state. The matching bar uses actual saved matched/exception proportions. No decorative finance charts or invented money movements.

## Consequences

Maintain an independent visual vocabulary for this project; do not extract a shared cross-repository dashboard template. Preserve action names and API behavior so existing integration flows remain meaningful. Keep measured evidence and explicit hosting limits visible on the public page. Use system fonts and original code-native diagrams to keep the runtime self-contained. Save browser proof separately from the original benchmarks.

See [UI design and verification](../UI.md).
