### The Grids workflow overview had no sidebar entry, so it kept a redundant back link

- **What happened:** The workflow overview (`/app/grids/<base>/workflows`), which exists only while a base has no workflow (otherwise it opens the first one), showed "‹ Base" above its runs on desktop, although the sidebar's Overview item leads to the base. The back-link audit of 2026-10-31 found it as the one Grids page whose sidebar marked nothing.
- **Root cause:** The sidebar listed each workflow but had no entry for the overview of all workflows, so no item could carry `aria-current="page"`, and the shared head kept the title row with its way up.
- **Error class:** A page reachable in the app has no sidebar entry to mark, so the shell's chrome has to stand in for it.
- **Guard:** On that overview the Workflows section shows a marked "All workflows" entry (flat and curated sidebar, via `activeNavigationKey`); with workflows there is no such entry, because the address would open the first workflow. `GridsSidebar.render.test.tsx` checks both sidebars on the empty overview and that a workflow's page marks the workflow.
