### The workspace head spent a row on a title beside the overlay sidebar

- **What happened:** Between 48 and 64 rem of app width, every `AppWorkspace` page showed a 46 px row with only the sidebar button and the page title above the list's own toolbar. From 64 rem the same page had no such row, because the sidebar marks the page.
- **Root cause:** The overlay rules in `layout-parity.css` always showed the head for its button and brought the title back beside it, including on an app's root page. A page's own toolbar had no supported place for the button, so the head could never give up its row.
- **Error class:** A responsive range keeps chrome that the wider layout already dropped as redundant, because each range decides visibility on its own rules instead of the same reason.
- **Guard:** `packages/ui/src/layout/workspace-head-overlay.browser.test.ts` checks head height, button position, the accessible `h1`, and server-to-mounted parity at 390, 1,000, and 1,440 px.
