### An automation that creates its own chats read as missing one

- **What happened:** A personal automation that creates a chat with `ai.chat.create` and writes there showed "Diese
  Automation hat noch keinen Chat" on its page. It was listed under "Braucht dich", and its head turned red, even
  though its message had already arrived in the new chat.
- **Root cause:** The manifest records `chat.send` to the bound chat and to a chat chosen at run time with the same
  target (`id: null`). The page, attention and Waiting for you treated every such grant as use of the bound chat.
- **Error class:** A check by shape claims more than the data can tell: two meanings share one encoding, and the
  person is told something that is not sure.
- **Guard:** One rule, `codeUsesBoundChat` in `core/src/code/bound-chat.ts`, and its SQL form in `chat-binding.ts`
  decide bound-chat use for the page, attention and Waiting for you. `present.test.ts` and
  `chat-binding.integration.test.ts` cover a version that creates chats.
