### A late Plex face narrowed the buttons of a head already shown

- **What happened:** The dashboard's head buttons got 11 px narrower once after the page appeared (S2, CLS 0.000025).
- **Root cause:** The `@k2b/ui` Plex preset kept Fontsource's `font-display: swap`. Cloud preloads the Latin Sans faces, but a preload does not hold the first frame. When a face arrived after it, the browser replaced the fallback on the page already shown, and every word changed its width.
- **Error class:** A web font that may swap in after the first frame lets the network decide the layout. The same words have one width before the font arrives and another after.
- **Guard:** `packages/ui/scripts/plex-fonts.ts` builds every Plex face with `font-display: optional` and fails the build when a face has another value. `packages/ui/src/fonts/plex-late.browser.test.ts` serves the built preset with Cloud's preloads. When the faces are held back past the first frame, no head button changes its width (±0.5 px). When they arrive in time, the buttons show Plex.
