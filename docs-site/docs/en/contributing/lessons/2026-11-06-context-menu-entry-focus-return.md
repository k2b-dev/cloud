### Choosing a context-menu entry dropped keyboard focus on the page body

- **What happened:** A keyboard user opened a Mail row's right-click menu with Shift+F10 and chose an entry with Enter. The menu closed and focus fell to the page body, so the next Tab started at the top of the page. Escape already returned focus to the row (#2228).
- **Root cause:** `ContextMenu` returned focus only on its Escape path. An entry closed the menu through the shared close path, which removed the focused menu without moving focus anywhere.
- **Error class:** Focus is restored on one close path of a popup but not on the others, so the focused element is removed with the popup.
- **Guard:** `context-menu.browser.test.ts` opens a menu with Shift+F10, chooses an entry with Enter and requires focus back on the element that opened it. The close path now restores focus whenever it sits in the menu.
