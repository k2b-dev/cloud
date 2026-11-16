### Contacts and Grids places went missing from Chat's discussions

- **What happened:** On the preview, Chat's discussion list said that some places could not be loaded, and address books and bases never appeared, because the queries `book.containers` and `base.containers` were skipped.
- **Root cause:** Both queries returned their continuation cursor only as `data.next` and no `page`. A stricter capability rule on the next branch rejects a paginated Query whose `page` does not match its continuation cursor, so the discussion reader dropped both providers.
- **Error class:** A paginated capability result that carries its cursor in the payload but not in the platform page.
- **Guard:** Both queries now return `capabilityPage(next)`, and `packages/contacts/src/capabilities.test.ts` and `packages/grids/src/discussion-capabilities.test.ts` assert that the page mirrors the cursor on the first and last page; the platform rule rejects any other provider that forgets it once it reaches `main`.
