### Administration columns could not be resized

- **What happened:** The sidebar and the level columns in Core › Administration kept a fixed width, while the same `AppWorkspace` columns in every application can be dragged wider or narrower.
- **Root cause:** `AdminLayout` passed `resizable={false}` to its `AppWorkspace`, and `AdminSidebar` passed it to its sidebar. Both flags date from the first unified admin layout, before Cloud stored workspace widths per application in its cookie. The admin levels already declared `defaultSize`, `minSize`, and `maxSize`, but the flag disabled their handles.
- **Error class:** A shared layout that opted out of a platform default, so one product area behaved differently from the applications it hosts.
- **Guard:** `packages/cloud/src/ssr/Layout.render.test.tsx` renders an `AdminArea` and requires the sidebar's resize handle and a resizable first level. It fails with the flags in place.
