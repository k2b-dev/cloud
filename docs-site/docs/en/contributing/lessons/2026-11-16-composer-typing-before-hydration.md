### Text typed into the chat field before hydration was lost

- **What happened:** A person opened an empty Gustav chat by its address and typed the first message right away. Nothing was sent, and the chat stayed empty. A chat made with `cld assistant chats create` was also called "New chat" for a German person.
- **Root cause:** The server renders `ChatComposer`'s `<textarea>`, which takes typing before the island hydrates. Hydration adopted the element but never reported its text, so the owner's value stayed empty: Enter before hydration had no handler, and Enter after it sent nothing. The create route left an untitled chat to the store's English default title instead of the request locale.
- **Error class:** A server-rendered input whose hydration drops what the person typed meanwhile from the owner's state; a server default text that ignores the request locale.
- **Guard:** `ChatComposer` keeps a value typed before hydration and reports it to its owner; `packages/ui/src/chat/chat-composer-hydration.browser.test.ts` types into the server field before hydrating. `packages/cloud/src/ai/routes.integration.test.ts` creates an untitled chat in German and English.
