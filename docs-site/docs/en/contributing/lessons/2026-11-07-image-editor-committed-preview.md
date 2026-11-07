### Commit the photo preview with its edit

- **What happened:** WebKit sometimes showed the original pixel just after a redaction gesture finished, while history already contained the redaction.
- **Root cause:** Every preview update waited for an animation frame, including completed edits and Undo. A delayed frame left committed state ahead of the canvas.
- **Error class:** Deferred rendering after an interaction commits.
- **Guard:** The ImageEditor browser test withholds animation frames and requires an opaque black redaction immediately after pointer release, then the original pixel immediately after Undo. In-progress drafts still coalesce into animation frames; committed previews draw immediately.
