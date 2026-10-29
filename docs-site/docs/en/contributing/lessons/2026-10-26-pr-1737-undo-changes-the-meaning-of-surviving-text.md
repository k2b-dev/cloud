### Undo changes the meaning of surviving text

- **What happened:** Restoring or deleting an ordinary character next to a delimiter can move another writer's input to a different cell, even when the original boundary characters survive.
- **Root cause:** Undo changes the meaning of surviving text.
- **Error class:** Undo changes the meaning of surviving text
- **Guard:** Tests: Cloud `shared-text-history-context-review.test.ts` and `shared-text-history-escape-review.test.ts` require preserved peer cell targets or an unchanged refusal; `shared-text-history-validation.test.ts` compares projected effects with native Yjs Undo/Redo.
