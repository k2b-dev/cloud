### A Studio app frame painted a light canvas behind a dark app

- **What happened:** A Studio app in a dark Cloud showed white strips when its scriptless sandbox wrapper exposed the canvas, for example while scrolling past the end (#1657).
- **Root cause:** The embedding iframe did not follow Cloud's selected color scheme, and the wrapper declared `color-scheme: light dark`. WebKit can choose light from that declaration even when the inherited media preference is dark.
- **Error class:** A transparent frame resolves its canvas color from a different color scheme than the app it embeds.
- **Guard:** Assistant `html/html-app.browser.test.ts` checks the selected scheme and exact exposed canvas pixels in Chromium and WebKit, including live theme changes with preserved input and scrolling.
