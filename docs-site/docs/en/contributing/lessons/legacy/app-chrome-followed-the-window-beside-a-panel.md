### App chrome followed the window beside a panel

- **What happened:** With Cloud's panel column open, an app's workspace switched to the overlay sidebar while Chat, Grids, Notebooks, Mail, Venue, Tools, the overview columns, and shell focus still showed desktop chrome; shell focus hid the overlay navigation with no way back, and Notebooks offered full width where it had no effect ([#1382](https://github.com/k2b-dev/cloud/issues/1382)).
- **Root cause:** App and shell styles used viewport breakpoints at 64 rem, and Notebooks' full-width script used `matchMedia` and a rounded `clientWidth`, while the workspace measures its nearest `k2b-app-area` host. A dialog mounts outside that host, so a container query there still measures the window.
- **Error class:** Responsive decisions measured different containing areas.
- **Guard:** The `host-breakpoints` check rejects new viewport decisions for workspace chrome. The shared `app-host-width.browser.test.ts` checks fractional widths, host-only resize, container-name changes, and cleanup. The app-host comparisons, overview host test, Notebooks' full-width behavior test, and shell focus test cover the consuming surfaces.
