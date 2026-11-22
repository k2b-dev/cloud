### A message sent right after Quote showed nothing until the quote's code had loaded

- **What happened:** Since the fix for #3702, a send right after "Quote" waited for the quote's code before it created the pending message row. The field was already empty, and nothing showed until the chunk arrived: about 800 ms in a probe, seconds on a slow network, so the message looked lost (#3999).
- **Root cause:** `send` in `packages/chat/src/frontend/ChatWorkspace.island.tsx` awaited `quotesOnTheWay` before it called `outbox.send`, so the visible row and the post waited together.
- **Error class:** An await that only the network request needs sits in front of the optimistic UI, so the first visible feedback waits for unrelated work.
- **Guard:** `packages/chat/src/frontend/ChatQuotes.browser.test.ts` holds back the `chat-quote-selection` chunk, sends right after Quote, and checks that the pending row shows before the chunk is released and before anything is posted. `chat-sends.test.ts` checks that a held send holds back the next one and posts with its quotes on `release`.
