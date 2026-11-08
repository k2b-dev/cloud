### Photo intake must work outside a focused editing control

- **What happened:** Clipboard intake was attached to an inner container. Pasting while focus remained on the page body did not reach it.
- **Root cause:** A clipboard event bubbles through the focused element, not through neighboring photo controls.
- **Error class:** Event scope and lifecycle mismatch.
- **Guard:** The Tools photo editor browser suite pastes native and HEIF files through a document event and checks the converted photo can be downloaded. The listener ignores text editing and is removed on unmount. A separate mounted-editor guard retains two large sources, checks every retained canvas is bounded, and verifies removing one photo releases only its canvases before final unmount releases all of them. A failed unvisited preview ends ZIP with a visible error and preserves earlier captured edits; removing that photo allows the remaining result to be saved.
