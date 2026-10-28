### Notebook requests scale with every page

- **What happened:** Paging after loading a notebook, scanning Markdown for lists, and reading siblings to append make small requests grow with notebook size.
- **Root cause:** Small operations loaded or scanned the whole notebook or sibling list before applying the requested limit.
- **Error class:** Notebook requests scale with every page
- **Guard:** Tests: Notebooks `large-notebook-server.integration.test.ts` checks the 13- and 20,000-page fixtures, actual query plans, slug parity and ordering. `export.test.ts` checks keyset batches, bounded blob reads and identical archive contents.
