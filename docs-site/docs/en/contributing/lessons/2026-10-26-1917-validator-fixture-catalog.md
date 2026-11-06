### A documentation fixture omits a required global catalog

- **What happened:** The lesson merge test reached validation but failed because its temporary site had no convention catalog.
- **Root cause:** The documentation validator checks global convention coverage even when the requested path selects only a lesson. The fixture supplied only that lesson's page.
- **Error class:** A focused fixture omits a required global invariant.
- **Guard:** `docs-site/scripts/lessons.test.ts` copies the canonical convention catalog into the temporary site before validation, checks its indexed page count, and still proves that a broken lesson link fails.
