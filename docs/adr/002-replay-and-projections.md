# Facts are immutable; balances are replaceable

Context: a mutable balance table can drift even when individual postings were correct. A replay can also be wrong if it sorts sequence values as strings.

Options: trust current balances, replay unchecked JSON, or verify the stored chain and reconstruct balances independently.

Decision: store exact request text and exact event text, bind the previous digest, verify IDs and numeric sequence ordering, and reconstruct with BigInt. Compare with the account projection under the same journal lock. Repair recomputes balances from posting lines in one transaction after the application verifies the facts. The initial two-digit sequence sorting failure is retained as a regression record.

Tradeoffs: the whole journal is replayed in memory; large-history streaming, snapshots and load isolation are unfinished. Account configuration is immutable reference data with creation audit; replay rebuilds monetary balances, not every administrative table. Hashes detect changes relative to trusted state, not a privileged rewrite of the entire database. No external notarization is claimed.
