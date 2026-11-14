### Successful tool transport can conceal an unbounded repair loop

- **What happened:** A Code authoring turn made 43 chat model calls and consumed 2,482,633 reported input tokens. A second turn made 50 chat calls and consumed 3,344,483 input tokens.
- **Root cause:** Test failures returned `ok: false` inside completed tool results, so the transport-failure loop policy missed them. Large SDK results remained in every later request, while unpriced models and an unset tool-round limit supplied no token or step bound.
- **Error class:** Unbounded model work hidden behind successful transport and growing context.
- **Guard:** `code-authoring-turn.test.ts` checks the real executor with a failing stub model, repeated error identity across edited fixtures and recovery, batches, attempt and input admission bounds, and a pinned request-context ceiling using real authoring instructions, default and app tool schemas, memory, place, earlier turns, and Spaces SDK declarations. Recovery tests cover missing usage and unfinished call IDs; compaction shares the allowance without blocking later turns.
