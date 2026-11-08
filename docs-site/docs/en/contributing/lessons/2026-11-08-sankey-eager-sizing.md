### Reserve Sankey height without importing its drawing

- **What happened:** The lazy Chat guard found the Sankey renderer in the initial Chat module.
- **Root cause:** Notebook initial frame sizing imported the full Sankey layout. Chat also consumes that initial frame path. Re-exporting frame helpers through the drawing module additionally made Bun share the whole renderer with the eager entry.
- **Error class:** A lightweight sizing consumer importing a rendering implementation.
- **Guard:** Initial frame sizing now reads the shared pure Sankey frame calculation, exported directly from its sizing module. Existing tests assert its height equals the full layout, including dense graphs; the unchanged Chat bundle guard rejects eager Sankey drawing.
