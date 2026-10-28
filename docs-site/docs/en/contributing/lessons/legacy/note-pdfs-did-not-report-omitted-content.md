### Note PDFs did not report omitted content

- **What happened:** Note PDFs replaced images, diagrams, and invalid blocks with labels, source, or notices without reporting the loss to the caller.
- **Root cause:** The renderer returned HTML and parser diagnostics but no report of rendering fallbacks.
- **Error class:** Unreported export loss.
- **Guard:** Notebooks renderer tests cover each fallback, omission order, and one block omission per diagnostic in English and German. Header tests check Unicode labels and the maximal prefix within 2048 bytes; service, API, and gateway tests check delivery.
