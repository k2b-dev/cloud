### A v2 menu choice could end in core's own memory

- **What happened:** In the Assistant's "Alle Chats" in WebKit, the click on the filter entry "Archiviert" landed and the menu closed, but the choice never reached the screen: the filter button kept "Alle Chats". It happened twice and could not be reproduced in 84 later runs (#4361).
- **Root cause:** ui-sdk core calls a radio group's own `onValueChange` only while it holds the group's props. Without them, at the moment of choice, it calls no group handler, keeps the value in its own memory and closes the menu all the same. `Section` heard choices only through the group's handler.
- **Error class:** A choice that falls into a primitive's internal memory without a signal, because the screen listened on one path only.
- **Guard:** `packages/ui/src/v2/menu-choice.browser.test.ts`, in Chromium and WebKit. It makes a group whose props are missing at the moment of choice: entries without their `RadioGroup`. The choice must still arrive through the menu's `onChoice`. As further guards it chooses at once after the menu opens 50 times, in the menus demo and in a dialog beside a search that reloads.
