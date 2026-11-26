### A row's title grew without bound

- **What happened:** The Assistant on `@k2b/ui/v2` lists what it remembers as rows of one and two lines. A memory of a few hundred signs wrapped onto as many lines as it needed, so one row grew taller than the screen.
- **Root cause:** A row of three lines cut each line with "…", and the second line of a row of two was one line. The title of a row of one or two lines was free to wrap, because it is what the row is about, but nothing stopped it.
- **Error class:** A text that may wrap, with no upper bound, grows its box with its data.
- **Guard:** The title of a row of one or two lines stops after two lines with "…". A title longer than two lines can hold in the narrowest column (more than 60 signs) says all of it on hover; a short one has no hint, so a screen reader does not read it twice. `packages/ui/src/v2/worst-case.browser.test.ts` ("a long title of a row of one or two lines stops after two lines") checks this at 1440 and 390 px in Chromium and WebKit, together with the layout check.
