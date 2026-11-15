### ZIP missing from the chat composer file filter

- **What happened:** A bank export named with `.ZIP` was refused before upload.
- **Root cause:** The composer accept list omitted ZIP even though the conversation file store supports binary files and already recognizes ZIP extensions without case sensitivity.
- **Error class:** File chooser policy drifts from supported attachment storage.
- **Guard:** Composer adapter tests exercise the shared MIME matcher with both ZIP suffixes and MIME spellings, preserve rejection of executables, and pin the existing file size ceiling in German and English flows.
