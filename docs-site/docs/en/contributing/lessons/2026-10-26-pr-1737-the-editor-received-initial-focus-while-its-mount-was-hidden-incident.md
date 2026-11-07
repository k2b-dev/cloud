### The editor received initial focus while its mount was hidden

- **What happened:** A Notebook opened at the correct reading position but lacked its editable caret.
- **Root cause:** The shared controller became available before Solid removed the mount's hidden state, so the native focus call had no effect.
- **Error class:** Treating controller readiness as visible DOM readiness during hydration.
- **Guard:** Notebook initial focus runs after the visibility flush and preserves focus already inside the note. The existing scrolled-preview browser tests require the caret, and recovery-surface tests protect an existing selection.
