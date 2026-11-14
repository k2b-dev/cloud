### Keep unsaved sheet picks out of the field

- **What happened:** On a phone, a range date field showed the unsaved day of a dismissed calendar sheet for a moment after the sheet was gone. In WebKit the moment was long enough that the typing test failed now and then in the merge queue (#2986).
- **Root cause:** Picks in the sheet wrote the field's text, and the field restored it only after the sheet's promise resolved. A sheet with a history entry resolves only after its Back step settles, so the restore came after the dialog had closed.
- **Error class:** Undoing a side effect after an asynchronous close instead of not causing it.
- **Guard:** A pick in the sheet changes only the sheet's own state until it is saved; the dismissal has nothing to undo. The typing browser test now also asserts that the field stays empty while the sheet is still open, which fails in every engine if a pick reaches the field again.
