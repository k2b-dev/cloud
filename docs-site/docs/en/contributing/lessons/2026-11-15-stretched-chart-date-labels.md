### Dates on a stretched chart keep their size, so they need fewer places

- **What happened:** A line chart with weekly dates drew eight date labels over each other on a phone and in a third-width panel.
- **Root cause:** Charts are drawn once at their drawing width and CSS stretches them to their box while labels keep their pixel size. The number of date ticks came from the drawing width, never from the box.
- **Error class:** Text placed for a drawing size and shown at another size.
- **Guard:** Each date label names the box width it needs (`chart-tick-room.ts`) and CSS hides it below that width; `chart-frame-states.browser.test.ts` measures that no two visible dates of a stretched line overlap in a narrow box.
