### New live keys have no discovery path

- **What happened:** Existing viewers cannot receive the first event on a key they do not yet follow or have permission cached for.
- **Root cause:** New live keys have no discovery path.
- **Error class:** New live keys have no discovery path
- **Guard:** Test: Chat `live.integration.test.ts` opens two viewers with warm container caches and no item decision, requires a metadata-free refresh hint, checks authorized HTTP discovery, renews the existing subscription at its hint cursor, and replays an event committed during discovery. Store tests require subscription renewal and sidebar/directory invalidation.
