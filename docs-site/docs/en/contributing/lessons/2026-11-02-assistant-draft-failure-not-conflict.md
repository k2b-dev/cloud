### A failed draft save showed a draft conflict in a new chat

- **What happened:** In a new Assistant chat with one typed line, a draft save that failed at the gateway showed the English error "Failed to save conversation draft" and, below it, a conflict notice with an empty saved draft and two choices.
- **Root cause:** The Assistant marked every failed draft save, send, and dictation insert as a revision conflict, although only a 409 means that the saved draft changed. The platform controller also set its English chat error for a real conflict, so the conflict appeared twice.
- **Error class:** A generic failure treated as a specific domain outcome, because the call answered only success or failure.
- **Guard:** The controller reports `draftSaveFailure(conversationId)` as `conflict` or `failed`, covered in `controller.behavior.test.ts`. `composer-app-commands.behavior.test.tsx` checks that a 502 on a new chat shows one localized error and no conflict, and that a 409 shows only the conflict notice.
