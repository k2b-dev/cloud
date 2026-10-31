### A CLI text edit stopped live editing in an open notebook

- **What happened:** A CLI edit followed by a concurrent browser edit could stop the editor's live session, leaving later CLI changes invisible until reopening.
- **Root cause:** Shared text server edits always recorded an ingress barrier. Admission therefore rejected browser input based on the preceding cursor even when both edits preserved the table structure.
- **Error class:** Overbroad conflict classification rejects mergeable concurrent edits.
- **Guard:** `packages/cloud/src/shared-text/documents.test.ts` checks concurrent ordinary edits and rejects changed table scaffolding. `packages/notebooks/src/api/live-note-edit.integration.test.ts` exercises the CLI's HTTP write route with the real WebSocket server and browser provider, delays delivery to reproduce the race, and verifies both edits reach the client and survive in the stored Markdown and Yjs snapshot.
