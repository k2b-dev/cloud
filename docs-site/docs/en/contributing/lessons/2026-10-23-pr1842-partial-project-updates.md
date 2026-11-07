### Partial updates preserve absent fields

- **What happened:** A description-only Project update was rejected for a writer.
- **Root cause:** The partial update schema inherited creation defaults for omitted fields.
- **Error class:** Applying creation defaults to a partial update.
- **Guard:** Project route tests check the exact fields passed to the service, empty-update rejection, and explicit empty values. Token integration tests check that omitted fields remain unchanged.
