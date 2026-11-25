### Charts in a v2 screen kept the v1 font, sizes and inks

- **What happened:** A `Chart` of `@k2b/ui` inside a v2 screen of Cloud drew its axis words in `ui-sans-serif` at 10 to 12.5 px with opacities instead of the v2 font, meta role (12/16) and inks; its tooltip used 11 px and the v1 shadow; donut slices had white separators on a dark page; and in a `Canvas` its legend started at 0 px instead of the v2 text edge.
- **Root cause:** The chart rules of `styles.css` read only `--k2b-*` tokens and the SVG's embedded default styles. Nothing mapped them to the `--k2-*` tokens when the chart stands below `.k2-ui`, and the separator stroke fell back to the embedded `white` in every theme.
- **Error class:** A shared component that two design layers render keeps the tokens of the layer it was built for; the newer layer never measures it.
- **Guard:** `packages/ui/src/content/charts-in-v2.browser.test.ts` measures a line, bar, donut, funnel and sparkline in a v2 `Section`/`Canvas` in light and dark at 1440 and 390 px: v2 font and meta size, v2 inks, the surface as separator, the text edge, the tooltip as a v2 overlay, and `measureV2Layout` without problems.
