# Reconcile by mutual evidence, then review

Context: greedy fuzzy matching can let input order decide which financial record wins. A confident-looking score can conceal competing candidates.

Options: greedy highest score, globally optimized assignment, or conservative mutual best candidates with an explicit ambiguity margin.

Decision: exact signed amount/currency and a date window narrow the candidates. Normalized string similarity ranks them. Automatic matches must be unambiguous from both bank and ledger directions. Batches freeze both sides. Manual review uses the expected exception version and unique ledger assignment, with transactional audit.

Tradeoffs: abstention lowers recall and exposes work in the queue. Manual review allows a date mismatch after inspection but still requires amount/currency compatibility and snapshot membership; a reviewer can be wrong. This is not a proof of true economic identity or calibrated match probability. The synthetic noise generator and its labels are retained; real banking generalization is not measured. More global optimization would need careful false-match evaluation before increasing automation.
