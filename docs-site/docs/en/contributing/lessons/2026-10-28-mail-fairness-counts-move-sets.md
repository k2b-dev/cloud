### A Mail fairness test measured lease order in milliseconds

- **What happened:** The slow-move fairness test failed on an unrelated Mail pull request: the folder sync got its lease turn after 6,012 ms instead of under 5,000 ms, although only one move set ran before it.
- **Root cause:** The test bounded the sync's wait by wall time. With every move statement slowed and a loaded CI host, the one move set in progress took longer than the bound, while the lease order the test checks was correct.
- **Error class:** A fairness test bounds an ordering property by wall time, so host load fails it.
- **Guard:** The test counts the move sets that ran before the sync's first lease turn, as #1492 proposes for the backfill case; the set's time budget stays covered by its first set staying under 50 moves.
