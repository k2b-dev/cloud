### A local file path changed between its question and its read

- **What happened:** `local_read`, `local_upload`, editor file links, terminal attachments, and AGENTS.md discovery checked a path, sometimes asked the person, and then opened the path again. A symlink, parent folder, or hard link changed in between made the call send cld's configuration, which is always refused. A hard link to the configuration was also not recognized under another name.
- **Root cause:** The check and the read each resolved the mutable path on their own, and the configuration rule compared names, not files.
- **Error class:** An authorization decision and the use it allows resolve a mutable name separately.
- **Guard:** `local-file.ts` records the checked file's identity before any question, opens only that file, and refuses cld's login files by identity. `local-tools.test.ts`, `acp.test.ts`, and `turn.test.ts` swap a symlink, parent folder, or hard link during the question, including from a background Bash child, and expect the checked file or a failure without the configuration.
