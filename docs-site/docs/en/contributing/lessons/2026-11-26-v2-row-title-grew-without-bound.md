### A row's title grew without bound

- **What happened:** The Assistant on `@k2b/ui/v2` lists what it remembers as rows of one and two lines. A memory of a few hundred signs wrapped onto as many lines as it needed, so one row grew taller than the screen. In Chat, rows of two lines grew to 52, 68 and 84 px where a long last message or name wrapped, so one list had rows of many heights.
- **Root cause:** A row of three lines cut each line with "…". The title of a row of one or two lines was free to wrap, because it is what the row is about, but nothing stopped it. The second line of a row of two only got its cut with #4210.
- **Error class:** A text that may wrap, with no upper bound, grows its box with its data.
- **Guard:**
  - A title stops after two lines with "…". A title longer than two lines can hold (more than 60 signs) says all of it on hover.
  - In a list, each line of a row of two or three is one line with "…", and so is the title of a row of one on the desktop, so every row of the list keeps one height (a Table's phone rows too). Its title says all of it on hover when it is longer than it can be beside a time (more than 20 signs). A row of two on its own, such as a step in a group, keeps two lines of title, as the approved mockup shows.
  - A short title has no hint, so a screen reader does not read it twice.
  - `packages/ui/src/v2/worst-case.browser.test.ts` checks this in Chromium and WebKit, together with the layout check:
    - "a long title of a row in a list is one line …" at 1440 and 390 px;
    - "rows of two lines keep one height …" at 1024, 390 and 320 px;
    - "a phone row of a large table keeps its long name on one line" at 390 px.
