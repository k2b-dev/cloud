### Keep first-use action code outside the initial Assistant PWA

- **What happened:** After Sync 62, the approval changes put the Assistant PWA 1,038 bytes above its unchanged production budget.
- **Root cause:** The initial closure included file upload code and preview-only approval messages, although neither is needed to render the authorized initial snapshot.
- **Error class:** Loading interaction-only code and copy with the first render.
- **Guard:** The unchanged `island-bundles` rule measures 2,443,196 bytes against 2,443,264 bytes after loading uploads on file selection and preview messages with the existing deferred proposal. The locale contract test covers both catalogs; existing PWA browser cases cover upload progress, retry, offline recovery, and archive undo in CI.
