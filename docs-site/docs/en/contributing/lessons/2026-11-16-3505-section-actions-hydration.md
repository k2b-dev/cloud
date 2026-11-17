### A section built its action twice during hydration

- **What happened:** Hydrating an ActivityCard with an "All N" button failed because the browser could not find the button's hydration key.
- **Root cause:** Section read its JSX `actions` getter to check whether the slot existed, then read it again to render it. The two reads built different buttons with different hydration keys.
- **Error class:** Evaluating a JSX slot more than once instead of resolving and reusing its children.
- **Guard:** Section resolves its actions with Solid's `children` helper. `packages/ui/src/content/activity-list-hydration.browser.test.ts` hydrates a card with the button, preserves the server's row nodes and text, and reports browser errors before waiting for readiness.
