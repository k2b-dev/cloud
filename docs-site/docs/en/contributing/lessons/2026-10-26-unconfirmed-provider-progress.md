### Unconfirmed provider progress

- **What happened:** A throttled FETCH ends with missing flag rows or a short body stream while the connection stays open. Advancing the cursor or storing the body makes incomplete work look complete.
- **Root cause:** The connector advanced progress without confirming missing flag rows or a short source stream.
- **Error class:** Unconfirmed provider progress
- **Guard:** Tests: real ImapFlow protocol fixtures in `packages/mail/src/service/connectors/imap-smtp.test.ts` cover empty and partial flag windows, failed confirmation, midstream throttling and an overstated size. Guard: confirm changed UIDs with MODSEQ SEARCH and short-source EOF with an empty literal at the next byte; otherwise retry with `ETHROTTLE` ([#1360](https://github.com/k2b-dev/cloud/issues/1360), [#1359](https://github.com/k2b-dev/cloud/issues/1359)).
