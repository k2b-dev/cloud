### Key figures in one row sat at different heights and cut their comparison

- **What happened:** On the showcase dashboards a tile without a change badge ("Lowest in 60 days") showed its figure lower than its neighbours, and at 390 px a tile with sparkline and comparison ended in "Last month …".
- **Root cause:** The figure row was pushed to the bottom with `margin-top: auto` and its content to the bottom (`justify-content: flex-end`), so a tile's figure moved with the height of its badge and support line; the support line was one fixed-height line with an ellipsis, shared by comparison and sparkline.
- **Error class:** Values in sibling tiles positioned relative to content that differs between siblings (bottom-anchored rows), and secondary text truncated with an ellipsis where it carries a value.
- **Guard:** `packages/ui/src/surfaces/stat-tiles.browser.test.ts` ("figures in a row share one line and the comparison is never cut") measures the figure tops across each grid row and every support text box in all three sizes at 390 and 1440 px.
