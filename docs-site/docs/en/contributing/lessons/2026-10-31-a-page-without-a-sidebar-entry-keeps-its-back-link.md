### The Grids workflow overview had no sidebar entry, so it kept a redundant back link

- **What happened:** The workflow overview (`/app/grids/<base>/workflows`) showed "‹ Base" above its runs on desktop, although the sidebar's Overview item leads to the base. The back-link audit of 2026-10-31 found it as the one Grids page whose sidebar marked nothing.
- **Root cause:** The sidebar listed each workflow but had no entry for the overview of all workflows, so no item could carry `aria-current="page"`, and the shared head kept the title row with its way up.
- **Error class:** A page reachable in the app has no sidebar entry to mark, so the shell's chrome has to stand in for it.
- **Guard:** The Workflows section starts with "All workflows" (flat and curated sidebar) and `activeNavigationKey` marks it on the overview; `GridsSidebar.render.test.tsx` checks both sidebars mark it as the current page and a workflow on its own page.
