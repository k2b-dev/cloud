### Undo must continue the unchanged document lineage

- **What happened:** A shared Mail draft could reconnect after Undo and then immediately require recovery instead of accepting an edit. A larger two-node run failed although a small run passed.
- **Root cause:** Cancellation incremented the SQL document generation without replacing its Yjs content. The retained thaw marker still named the previous generation, so the room correctly rejected the mismatch. Prefix pruning sometimes removed that marker and hid the bug. Undo now preserves the generation; another send refreshes that generation's recovery receipt with its latest exact snapshot.
- **Error class:** Changing document identity for a lifecycle transition that does not replace content.
- **Guard:** `packages/mail/src/api/draft-document-socket.integration.test.ts`, “undo continues the same generation and admits an edit while the thaw marker is retained”, uses a real send, Undo, reconnect, edit and second send with native PostgreSQL and JetStream. It checks the continued generation and latest recovery receipt. The two-node load harness repeats Send → Undo → editing across nodes.
