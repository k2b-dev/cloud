### Keep detailed line drawing out of static sparkline imports

- **What happened:** Merging funnels alongside detailed lines pushed both Assistant islands over their unchanged production bundle limits.
- **Root cause:** The production chunk graph placed the shared SVG renderer module in the static closure of small consumers such as sparklines. Keeping detailed line drawing in that module made the new drawing eager despite the lazy Chat boundary.
- **Error class:** Unrelated renderer functions share a module across static and dynamic import boundaries.
- **Guard:** The unchanged `island-bundles` rule fails when detailed drawing returns to the shared module. Moving the existing line function unchanged to `core/line.ts`, then re-exporting it from the established entry, restores both limits. Strict SVG parity, line browser tests and the unchanged Assistant prelude guard verify behavior and lazy loading. The ordinary line implementation remains unchanged in `line-base.ts`; no budget increases.
