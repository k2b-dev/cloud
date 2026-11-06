### Option lists in narrow fields wrapped people's names

- **What happened:** The assignee picker in Mail's details panel opened as narrow as its property-row field, so names broke onto two lines and their second line was hard to read.
- **Root cause:** `placeChoicePopover` gave every choice popover exactly its trigger's width, while menus already sized to their entries.
- **Error class:** Two overlay primitives with different width rules: a rule that is right for wide form fields fails for compact triggers.
- **Guard:** `menu-width.browser.test.ts` opens a narrow assignee picker on desktop and phone and requires every name on one line, the list inside the viewport, and an unchanged width while filtering.
