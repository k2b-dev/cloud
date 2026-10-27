### A clean merge leaves imports out of order

- **What happened:** The large-notebook PR's CI check rejected two import blocks after independent changes merged successfully.
- **Root cause:** Preserving both branches' imports does not preserve the formatter's ordering contract.
- **Error class:** Conflict resolution preserves syntax but misses repository formatting
- **Guard:** Run Biome on the affected Notebook API and page-data files after merging; the existing repository `biome` check rejects import-order drift. The correction only reorders imports and preserves every binding.
