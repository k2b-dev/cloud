### Keep chart inspection independent of UI catalogues

- **What happened:** Area tooltip localization first pulled Solid into the framework-free entry. Extracting the catalogue removed Solid, but still grew the inspector to 19,566 bytes, above its 14 KB budget.
- **Root cause:** A single tooltip label imported the complete UI catalogue and its locale-resolution runtime into every inspector consumer.
- **Error class:** Unnecessary runtime dependencies crossing a portable package boundary.
- **Guard:** The renderer writes its localized total label into SVG inspection metadata. The inspector reads that text without importing a catalogue. The focused `packages/ui/src/chart-inspection.test.ts` checks the 17 KB budget for the published consumer bundle, alongside the JavaScript/declaration graph guard. The combined inspector is measured at the packed consumer’s single public export after each chart integration; the guard retains a small amount of headroom. The import graph also rejects indirect UI catalogue imports through the core barrel. Renderer and browser fixtures verify localized totals.
