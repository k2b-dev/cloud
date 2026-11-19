### Keep run presentation truthful when output is empty or space is narrow

- **What happened:** A completed run without output showed an empty scroll area. Phone run rows placed their result on another indented line.
- **Root cause:** The host opened output without checking for displayable entries. Generic phone row styles reserved an icon offset for runs without icons.
- **Error class:** Applying a component layout without adapting its empty state and narrow layout.
- **Guard:** CodePage render tests cover empty output in both languages. The CodeRunLog browser test checks empty output, compact run rows, full text wrapping and bounds at 390 and 1440 pixels.
