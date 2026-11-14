### Reserve the change row before loading a stat value

- **What happened:** The Chat browser guard found a 28 px increase in the German desktop stats frame after its saved file loaded.
- **Root cause:** Loading tiles used short stand-in values. Loaded currency values and absolute change badges then shared the same row, where their formatted widths could wrap the value.
- **Error class:** Loading geometry depended on content that was not available in the presentation summary.
- **Guard:** Chat opts into a separate change row in both loading and loaded tiles. The existing strict desktop/phone and light/dark frame assertions remain unchanged. The new shared badge fixture also covers German formatting. Default StatCell placement, chart parity guards and budgets stay unchanged.
