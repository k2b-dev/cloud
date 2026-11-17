### Harden bounded run-output lifecycle

- **What happened:** Run output needed one consistent lifecycle across transport, lease and snapshot transitions.
- **Root cause:** Buffering, pacing and finalization were owned by different stages of the same stream.
- **Error class:** Incomplete lifecycle and budget ownership.
- **Guard:** Focused output-redaction, supervisor-output, native workerd, snapshot-position and Core integration tests cover bounded state and finalization. Route-entry witnesses and activation-preview tests preserve adjacent contracts; native transport tests check output separately from capability results. Structured-entry tests preserve stable identity and metadata and tolerate future step records. Continuity tests include output gaps, suppressed end candidates and overlapping deferred areas, deterministic transition counts pin linear matching work, and the public run reader covers queued retry snapshots. Resolved batch boundaries retain ordinary output after preceding transport gaps; the SQL-meter integration pins that output in replay and the final stored window.
