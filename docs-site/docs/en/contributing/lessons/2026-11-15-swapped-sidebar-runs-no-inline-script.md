### A swapped page's workspace sidebar loses its current item and its stored offset

- **What happened:** After a page swap in an app with a workspace sidebar, the active item could sit outside the sidebar's visible area, and leaving the page no longer stored the sidebar's offset.
- **Root cause:** `AppWorkspace.SidebarBody` keeps the current item in view and stores the offset through an inline `<script>` beside the server markup; `@k2b/ssr/nav` inserts swapped columns without running inline scripts, and the first document's script only stores sidebars that are still connected.
- **Error class:** Server-rendered UI that relies on an inline script to behave correctly, under a navigation that inserts server HTML without running scripts.
- **Guard:** `installAppWorkspaceController()` runs `followSidebarScroll()` on every install, which hosts repeat after `ssr:nav-swapped`; `sidebar-scroll-follow.browser.test.ts` checks the current item in view, the unchanged page scroll and the stored offset.
