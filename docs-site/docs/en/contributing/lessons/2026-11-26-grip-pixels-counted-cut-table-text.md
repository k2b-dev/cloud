### A table cut at the line made the grip look off its line

- **What happened:** In Pulse (W5), a sources table wider than its list pane made `measureV2Layout` report the grip's pill 0.5 to 1 px off its line at DPR 1, in the run without the shell. The pill itself was painted on its line, pixel for pixel.
- **Root cause:** The screenshot check looked for the pill and the line in a window 3 px around the grip and took everything that differed from the background there. The table's content, cut at the column's line right beside the pill, became part of the pill and of the line.
- **Error class:** A pixel measurement that attributes neighbouring content to the element it measures.
- **Guard:** `measureV2Layout` finds the pill only inside the grip and takes the run of one colour nearest the grip's middle as the line. `measure-v2-layout.browser.test.ts` measures a grip beside an overflowing table at DPR 1 and 2, and `primitives.browser.test.ts` measures the `splitWideTable` fixture.
