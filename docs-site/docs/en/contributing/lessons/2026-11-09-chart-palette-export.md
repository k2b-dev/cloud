### A port's embedded palette can differ from its host stylesheet

- **What happened:** Standalone SVGs retained the old eight-color palette, including red as color four, while UI base.css defined violet in that position.
- **Root cause:** The drawing port preserved embedded CSS byte for byte. Host stylesheet tokens and embedded chart defaults had separate definitions.
- **Error class:** Portable output carries defaults that diverge from the host's visual contract.
- **Guard:** `charts/core/palette.test.ts` reads base.css and checks explicit palette conversion for every registered kind and all fourteen raw renderers. Existing SVG fixtures and snapshot digests remain unchanged; standalone exporters opt into `chartSvgWithUiPalette`. The chart-rendering rule rejects upstream drawing imports outside the temporary frozen Studio boundary.
