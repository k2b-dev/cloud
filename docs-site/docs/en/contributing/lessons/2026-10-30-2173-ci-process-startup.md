### Test subprocesses must own their startup environment

- **What happened:** CI's host CLI import probe reported server modules, and Grids certification's concurrent query probe exited before exercising statement timeouts.
- **Root cause:** The host probe inherited test-service targets that made its preload initialize the server runtime. The Grids child depended on an inherited preload that certification did not propagate through `BUN_OPTIONS`, leaving its settings and pool reads without platform initialization.
- **Error class:** Test environment contamination and missing process initialization.
- **Guard:** `packages/cloud-cli/src/modules.test.ts` clears infrastructure targets while retaining its strict import assertion. `packages/grids/src/service/bounded-query.integration.test.ts` initializes its child explicitly through the reset-aware fixture before importing domain code, covering both direct and inherited-preload runs.
