### A v2 menu entry kept the locked state of its first render

- **What happened:** In W2, an entry of an open v2 `Menu` whose `disabled` followed a signal stayed as it was first drawn. A test that waited for it to turn locked timed out.
- **Root cause:** `menu.tsx` built an entry's props as `const keyed = { ...shared, … }`. A JavaScript object spread reads each getter of `shared` once and copies its value, so `disabled` and `data-danger` froze for every tick, link and plain entry. Only the submenu's button, which takes `{...shared}` as a JSX spread, stayed live.
- **Error class:** An object spread over an object of getters in a component turns reactive props into constants. It looks the same as a JSX spread, which keeps them.
- **Guard:** The props are joined with `mergeProps`, which keeps the getters. `packages/ui/src/v2/menus.browser.test.ts` locks and frees a tick while its menu is open, and checks `aria-disabled` and that a press on the locked entry runs nothing, in Chromium and WebKit.
