### Preserve saved data when extending a chart layout

- **What happened:** Cloud 0.70 rejected saved bar charts with `layout: "rows"` and negative values that rendered in 0.69.
- **Root cause:** Adding ranked lists reused the existing rows layout and imposed its nonnegative constraint on every row chart. Both the portable schema and renderer rejected previously valid signed data.
- **Error class:** Tightened validation of an existing layout breaks stored data.
- **Guard:** New constraints on existing layouts must be opt-in or accompanied by a migration. Keep a frozen fixture from the previously accepted shape for each tightened layout. The 0.69 signed-rows fixture now passes core geometry, Solid SSR/client rendering, editor and model schemas, Chat parsing and Assistant app-frame rendering. Full SVG digests also preserve nonnegative ranked output.
