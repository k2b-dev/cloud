### The thread picker stood at the far end of the Chat head

- **What happened:** On the dev instance the thread picker stood at the right edge of the Chat head, while the v12 design and the Chat tests put it right beside the chat's title.
- **Root cause:** `.chat-conversation__header > .k2b-page-title` ties in specificity with the shared `.k2b-ui .k2b-page-title { flex: 1 1 auto }`. Production links Cloud's global stylesheet after the app's, so the shared rule won; the Chat test fixture loaded them the other way round. The same tie pushed the count and chevron of the "Spaces und Notebooks" section out of place, so the section grew from one line to 40 px.
- **Error class:** A test fixture loads stylesheets in another order than production.
- **Guard:** The Chat fixture loads the stylesheets in production order, and `ChatThreads.browser.test.ts` measures the gap between the title text and the picker. The Chat rules for the head and the system-chat section are anchored at `.k2b-ui`; `ChatSystemChats.browser.test.ts` measures the section at one line. Mail fixtures: pending in [#1877](https://github.com/k2b-dev/cloud/issues/1877).
