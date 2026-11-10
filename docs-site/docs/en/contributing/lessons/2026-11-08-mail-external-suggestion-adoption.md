### External draft edits must adopt suggestions too

- **What happened:** Another mail client's edit replaced a suggestion's content or attachments, but the draft still appeared untouched and accepted autonomous replacements.
- **Root cause:** The provider import path replaced the draft under its row lock without recording adoption. It already distinguished changed imports from identical-copy reconciliation.
- **Error class:** A transport-specific content mutation omits a domain invariant.
- **Guard:** `sent-projection.integration.test.ts` imports changed bodies and attachment-only edits, then verifies that an autonomous update with the current revision returns `DRAFT_ADOPTED`. Identical-copy reconciliation, identical external replacement, and export retries must leave adoption unset.
