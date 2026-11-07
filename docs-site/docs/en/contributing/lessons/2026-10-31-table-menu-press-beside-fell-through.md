### A press beside an open table menu also acted on the content below

- **What happened:** With a table cell menu open, a click on another cell closed the menu and also focused that cell and moved the selection; a click on a column's cell marked the column. A row with a wrapped cell showed the focus outline only around one text line.
- **Root cause:** The menu relied on the native popover light dismiss, which closes the popover but still delivers the press to the element beneath it. Cells sized to their own text inside a top-aligned table cell, so a short cell never reached the row's height.
- **Error class:** An overlay that is dismissed by an outside press lets that press act on the content beneath it.
- **Guard:** `packages/ui/src/text-editor/text-editor-component.browser.test.ts` ("a press beside an open menu only closes it", "cells of a multi-line row share its height") in Chromium and WebKit; `Dropdown`'s `openAt` returns focus to the content the menu came from.
