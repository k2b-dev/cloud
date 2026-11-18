### Mutation consumers checked a request before its result was applied

- **What happened:** After the stdlib upgrade, six PermissionEditor checks ran before controls or retry feedback settled, and the Kanban test started its next drag while the previous transfer was still running. Financial profiles also recorded the previous stdlib version.
- **Root cause:** Tests awaited the underlying transport promise or optimistic removal instead of the mutation's visible completion. The dependency upgrade omitted explicit renderer and validator stamps.
- **Error class:** Dependency upgrades leave consumer timing assumptions and provenance metadata stale.
- **Guard:** PermissionEditor tests wait for enabled controls and retry feedback; the Kanban test waits for transfer success before its next drag. The existing financial profile test compares every stdlib renderer and validator stamp with the installed version.
