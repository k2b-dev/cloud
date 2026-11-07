### A chart discriminator stopped Code SDK generation

- **What happened:** Code SDK generation failed before checking a program after the main sync introduced calendar heatmaps.
- **Root cause:** The grid heatmap schema used an optional `z.undefined()` layout discriminator, which Zod cannot export to JSON Schema. Code generates its page and chart types through that export.
- **Error class:** A runtime schema accepts values but cannot cross a public schema export boundary.
- **Guard:** `packages/editor/src/charts.test.ts` exports the bounded chart schema, reads it back, and checks grid, calendar, and invalid layouts. The Code SDK compile test accepts both supported layouts and rejects unknown layouts, including the exported schema’s forbidden property. The one-time schedule tests also exercise SDK generation before analyzing source.
