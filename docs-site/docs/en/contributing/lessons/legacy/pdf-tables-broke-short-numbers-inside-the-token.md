### PDF tables broke short numbers inside the token

- **What happened:** Notebooks exports, Tools Markdown PDFs, and Assistant Markdown PDFs broke `Nr.`, `100`, and `110` across lines beside long descriptions. Using only `break-word` let a long plain token widen the table and clip the last column.
- **Root cause:** Every preset let cells inherit `overflow-wrap: anywhere`, reducing their min-content width to one character. Offline PDF rendering cannot run a script to detect an overflowing table.
- **Error class:** Break-anywhere lowers table column width.
- **Guard:** Cloud `markdown.test.ts` checks cell styles and override order in every document mode, plus entity-safe wrapping: words of up to 20 characters stay whole; a longer run gets a break opportunity every 10 characters. Cloud `markdown.integration.test.ts` covers whole short numbers, links, code, and visible final columns in all presets, including six long code/URL columns in the document preset. Notebooks `note-pdf.integration.test.ts` covers the Book renderer through Gotenberg; `note-pdf-tables.test.ts` checks that table image slots stay contiguous after preset wrapping and become image placeholders during preparation.
