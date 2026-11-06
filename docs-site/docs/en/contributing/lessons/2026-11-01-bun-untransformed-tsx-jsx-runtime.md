### Bun 1.4.3 no longer loads a .tsx file without the Solid transform

- **What happened:** After the upgrade, the gateway bundle and image, `check:ui-catalog`, and 16 test files failed on missing `jsx`, `jsxs`, `jsxDEV`, and `Fragment` exports of `solid-js`.
- **Root cause:** Bun 1.4.2 compiled such a file to `React.createElement`, which only failed if it was called. Since Bun 1.4.3, `jsxImportSource: "solid-js"` links `solid-js/jsx-runtime`, whose module has none of these exports, as soon as the file loads.
- **Error class:** A build or test path that loads JSX without its transform and works only because nothing renders it.
- **Guard:** Such a path now fails when it loads. The gateway uses the real transform, the entries that need one install it, and `check-cloud-packed-consumer.ts` proves that a third-party build without the transform fails while the public server entries still import.
