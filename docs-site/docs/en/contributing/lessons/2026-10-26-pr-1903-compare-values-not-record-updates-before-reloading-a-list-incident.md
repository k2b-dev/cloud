### Compare values, not record updates, before reloading a list

- **What happened:** reactive restart on an unchanged value. The Shared section in Chat info watched getters such as `current().id` and `seqHead`. Each update of the chat's record re-ran the effect with the same value, so the list emptied, read again, and replaced a failure with a quiet retry. In WebKit the reader then saw rows vanish and "Try again" detach. Solid's `on(…, { defer: true })` also never passes a previous value to its first run.
- **Root cause:** The reactive effect watched record getters that changed notifications without changing their value, and treated Solid’s first deferred callback as if it had a previous value.
- **Error class:** reactive restart on an unchanged value
- **Guard:** the section reads `chatId` and `revision` through `createMemo`, so only a new chat or a new position reloads. `ChatShared.browser.test.ts` checks that opening Info reads the list once and that a failure waits for "Try again".
