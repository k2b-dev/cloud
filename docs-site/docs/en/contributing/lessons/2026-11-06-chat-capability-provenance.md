### Capability dispatch must carry message provenance

- **What happened:** The capability-to-Chat context adapter omitted the framework's message origin.
- **Root cause:** The adapter copied identity and locale but did not copy `context.via` into the shared message service.
- **Error class:** Lost context metadata at a service boundary.
- **Guard:** The Chat posting capability test verifies that dispatch forwards `via`, while the input schema refuses caller-supplied provenance.
