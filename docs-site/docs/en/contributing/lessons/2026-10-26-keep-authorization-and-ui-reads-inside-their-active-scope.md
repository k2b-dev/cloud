### Keep authorization and UI reads inside their active scope

- **What happened:** Example staff authorization could wait for a second pool connection; a late passive poll could close a newly opened scanner.
- **Root cause:** Account reads escaped the supplied transaction, and opening the scanner left the previous read generation valid.
- **Error class:** Nested database reads escape a reserved transaction; a passive read outlives a newer view action.
- **Guard:** The account integration test uses a one-connection transaction with an uncommitted user. The browser test delivers a held poll after opening the scanner and requires the camera to remain open.

