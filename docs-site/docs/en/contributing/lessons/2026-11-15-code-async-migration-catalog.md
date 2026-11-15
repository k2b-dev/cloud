### Verify internal manifests and minimal migration dependencies

- **What happened:** The Code async change failed CI in Chat's command contract and unused Code database retention setup.
- **Root cause:** The Chat assertion listed the full registry Queries without its new generated manager projection. Activation triggers referenced a function installed only by the optional version-review migration.
- **Error class:** Stale complete-manifest expectation and an undeclared migration dependency.
- **Guard:** The eight Code-owner apps now assert that generated manager Queries carry `appOnly` and stay outside the person catalog. Chat still checks its complete registry manifest. The shared live trigger function belongs to the base Code migration; the unchanged retention integration fixture exercises activation without version-review tables. Run both consumer files alongside the affected capability tests.
