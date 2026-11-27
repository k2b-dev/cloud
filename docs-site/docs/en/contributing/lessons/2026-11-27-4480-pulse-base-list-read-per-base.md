### Listing Pulse bases read two statements per base

- **What happened:** A person with many Pulse bases caused two statements per base on every base list: on `GET /bases`, on the bases overview and in the sidebar of each base page. With 1,000 bases, that was about 2,000 statements per page load.
- **Root cause:** `listBases` and `listDeletingBases` mapped each row with `mapBase`. That function counted the base's members and read its store with a statement of its own. It was written for a single base and later used for lists.
- **Error class:** A mapper that reads the database for one item is used in a loop over a list (N+1).
- **Guard:** The list maps all rows with `mapBases`: one grouped statement for the member counts and one `ANY(ids)` statement for the stores. A single base uses the same path. `service/base-list-cost.integration.test.ts` lists one base and then five with `sql-meter` and requires the same statement count.
