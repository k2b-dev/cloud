### Chat's panel ignored a place shared after it loaded

- **What happened:** When a person allowed Chat to read the page in the side panel, or the host page shared its place only after the panel had loaded, Chat stayed on the chat list instead of opening the discussion about that place.
- **Root cause:** The panel followed a place only while it already showed a resource discussion or had a follow in flight. A first place that arrived while the panel sat on its untouched start view counted as a change the person had navigated away from.
- **Error class:** A follower that treats a late first value like a later change and therefore ignores it.
- **Guard:** The panel also follows from its untouched start view (`atStart` in `panel-follow.ts`); `packages/chat/src/frontend/ChatPanel.browser.test.ts` shares a place only after the panel loaded and expects its discussion.
