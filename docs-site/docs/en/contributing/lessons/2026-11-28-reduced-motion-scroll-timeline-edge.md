### Reduced motion froze the edge of a sticky column in view

- **What happened:** With reduced motion, from the system or from the host, every v2 table with a sticky column that could scroll sideways showed the grey edge at the sticky column all the time, also before any scroll.
- **Root cause:** The global reduced-motion rules in `base.css` and in the shipped `.k2b-ui` sheet set `animation-duration: 0s !important` on every element and pseudo-element. The edge is an animation on a scroll timeline (`animation-timeline: scroll(nearest inline)`, fill both). With a duration of 0s it stands at its end, so the edge was shown at scroll position 0.
- **Error class:** A global motion reset that zeroes the duration of every animation also breaks scroll-driven animations, which follow the person's own scroll and are no motion of their own.
- **Guard:** The reduced-motion rules set `animation-duration: auto` after the `0s` (`auto` is 0s for a timed animation and fills a scroll timeline); the motion contract test pins both values; `status-table.browser.test.ts` checks the sticky edge with full motion, reduced motion and motion reduced by the host, in Chromium and WebKit.
