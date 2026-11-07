### Keep additive contracts compatible with existing readers and fixtures

- **What happened:** App event changes broke future-manifest assertions, loaded event contracts during CLI host startup, and left account tests without the event outbox. A private configuration fixture also omitted the new FreeIPA default.
- **Root cause:** The future fixture used a newly supported field as unknown data; the CLI helper barrel re-exported an app module; isolated account fixtures did not run Core's events migration; configuration expectations predated `freeipa.autoCreate`.
- **Error class:** Additive contract changes invalidate compatibility assumptions and fixture dependencies.
- **Guard:** Manifest tests assert unknown-field filtering and absence of undeclared event fields with unchanged hashes. The CLI module-loading test excludes the events module from host startup. The POSIX fixture runs Core's events migration, and the private configuration test covers both FreeIPA auto-create values without echoing secrets.
