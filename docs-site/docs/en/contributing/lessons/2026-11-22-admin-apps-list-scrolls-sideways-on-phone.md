### The admin apps list scrolled sideways on a phone

- **What happened:** At 390 px the list in Admin › Apps was 46 px wider than its column and scrolled sideways, although only name and state were shown.
- **Root cause:** The line under an app's name (its problem or address) was a truncating span whose full text still counted as the column's minimum width, and the state column had a fixed minimum of 144 px. The side columns were hidden by a viewport breakpoint instead of the table's own column priority.
- **Error class:** A truncating text that still sets its table column's minimum width, and a fixed column minimum, in a primary list.
- **Guard:** `admin/apps/page.browser.test.ts` (classic scrollbars, 390/768/1100/1440 px) checks that `.k2b-table-wrap` never scrolls sideways and that no state word is cut; version, address and problem have `priority: 3` and are checked in the row's details on a phone.
