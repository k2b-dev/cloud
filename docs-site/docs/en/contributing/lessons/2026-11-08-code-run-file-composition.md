### Keep SDK file composition complete through the one-off host

- **What happened:** One-off SDK streaming reads returned file metadata instead of a FileRef, so a file-input Action could not complete a read-to-write composition.
- **Root cause:** The one-off adapter returned only capability data and omitted stream adaptation and transfer.
- **Error class:** Adapter loses a declared result contract.
- **Guard:** `packages/assistant/src/chat-code/runner-code-host.test.ts` runs compiled SDK source through the Assistant host and isolated Runner fixture, checks exact transferred bytes and completed Action data, and checks that the worker bridge carries only metadata.
