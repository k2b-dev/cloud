### Regenerate the showcase registry after merging example files

- **What happened:** Waterfall's generated showcase registry failed the repository's import-order check after a merge.
- **Root cause:** Conflict resolution inserted the new kind before the existing table entry instead of regenerating the sorted file.
- **Error class:** A manually resolved generated artifact diverges from its owning generator.
- **Guard:** Run `bun docs-site/src/ui/demo-sections/charts/examples/generate.ts` after registry conflicts, then check the generated file with Biome. The existing registry-source comparison and repository import-order check keep this deterministic.
