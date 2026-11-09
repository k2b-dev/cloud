### Preserve file refusal statuses through AI adapters

- **What happened:** An owning app's file refusal with status 404 became 403 in the Code AI capability response.
- **Root cause:** Generation and decision adapters discarded the reader's 403/404 distinction. The reader also used the stream transport status instead of the bridge's error status for local refusals.
- **Error class:** Loss of error identity at a transport boundary.
- **Guard:** Capability regressions check both 403 and 404 through generation and decisions; SDK regressions check that `CodeError` retains distinct statuses. Signed bridge tests cover a deleted attachment's 404 and local size and single-use refusals.
