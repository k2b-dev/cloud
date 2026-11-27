### Ticks in a narrow cell hid their newest slots

- **What happened:** v2 `Ticks` drew a strip of a fixed 140 px. In a table column of 120 px, the strip ran past its cell, and the cell cut its end. The end holds the newest slots, the ones a person looks for first: the three failed scrapes of a printer did not show. With more slots than the strip holds, it also clipped at its end.
- **Root cause:** The strip took its width from a design number instead of its place. Its slots were spread with `justify-content: space-between`, which falls back to the start when the slots do not fit, so the overflow went to the end.
- **Error class:** A part with a fixed width in a container that can be narrower, and an overflow that hides the most important end.
- **Guard:** `.k2-ticks` is `min(140px, 100%)` wide and aligns its slots to the end, with the free room spread by auto margins between them, so a strip that does not fit clips its oldest slots. `packages/ui/src/v2/ticks-fit.browser.test.ts` renders a table with a 120 px Ticks column at 1440 and 390 px and in a page written right to left. It expects the strip between the cell's text edges, the newest slot whole at the strip's end, and all failed slots shown, for 30 and for 500 slots.
- **Known limits:** `Ticks stretch` still clips at its end when more slots come than its place holds at 1 px each.
