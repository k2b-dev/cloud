### Confirmation disabled its own focus-return target

- **What happened:** Canceling an access-removal dialog sometimes left focus on the page instead of the Remove button ([#1767](https://github.com/k2b-dev/cloud/issues/1767)).
- **Root cause:** Mutation loading disabled the opener while awaiting confirmation; the dialog's focus-return frame could run before history cleanup resolved the callback.
- **Error class:** Confirmation and saving share a disabled state.
- **Guard:** PermissionEditor keeps its operation lock during confirmation but disables controls only for the write. Browser regressions hold confirmation across focus return and check that Cancel restores the exact opener without a write. Queued focus callbacks check disposal before reading the document.
