### Activity inputs omit localized presentation

- **What happened:** New activity Queries expose English field descriptions in a German capability form when their presentation catalog translates only the Query title.
- **Root cause:** The activity Query catalogs translated the capability name but omitted presentation labels for the new input schemas.
- **Error class:** Activity inputs omit localized presentation
- **Guard:** Test: `tests/capability-presentation.test.ts` requires every input field of each built-in capability to have German presentation. Include the activity filters, cursor, limit and Spaces time zone in their owning catalogs.
