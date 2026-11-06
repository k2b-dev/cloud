### Test deadline expires before the asserted boundary

- **What happened:** A short timer fired during setup or an earlier request; a long aggregate case continued into later tests after its timeout.
- **Root cause:** Wall-clock timers included prerequisite I/O, while aggregate tests put several independent operations under one deadline.
- **Error class:** Test deadline expires before the asserted boundary.
- **Guard:** Tests: Files `cli-commands.test.ts` expires injected deadlines at the target request or body; `filegate-lifecycle.integration.test.ts` retains all forty files and simultaneous commit pairs in bounded cases. Activity history guards prepare real storage in hooks. `PermissionEditor.browser.test.ts` gives each width/name and last-manager comparison its own unchanged deadline. `cli-pack.test.ts` isolates each protected-input subprocess and prepares a real previous bundle in a hook before testing replacement. Convention: browser-transfer fixtures use explicit allowed origins for revision and range assertions.
