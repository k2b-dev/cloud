### A ScrollArea narrowed in Safari when its content started to scroll

- **What happened:** In Safari with a mouse, a plain `ScrollArea`, such as the Notebooks note or the help panel, drew the shared 0.5 rem scrollbar only once its content overflowed, so the text narrowed by 8 px at that moment. Chromium and Firefox kept the room from the start.
- **Root cause:** WebKit honours `scrollbar-gutter: stable` only after content overflows; before that it reserves nothing. Measured in Playwright's WebKit: a scroller with a styled scrollbar and `scrollbar-gutter: stable` has 0 px of scrollbar room until it overflows, then 8 px.
- **Error class:** A layout relies on `scrollbar-gutter` alone to keep content still, which WebKit does not provide before overflow.
- **Guard:** With a fine pointer, every shared scroller that exists to scroll uses `overflow-y: scroll`, so the track is there from the start, and owners take it from existing end padding (`layout-parity.css`, ScrollArea guide). `packages/ui/src/styles/scrollbars.browser.test.ts` grows the real surfaces, a plain `ScrollArea` included, from fitting to overflowing content in Chromium and WebKit and requires unchanged content boxes.
