### Waiting-list cursors repeated a row with a precise database timestamp

- **What happened:** Paging through two waiting sends could return the first send again.
- **Root cause:** The cursor converted the requested timestamp through a JavaScript Date, losing PostgreSQL microseconds before comparing the next page.
- **Error class:** Lossy conversion of a sort key at a pagination boundary.
- **Guard:** The waiting-send integration test pages through fixed timestamps containing microseconds and requires each send exactly once.
