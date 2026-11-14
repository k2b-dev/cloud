### A chart discriminator stopped Code SDK generation

- **What happened:** Code SDK generation failed before checking a program after the main sync introduced calendar heatmaps.
- **Root cause:** The grid heatmap schema used an optional `z.undefined()` layout discriminator, which Zod cannot export to JSON Schema. Code generates its page and chart types through that export.
- **Error class:** A runtime schema accepts values but cannot cross a public schema export boundary. Replacing its discriminated unions with plain unions also hid field paths and unknown-kind diagnostics.
- **Guard:** `packages/editor/src/charts.test.ts` exports the bounded chart schema, reads it back, and checks grid, calendar, and invalid layouts. Discriminated unions remain in place; the grid layout uses an optional empty enum, which accepts only absence and exports as `never`. The schema tests check kind, layout, and nested field error paths. The Code SDK compile test accepts both supported layouts and rejects unknown layouts, including the exported schema’s forbidden property. The one-time schedule tests also exercise SDK generation before analyzing source.
