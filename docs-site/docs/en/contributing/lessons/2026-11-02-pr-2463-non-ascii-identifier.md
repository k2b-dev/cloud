### A parser table broke every page in WebKit that loaded @k2b/ui

- **What happened:** WebKit browser tests of an unrelated tool timed out: its page never rendered, because the bundle stopped with `SyntaxError: Invalid character '¼'`.
- **Root cause:** The typed date parser kept its day words in an object whose key `übermorgen` the bundler printed as a bare identifier. WebKit read the script as Latin-1, so the `ü` became two characters, and the second one is not allowed in an identifier. Strings and regular expressions with the same letters only got garbled text and did not fail.
- **Error class:** A non-ASCII identifier or identifier-like object key in shipped code makes the whole script fail to parse when it is decoded with the wrong charset.
- **Guard:** The `ascii-identifiers` repository rule rejects non-ASCII identifiers and identifier-like object keys in `packages/*/src`.
