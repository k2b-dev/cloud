### Incomplete stored-state fixtures

- **What happened:** A direct SQL fixture omits one of the fields that domain writers persist together, creating a state that normal writes cannot produce.
- **Root cause:** Direct SQL fixtures omitted fields that the domain writer persists together.
- **Error class:** Incomplete stored-state fixtures
- **Guard:** Tests: `yjs-snapshot-projections.integration.test.ts` checks the persisted cursor and its matching sequence before publishing in both initialization cases, then asserts that the real snapshot save succeeds ([#1651](https://github.com/k2b-dev/cloud/pull/1651)). Mail's `draft-document-lifecycle.integration.test.ts` records an attempt before a possible provider effect; `draft-documents.integration.test.ts` links a reply to its source message and conversation before checking assignment changes. Keep SQL constraints enabled and construct the complete domain state.
