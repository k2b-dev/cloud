### Keep cache and token representations deliberate

- **What happened:** Cached values and one-time link identifiers retained more information than their consumers needed.
- **Root cause:** Generic JSON caching included secret-kind settings, and link storage used bearer values as lookup keys.
- **Error class:** Sensitive values crossing a shared storage boundary without an explicit representation policy.
- **Guard:** Settings integration tests verify encrypted secret cache entries and idempotent startup cleanup. Local authentication and proxy-return tests verify hashed lookup keys, TTLs and single-use consumption. Settings startup tests require reconnecting before cleanup and propagate connection failures; gateway startup tests cover retrying temporary Valkey failures before reading settings.
