### Key figures from a code run had no sign before their name

- **What happened:** Gustav's three key figures "Offene Aufgaben", "Diese Woche fällig" and "Ohne Fälligkeit" stood without the small sign that v12 requires before every key figure's name.
- **Root cause:** Only the card and the stat chart took an `icon`. A stats view saved by a code run had no field for it, and a figure without one simply showed none.
- **Error class:** A required part of a shared look depended on every writer remembering to send it.
- **Guard:** A stats view item takes an optional Tabler `icon`, and every key figure Gustav draws gets its sign through one function (`ai/figure-sign.ts`): its own icon, otherwise the same neutral sign. `view-block.test.ts` and `gustav-views.test.ts` check both cases for views, cards and stat charts.
