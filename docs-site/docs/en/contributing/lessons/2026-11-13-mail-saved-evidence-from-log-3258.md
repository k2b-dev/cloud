### Count every retained broker state as saved evidence

- **What happened:** A shared Mail draft could show "Saving …" forever, even though the broker held all of its content. This happened after a reopen before the lazy snapshot, and after a reconnect that replayed peer input.
- **Root cause:** The client started its saved evidence from the SQL snapshot alone, although the authorized fresh state also contains the retained JetStream log. It also dropped cursor-bearing replay frames that arrived before replay-ready.
- **Error class:** Durability evidence taken from a slower store than the one that defines durability.
- **Guard:** `packages/mail/src/lib/draft-document-client-session.test.ts` covers four cases: a reopen before the snapshot, peer input replayed before replay-ready, an acknowledgement of older input that must not mark newer input as saved, and a same-generation offline journal that stays unsaved until its own acknowledgement.
