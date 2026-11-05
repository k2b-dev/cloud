### Reuse conversation date calculations and viewport snapshots

- **What happened:** Opening a conversation repeated timezone conversion for row times, accessibility labels, day separators and message groups. Phone viewport writes also separated repeated geometry reads.
- **Root cause:** Each consumer formatted the same timestamp independently, and the keyboard attribute was changed before reading the viewport offset and height again.
- **Error class:** Repeated formatting and interleaved geometry access during mount.
- **Guard:** The ChatWorkspace mount test counts one conversion per message; date tests count formatter construction, compare labels across midnight, DST and locales, and the viewport behavior test asserts reads precede writes. Existing Chat browser tests cover scroll positions and phone geometry.
