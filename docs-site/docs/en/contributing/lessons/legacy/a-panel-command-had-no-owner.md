### A panel command had no owner

- **What happened:** Duplicate in the Notebooks panel emitted an event without starting the copy flow.
- **Root cause:** The prompt, copy request, and navigation belonged to the note tree, while the panel had only an event name.
- **Error class:** A browser event without a mounted consumer.
- **Guard:** `duplicate-note.behavior.test.tsx` exercises the panel with no tree and with two trees, plus cancellation, errors, permissions, and listener cleanup. Both entry points use the same copy flow; only the panel handles its event.
