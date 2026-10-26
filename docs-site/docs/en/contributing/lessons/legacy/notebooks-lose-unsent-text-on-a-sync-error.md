### Notebooks lose unsent text on a sync error

- **What happened:** When the note editor hit a fatal sync error, such as an expired session, it showed an alert and then reloaded the page. Edits that were not sent yet were lost ([#1144](https://github.com/k2b-dev/cloud/issues/1144)).
- **Root cause:** The fatal-error handler always reloads after the alert, also while unsent changes exist. The provider also did not track which sent edits the server had stored, so it could not tell whether a reload loses text.
- **Error class:** State lost on navigation or reload.
- **Guard:** The provider keeps each sent edit until the server echoes it, and a sync error never reloads by itself: the note stays on screen read-only with one recovery action, and Reload or leaving asks first while edits are unsent. `provider.test.ts` covers the pending state, and `sync-ended.behavior.test.tsx` checks every error code with and without unsent edits.
