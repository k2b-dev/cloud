### A pointer left on a vanished notice faded in a tooltip while the page settled

- **What happened:** The Chat browser test for "Mark unread from here" failed now and then on a phone in `settled`: a tooltip kept fading in while the test waited for a still page before opening a message's menu.
- **Root cause:** The test had clicked "Undo" in a notice. The pointer stayed there after the notice left, so it now rested on the phone header's "Add people" button, whose tooltip fades in on hover. Whether the fade started before or during `settled` depended on timing.
- **Error class:** A test leaves the pointer where it last clicked, and content that later moves under it starts hover animations the test did not ask for.
- **Guard:** `openMessageMenu` in `packages/chat/src/frontend/ChatWorkspace.browser.test.ts` rests the pointer on the message's text with `hoverInPlace` before `settled`, for every message-menu step in the file. `settled` already reports `"hovered"` targets; a tooltip shows as its own element, so look for the control under the pointer.
