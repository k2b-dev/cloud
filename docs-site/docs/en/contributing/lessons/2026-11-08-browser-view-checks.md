### Keep server-side view checks out of browser islands

- **What happened:** The Assistant phone island grew past its bundle budget, and an approval card's first browser frame failed with `blocks_data_only`.
- **Root cause:** The shared capability contracts imported the strict block schemas and `bindView`, so every island that parses a capability result shipped them. The approval card bound its review view again in the browser, where the data guard met a reactive store's proxies.
- **Error class:** Server-only validation reaching the browser through a shared contract module.
- **Guard:** The contracts resolve view checks through the `#block-view-schema` package import: strict on servers, an envelope check in browsers. The approval card draws only views Cloud already bound (`boundBlocks`). The `island-bundles` rule fails when a browser closure grows past its measured budget.
