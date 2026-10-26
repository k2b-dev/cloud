### Cloud links in PDFs opened local files

- **What happened:** Note, heading, tag, and attachment links in exported notes opened nonexistent local files ([#1365](https://github.com/k2b-dev/cloud/issues/1365)).
- **Root cause:** The renderer kept Cloud URLs relative, and Gotenberg resolved them against its local HTML file.
- **Error class:** Relative navigation URLs crossing from a web page into an offline document.
- **Guard:** Notebooks `note-pdf.integration.test.ts` inspects actual PDF URI annotations for the configured public origin and rejects `file://`; renderer tests preserve browser URLs, escaping, and internal anchors, and the API test checks the configured origin passed to export.
