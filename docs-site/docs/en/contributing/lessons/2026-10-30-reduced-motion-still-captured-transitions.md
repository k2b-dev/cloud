### Reduced motion stopped the transition's animation but not its delay

- **What happened:** While analysing #2116, a Chat Info click in WebKit changed its address only inside the update of the view transition the click started, about 0.4 s later locally and 0.7 s with one CPU. Under `prefers-reduced-motion: reduce`, Cloud's CSS already removed that transition's animation, but `@k2b/ssr` still started the transition, so the navigation still waited for the browser to capture the old state.
- **Root cause:** `startViewTransition()` in `packages/ssr/src/nav-history.ts` checked only whether the browser has the API, not whether the person wants motion.
- **Error class:** An animation blocks a navigation: work done only for the animation runs, and delays the change, even when nothing animates.
- **Guard:** Under reduced motion, `startViewTransition()` runs the update directly. `packages/ssr/test/unit/nav.test.ts` checks that the browser API is not used then. The ssr README and the accessibility guide state the behaviour.
