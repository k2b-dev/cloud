### Replacing a disclosure drops keyboard focus

- **What happened:** Expanding or collapsing older history removes the activated control and leaves its state unannounced.
- **Root cause:** Replacing a disclosure drops keyboard focus.
- **Error class:** Replacing a disclosure drops keyboard focus.
- **Guard:** Test: Files `History.browser.test.ts` uses real Tab, Enter, and Space interactions in German and English and checks focus continuity, `aria-expanded`, and the controlled list. Paging and retry tests also check focus after the last page, including the fallback to the list. Item history keeps one disclosure button mounted while older rows exist.
