### Extend the portable chart type with its validator

- **What happened:** New chart kinds and options passed their branch checks but failed merge-group and packed-consumer typechecks after the shared chart description landed.
- **Root cause:** The editor validator accepted descriptions absent from the UI-owned portable type union.
- **Error class:** A semantic merge conflict leaves the runtime validator and public TypeScript contract inconsistent.
- **Guard:** Extend `packages/ui/src/charts/description.ts` with every additive kind or option. Keep the editor’s bidirectional `ChartSchemaMatchesDescription` assertion strict, and verify the packed public-source consumer after merging the current base.
