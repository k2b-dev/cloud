### Preserve a command press when its row moves

- **What happened:** Selecting a chat command could silently do nothing when the layout moved between pressing and releasing the pointer.
- **Root cause:** Recovery handled replaced rows only. A connected row could move away from the pointer, sending the browser's click to a common ancestor without a command handler.
- **Error class:** Preserving DOM identity without preserving an active pointer gesture.
- **Guard:** The moved-command cases in `packages/ui/src/chat/chat-composer.browser.test.ts` shift a connected row during a press at desktop and phone widths. They assert exactly one activation at the original position and no activation after dragging outside it; existing cases cover rebuilt rows and delayed search results in Chromium and WebKit.
