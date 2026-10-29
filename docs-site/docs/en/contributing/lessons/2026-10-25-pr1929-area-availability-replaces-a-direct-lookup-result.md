### Area availability replaces a direct lookup result

- **What happened:** A person with only POSIX areas receives an unavailable-area response for a direct activity lookup instead of the ordinary not-found result.
- **Root cause:** The area availability check ran before direct entry, batch and movement-chain lookups.
- **Error class:** An area-level availability check runs before every resource lookup.
- **Guard:** Files `service/activity-reader-filegate.integration.test.ts` checks area-history availability separately from direct entry, batch, and movement-chain lookups after a membership change.
