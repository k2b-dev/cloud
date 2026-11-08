### A version conflict needs a different save action

- **What happened:** The editor said to save a copy after a version conflict, but offered Try again and repeated the rejected overwrite.
- **Root cause:** The shared editor gave every failed commit the same retry action, although Files knew that the pinned revision could no longer be overwritten.
- **Error class:** Recovery repeats an operation whose precondition has permanently failed.
- **Guard:** Files browser tests require Save copy as the primary and error action after a version conflict, no Try again, and a successful independent copy. A temporary preflight failure must instead retry the original destination. Unknown uploads still reconcile their original key.
- **Fix:** The public editor accepts a caller-owned save-error action. Files switches to copies after a version conflict, or downloading when folder creation is forbidden; export failures keep their own recovery.
