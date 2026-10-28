### The thread picker stood at the far end of the Chat head

- **What happened:** On the dev instance the thread picker stood at the right edge of the Chat head, while the v12 design and the Chat tests put it right beside the chat's title.
- **Root cause:** `.chat-conversation__header > .k2b-page-title` ties in specificity with the shared `.k2b-ui .k2b-page-title { flex: 1 1 auto }`. Production links Cloud's global stylesheet after the app's, so the shared rule won; the Chat test fixture loaded them the other way round.
- **Error class:** A test fixture loads stylesheets in another order than production.
- **Guard:** The Chat fixture loads the stylesheets in production order, and `ChatThreads.browser.test.ts` measures the gap between the title text and the picker. The Chat rule is anchored at `.k2b-ui`. Mail fixtures: pending in [#1877](https://github.com/k2b-dev/cloud/issues/1877).
