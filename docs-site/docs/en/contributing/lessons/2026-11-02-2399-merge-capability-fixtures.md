### Keep capability fixtures aligned when merging target changes

- **What happened:** The integration sync failed its Spaces icon test, formatting check, and WebKit shard budget check.
- **Root cause:** An icon test from main still put `spaceId` in the strict input after Code moved the Space into `context.target`. The combined Assistant data load needed formatting. The combined browser selection exceeded the measured 900-second shard budget. New Pulse dashboard actions also lacked the targets required by Code. Mail’s Code page missed the new shared count-cache timeout and overload response.
- **Error class:** Independently valid branches can produce stale fixtures and invalid aggregate checks when merged.
- **Guard:** The Spaces icon test now explicitly rejects `spaceId` in input; Pulse dashboard tests cover strict input, target forwarding, and review scope; Biome checks the merged page, and the runner tests enforce exact suite coverage and the measured shard budget. A Code-page SSR regression requires the 40-second count wait budget, its timeout reset, and a no-store 503 response on count contention.
