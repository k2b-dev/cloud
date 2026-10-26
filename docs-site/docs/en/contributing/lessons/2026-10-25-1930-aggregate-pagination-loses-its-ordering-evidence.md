### Aggregate pagination loses its ordering evidence

- **What happened:** A network list sorts by its key instead of usage, or a period summary treats expired network identities as a complete count.
- **Root cause:** Aggregate pagination loses its ordering evidence.
- **Error class:** Aggregate pagination loses its ordering evidence.
- **Guard:** Tests: Files `service/activity-reader.integration.test.ts` covers combined-usage order and ties, fresh cursor aggregates, cursor expiry, bounded UTC timelines, totals before and after rollup, and page-view-only networks per bucket. `activity-transports.test.ts` requires nullable bucket `pageNetworks` and rejects private share fields and visitor details.
