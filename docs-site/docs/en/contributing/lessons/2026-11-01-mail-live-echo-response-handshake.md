### A delayed request must still receive its test response

- **What happened:** The Mail live-echo behavior test timed out in the merge queue while waiting for a pending draft save.
- **Root cause:** The test assigned its response callback only when the PUT reached the fixture. Native SHA-256 could still be running after the test flushed microtasks. Calling the optional callback then did nothing; the later PUT waited forever for the response the test had already tried to send.
- **Error class:** Lost test handshake across a native asynchronous boundary.
- **Guard:** The live-echo test deliberately gates the real hash, awaits the fixture's request-start signal, and resolves a response promise created before the request. It checks that an echo during the pending PUT keeps the editor editable and finishes with the complete saved text. Cleanup releases both gates. Assertions and the test timeout remain intact.
