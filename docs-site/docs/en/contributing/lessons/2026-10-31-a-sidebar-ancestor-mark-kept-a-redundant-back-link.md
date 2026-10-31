### A sidebar that marked a page's container still left a back link above the page

- **What happened:** On desktop, detail pages below a sidebar item (an Accounts user, group, or agent, a Capabilities entry, a Grids query with a source, a Notebooks tag) showed "‹ Parent" and the title above the work area, although the highlighted sidebar item already named the place and led back. Valentin asked on 2026-10-31 to drop top back links that are not the only way back.
- **Root cause:** The shared workspace head hid itself from 64 rem only for a sidebar item with `aria-current="page"`. `active="ancestor"` renders `aria-current="true"` and was documented to keep the back link, so every app with a deeper page got the row.
- **Error class:** A shared chrome rule repeats navigation that a visible, marked sidebar already offers.
- **Guard:** The head's 64 rem rule in `layout-parity.css` treats `aria-current="true"` like `"page"`, and `page-trail.browser.test.ts` checks that a deeper page with a marked ancestor shows no desktop back link, that the ancestor and Alt+Up lead back, and that a phone keeps its back arrow.
