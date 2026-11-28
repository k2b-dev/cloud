### The cells of a table in reading text ran together

- **What happened:** A Markdown table in v2 `Prose` (a tool's result, W8) had no space between its cells. In a column aligned right, "2" and "320,00 €" read as "2320,00 €". The head was in bold, outside the type steps, and the table did not keep to the text edge of the prose.
- **Root cause:** `v2.css` styled paragraphs, headings and lists in `Prose`, but not tables. The browser's default table drew the cells with 1 to 4 px between them and set the head in bold.
- **Error class:** An element that rendered Markdown can produce, but that no rule of the part styles.
- **Guard:** `.k2-prose` styles its tables like a small v2 table. The cells stand 12 px apart and flush with the text edge, the head uses the type of a Table head, and a hairline runs between rows. A column aligned right holds tabular figures. `measureV2Layout` treats lines inside reading text as part of the text, as it treats the track of a figure. `packages/ui/src/v2/prose-table.browser.test.ts` measures the gap between cells (at least 12 px), the edge, the head and the figures at 1440 and 390 px, in Chromium and WebKit.
