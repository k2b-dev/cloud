### Removal tests must retain one owner for each fixture lifecycle

- **What happened:** The no-Code sharing guard failed before reaching its request, activation passed its cases but failed during cleanup, and the version-card browser test waited for a removed target-manager message.
- **Root cause:** The sharing test combined a real identity preload with an app fixture that binds its own Sync. Activation dropped its private database in a suite hook before the imported session fixture's file-level cleanup. The browser fixture and assertions still described target planning after the card had switched to account rights and version approval.
- **Error class:** Test fixtures retain incompatible lifecycle owners or obsolete contracts after a removal.
- **Guard:** The sharing integration test uses its mocked authentication and app-owned Sync alone. Activation drops its database in the final file-level hook, after session cleanup. The browser preview fixture satisfies `CodeVersionPreview`, and panel/phone cases assert account or personal execution, approval and credential states, no target-manager UI, and no target-planning requests.
