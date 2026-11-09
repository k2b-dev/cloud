### Lists inside an island are rows with hairlines, not grey tubs

- **What happened:** The audit for the layer model found grey, rounded boxes around the recent activity, passkey, API key, device, and AI run lists in Core. Inside the account island they formed a box inside a box.
- **Root cause:** Each list copied the same `rounded bg-[var(--ui-surface-subtle)] p-2` wrapper. The account page test counted frames by borders and shadows only, so a fill alone never failed.
- **Error class:** A second surface inside an island, drawn as a fill instead of a frame.
- **Guard:** The account pages browser test now also fails when a block of rows inside the account frame paints its own fill. The lists use row hairlines (`divide-(--ui-data-row-divider)`) instead.
