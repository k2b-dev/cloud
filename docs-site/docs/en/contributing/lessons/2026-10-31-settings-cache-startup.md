### Keep cache reads and startup on the same contract

- **What happened:** Settings startup and request reads used different Valkey clients, while warm secret reads repeated decryption.
- **Root cause:** Cache representation and startup cleanup were implemented independently of the platform connection snapshot. Recovery also skipped invalidation when an earlier database change had already committed.
- **Error class:** Divergent cache clients, repeated request-path work and lost post-commit invalidation during startup recovery.
- **Guard:** Focused tests cover ciphertext reuse and eviction, key binding, platform-client cleanup, format markers, post-commit invalidation after retries and restarts, bounded startup retries and warnings without values.
