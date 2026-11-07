### Saving an image must include the caller's write

- **What happened:** The old Tools editor did not track crop, adjustments, and annotations in one undo history or warn before leaving with unsaved edits.
- **Root cause:** Crop, adjustment state, and annotation-only history belonged to separate application paths. Export completion had no saved-entry identity shared with the caller.
- **Error class:** Partial transaction completion and split edit history.
- **Guard:** The public ImageEditor browser suite rejects a caller commit, edits while a commit is pending, undoes a slider gesture, changes the source during work, dismisses discard warnings, exercises phone pinch zoom, and retries a failed save. Dirty clears only for the captured entry after successful encoding and commit.
