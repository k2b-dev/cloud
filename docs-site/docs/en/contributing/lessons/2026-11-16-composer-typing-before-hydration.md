### Text typed into the chat field before hydration was lost

- **What happened:** A person opened an empty Gustav chat by its address and typed the first message right away. The text vanished, nothing was sent, and the chat stayed empty. A chat made with `cld assistant chats create` was also called "New chat" for a German person.
- **Root cause:** The server renders `ChatComposer`'s `<textarea>`, which takes typing before the island hydrates; hydration then wrote the owner's empty `value` over it, and Enter before hydration had no handler. The create route left an untitled chat to the store's English placeholder instead of the request locale.
- **Error class:** A server-rendered input whose hydration replaces what the person typed meanwhile; a server default text that ignores the request locale.
- **Guard:** `ChatComposer` keeps a value typed before hydration and reports it to its owner; `packages/ui/src/chat/chat-composer-hydration.browser.test.ts` types into the server field before hydrating. `packages/cloud/src/ai/routes.integration.test.ts` creates an untitled chat in German and English.
