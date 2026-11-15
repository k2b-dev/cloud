### Keep compose link recognition bounded

- **What happened:** Reviewing a message could spend too long recognizing unfinished anchors.
- **Root cause:** Repeated opening fragments caused the matcher to scan the same suffix repeatedly.
- **Error class:** Repeated suffix scans over message content.
- **Guard:** Compose safety tests bound the operation separately from process startup; anchor tests compare existing recognition on valid and malformed fragments.
