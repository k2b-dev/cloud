### Chat stores quick messages out of order

- **What happened:** Two Chat messages sent right after each other could be stored and shown in a different order than they were typed ([#1145](https://github.com/k2b-dev/cloud/issues/1145)).
- **Root cause:** Chat posts each message as soon as it is sent, so the posts of one conversation run in parallel, and the server numbers them in the order they arrive.
- **Error class:** Ordering and concurrency.
- **Guard:** Test: Chat posts the sends of one conversation one at a time in submit order; a send that was not sent holds back the later ones until it is retried or discarded. `chat-sends.test.ts` fails when posts of one conversation overlap or change order, and `ChatWorkspace.behavior.test.tsx` covers retry and discard in the chat.
