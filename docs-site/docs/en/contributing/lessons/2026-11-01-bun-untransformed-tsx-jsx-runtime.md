### Bun 1.4.3 links Solid's missing JSX runtime for an untransformed .tsx file

- **What happened:** After the upgrade, the gateway bundle and image, `check:ui-catalog`, and a notebooks bundle test failed on missing `jsx`, `jsxs`, `jsxDEV`, and `Fragment` exports of `solid-js`.
- **Root cause:** Bun 1.4.2 compiled a `.tsx` file loaded without the Solid transform to `React.createElement`, which only failed if it was called. Since Bun 1.4.3, `jsxImportSource: "solid-js"` links `solid-js/jsx-runtime`, whose module has none of these exports, as soon as the file is loaded.
- **Error class:** A runtime upgrade changes what a shared compiler setting means for every path that skips the plugin.
- **Guard:** The `solid-js` patch supplies these exports at the one place all such paths meet, and they throw when called, so an untransformed render still fails. The `bundles` job, the image builds, and `check:ui-catalog` cover the paths that load such files.
