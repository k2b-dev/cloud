### The Mail list faded every time new mail arrived

- **What happened:** Whenever a live event, a poll, or an action refreshed the Mail workspace, the conversation list (and the Drafts list) faded to half opacity until the answer arrived. With steady incoming mail the column flickered, and Mail looked unstable.
- **Root cause:** `MailConversationList` and `MailDraftsView` set `opacity: 0.5` on the list while `loading` was true. The workspace's `routeLoading()` includes background refreshes, loading more pages, and opening a conversation, so the list faded for work that never replaced what it showed.
- **Error class:** A loading flag that covers background refreshes styles existing content as stale, so content the reader can still trust flickers on every update.
- **Guard:** `MailWorkspace.live.behavior.test.tsx` holds a refresh after a live event and checks that the list keeps its rows without opacity or filter; `MailConversationList.browser.test.ts` checks computed opacity, filter, and row positions at 1,440 and 390 px while the view refreshes.
