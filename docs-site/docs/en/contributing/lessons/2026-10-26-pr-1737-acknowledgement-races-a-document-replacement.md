### Acknowledgement races a document replacement

- **What happened:** A publication can be valid when submitted but belong to a retired document version when echoed to a browser.
- **Root cause:** Acknowledgement races a document replacement.
- **Error class:** Acknowledgement races a document replacement
- **Guard:** Tests: Notebooks `ws-lineage.test.ts` and `restore-ack.test.ts` verify authoritative delivery under the row lock and restoration against accepted live content; `yjs-snapshot.integration.test.ts` covers the real SQL-lock/NATS ordering.
