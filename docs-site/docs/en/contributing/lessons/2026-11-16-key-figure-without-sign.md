### Key figures from a code run had no sign before their name

- **What happened:** Gustav's three key figures "Offene Aufgaben", "Diese Woche fällig" and "Ohne Fälligkeit" stood without the small sign that v12 requires before every key figure's name.
- **Root cause:** Only the card and the stat chart took an `icon`. A stats view saved by a code run had no field for it, a figure without one showed none, and the chat's own tiles for a view (`ai/chat/stats-block.tsx`) never passed a sign on.
- **Error class:** A required part of a shared look depended on every writer remembering to send it.
- **Guard:** A stats view item takes an optional Tabler `icon`, and every key figure Gustav draws gets its sign through one function (`ai/figure-sign.ts`): its own icon, otherwise the same neutral sign. `view-block.test.ts` and `gustav-views.test.ts` check both cases for views, cards and stat charts; `view-block.browser.test.ts` finds the neutral sign in a loaded view without moving the tiles, and the key figure scene in `approval-scenes.browser.test.ts` shows it beside named signs.
