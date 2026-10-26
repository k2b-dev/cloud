### Editor formatting lost at an output boundary

- **What happened:** Shared Markdown widgets depend on classes or calculate formulas before email sanitization, so outgoing HTML loses formatting or replaces source text.
- **Root cause:** Editor formatting lost at an output boundary.
- **Error class:** Editor formatting lost at an output boundary
- **Guard:** Tests: Mail `compose-renderer.test.ts` checks final HTML and text for rules, strike, alignment, literal formulas, signatures and custom CSS; MIME tests cover fallback and pre-rendered output. Cloud `table-rendering.test.ts` and Notebooks `book-renderer.test.ts` keep default formula results after email rendering.
