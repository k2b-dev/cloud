### A row's title grew without bound

- **What happened:** The Assistant on `@k2b/ui/v2` lists what it remembers as rows of one and two lines. A memory of a few hundred signs wrapped onto as many lines as it needed, so one row grew taller than the screen. In Chat, rows of two lines grew to 52, 68 and 84 px where a long last message or name wrapped, so one list had rows of many heights.
- **Root cause:** A row of three lines cut each line with "…". The title of a row of one or two lines was free to wrap, because it is what the row is about, but nothing stopped it. The second line of a row of two only got its cut with #4210.
- **Error class:** A text that may wrap, with no upper bound, grows its box with its data.
- **Guard:** Every row title has an upper bound of lines and the rows of a list one height per kind of row; `packages/ui/src/v2/worst-case.browser.test.ts` checks it in Chromium and WebKit:
  - In a list, each line of a row of two or three is one line with "…", and so is the title of a row of one on the desktop, so the rows of a list keep one height per kind of row (a Table's phone rows too); on the phone a row of one line in a list keeps room for two lines of title. A row with a deed (85 px on the phone) and a plain row (53 px) are two kinds and may share a list.
  - The title of a `Row` outside a `List` stops after two lines with "…"; the approved mockup shows such a step of a group with two lines of title.
  - A line that is cut says all of it on hover, measured while the pointer rests on it and set on the element it hits (the link that opens the row lies over its lines), and the hint leaves with the pointer. A whole line has no hint. Over the link it names, the cut title shows its words too, but its description points at an empty element, so a screen reader does not read the name twice.
  - The tests, each with the layout check:
    - "a long title of a row in a list is one line …" at 1440 and 390 px;
    - "rows of two lines keep one height …" at 1440, 1024, 390 and 320 px, on rows that open something, with the hint read from the element the pointer hits;
    - "a row's hint leaves with the pointer and never repeats the name of its link" with a real pointer at 1024 px, reading the accessible name and description while the hint is on;
    - "a row of three lines without a third one stands as high as the others" at 1440 and 390 px;
    - "a phone row of a large table keeps its long name on one line" at 390 px.
