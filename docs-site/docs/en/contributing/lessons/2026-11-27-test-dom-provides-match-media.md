### The shared test DOM had no matchMedia, so a v2 menu crashed in behavior tests

- **What happened:** Gustav's v2 frame has a menu in its head. Every behavior test that rendered it failed with "ReferenceError: matchMedia is not defined" (17 of 34 in three Assistant files). A v2 `Menu` and `Dialog` ask `matchMedia` whether the window is the phone on their first render (`usePhone`, `packages/ui/src/v2/overlays.tsx`), and the Happy DOM harness of the behavior tests set `window`, `document` and `getComputedStyle` as globals, but not `matchMedia`.
- **Root cause:** `packages/ui/test/dom.ts` gave the tests only part of the globals a browser always has. Tests in `@k2b/ui` that needed `matchMedia` set it by hand, so the gap showed only once an app's behavior test rendered a v2 menu.
- **Error class:** The shared test DOM lacks a browser global that a shared primitive reads while it renders.
- **Guard:** The harness provides `matchMedia` from its window, like `getComputedStyle`; `packages/ui/test/dom-harness.behavior.test.tsx` renders a v2 menu in the plain harness and checks that `matchMedia` follows the window's width, and it was red before the fix.
