### Keep integration clocks and schema dependencies aligned

- **What happened:** After the scheduling slice landed, three Code secret integration tests failed on a missing column. Two signed runner bridge tests failed when heartbeat renewed a lease and admission retired expired replay evidence.
- **Root cause:** The secret fixture omitted the scheduling migration now required by the shared fence. The bridge fixture froze JavaScript at a fixed calendar date while PostgreSQL used its live clock. Token expiry and stored leases therefore disagreed, and previously accepted proofs had already expired in the database.
- **Error class:** Integration fixtures use incomplete schema dependencies or inconsistent clocks across a real database boundary.
- **Guard:** The secret suite applies the scheduling migration. The signed bridge suite freezes JavaScript at a sampled database instant, asserts that heartbeat leaves a live lease bounded by token expiry, and checks that completion clears the lease. The existing replay and secret non-disclosure assertions remain in place.
