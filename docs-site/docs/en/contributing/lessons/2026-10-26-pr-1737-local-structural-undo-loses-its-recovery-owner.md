### Local structural Undo loses its recovery owner

- **What happened:** Late input can arrive after the column author has undone the insertion and closed the editor. A browser-only undo filter cannot protect that write.
- **Root cause:** Local structural Undo loses its recovery owner.
- **Error class:** Local structural Undo loses its recovery owner
- **Guard:** Shared text stores structural provenance in the retained log, validates inverses and delayed ingress before acknowledgement, and preserves rejected input for recovery. Server regression tests cover closed-author input, alignment and appended rows after Undo/Redo.
