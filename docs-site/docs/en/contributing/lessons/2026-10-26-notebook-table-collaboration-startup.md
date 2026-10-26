### Start table collaboration before structural edits

- **What happened:** Saved Notebook tables could not change their structure or column alignment until the person typed an unrelated text edit.
- **Root cause:** Lazy collaboration started only on document changes, while server table actions required completed replay. The pending-edit check equated startup with unsaved input.
- **Error class:** A replay-gated action could not initiate its prerequisite; connection state was mistaken for edited text.
- **Guard:** `sync-ended.behavior.test.tsx` mounts the real `NoteEditor` and checks disconnected reading, one connection on editable cell focus, structure availability only after replay, exact source preservation, navigation without a false unsaved prompt, first-edit rebase with provider undo, and readonly/session-ended protections.
