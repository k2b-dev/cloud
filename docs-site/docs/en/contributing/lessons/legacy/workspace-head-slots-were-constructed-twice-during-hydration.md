### Workspace head slots were constructed twice during hydration

- **What happened:** Hydrating a workspace head with JSX view tabs failed with a hydration mismatch.
- **Root cause:** Presence checks and content read the same JSX prop getter separately, constructing elements twice.
- **Error class:** Repeated JSX slot construction.
- **Guard:** The head resolves each JSX slot with Solid's `children()`. Render tests count constructions; `workspace-head-hydration.browser.test.ts` checks real SSR hydration, stable geometry, unique head parts and an interactive More menu.
