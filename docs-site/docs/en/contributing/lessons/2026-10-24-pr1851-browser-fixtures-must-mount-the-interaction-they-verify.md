### Browser fixtures must mount the interaction they verify

- **What happened:** The Grids execution-owner browser suite waited for a failed-read notice that never appeared.
- **Root cause:** Rendering an island directly through `createComponent` skipped the JSX import transform that emits its SSR wrapper. The browser found no wrapper to mount.
- **Error class:** A browser fixture bypasses the application's mounting contract.
- **Guard:** `machine-authority.browser-suite.ts` renders a plain page that imports the island through JSX and asserts the wrapper exists before exercising recovery. Certification runs the real identity fixture in its own phase so it owns its process Sync; isolated migration fixtures include the mandate foreign-key prerequisite.
