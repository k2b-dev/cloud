### A reader presence test read a lease in the middle of fast note switches

- **What happened:** The merge queue failed on `ws-reader-presence.integration.test.ts`. After a reader sent three fast note switches, the test found the reader still present in the second note.
- **Root cause:** The server handles watch messages one after another and removes each lease before the next join. The test waited only until Bob saw the reader in the first note again. The first of the three switches already produces that state, so the test read the second note while its join was still running.
- **Error class:** State sampled before it settled: a test waits for a condition that an intermediate step already satisfies.
- **Guard:** The test now waits for the reader's own presence snapshots of all three switches, in order, before it reads the leases.
