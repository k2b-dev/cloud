### Chat's panel showed the chat list before a late place's discussion

- **What happened:** After a person allowed Chat to read the page, the side panel showed the chat list for about half a second before it switched to the discussion about that page.
- **Root cause:** Following a place from the panel's start needs two reads: finding the place's discussion, then loading it. The panel kept its start, the chat list, on screen during both, although it was certain to leave it.
- **Error class:** A view that keeps showing a state it has already decided to leave, so the screen jumps once the decision lands.
- **Guard:** As soon as the panel follows from its start, it shows the discussion's loading frame (`followPending` in `ChatWorkspace.island.tsx`, set by `panel-follow.ts`). `packages/chat/src/frontend/ChatPanel.browser.test.ts` holds the place lookup back, with and without an existing chat, and counts every chat list the panel builds from the moment the place arrives: it must stay zero.
