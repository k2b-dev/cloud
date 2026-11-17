### Harden bounded run-output lifecycle

- **What happened:** Run output needed one consistent lifecycle across transport, lease and snapshot transitions.
- **Root cause:** Buffering, pacing and finalization were owned by different stages of the same stream.
- **Error class:** Incomplete lifecycle and budget ownership.
- **Guard:** Focused output-redaction, supervisor-output, native workerd, snapshot-position and Core integration tests cover bounded state and finalization. Route-entry witnesses and activation-preview tests preserve adjacent contracts; native transport tests check output separately from capability results.
