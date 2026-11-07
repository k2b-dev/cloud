### Chart showcase icon tiles sat low-left, and block pages showed an empty TSX view

- **What happened:** The question headers of the chart showcase drew their icon at the bottom left of its tinted tile. The kind pages of blocks (budget, balance, flow, table) showed a TSX code view with its label and no code.
- **Root cause:** The tile was a page-owned `span` styled with `display: grid`; the header's rule for its description, `.ui-charts-group__header span { display: block; margin-top: … }`, also matched the tile and replaced its centring. The TSX generator returned an empty string for every block except key figures.
- **Error class:** A broad element selector in a host stylesheet overrides the layout of a nested component built from the same element; a code view generated per example has a silent empty branch.
- **Guard:** The tile is the shared `k2b-icon-tile`, and `packages/ui/src/styles/icon-tile.browser.test.ts` checks that every tile's glyph centre is within 1 px of the tile centre in light and dark, also under a host rule that styles spans. `docs-site/src/ui/demo-sections/charts/examples/registry.test.ts` requires non-empty TSX and JSON for every showcase example.
