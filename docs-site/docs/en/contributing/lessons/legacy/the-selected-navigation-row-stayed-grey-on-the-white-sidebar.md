### The selected navigation row stayed grey on the white sidebar

- **What happened:** After the workspace became one white surface ([#1468](https://github.com/k2b-dev/cloud/pull/1468)), the selected sidebar row and the selected stacked chip still looked grey.
- **Root cause:** The sidebar moved to `--k2b-surface`, but `app-color.ts` still mixed the navigation fill over the old muted background. The drift test checked the muted token's value, not the background the sidebar declares. The dark shell also borrowed the navigation fill for the open app, so moving the fill to the darker surface would have made that item disappear into the dark bar.
- **Error class:** A pinned color base drifts from the surface an element uses.
- **Guard:** `packages/cloud/src/ssr/app-color.test.ts` reads the sidebar's background declaration from @k2b/ui and checks its resolved base and hover in both themes. The shell's dark open item has its own fill, `shellSelected`, which `shell-gradient-contrast.test.ts` pins to its CSS declaration.
