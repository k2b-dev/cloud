### On the phone a head with tabs cut its toolbar's row, which then lay over the pane's first row

- **What happened:** A pane head with tabs above a toolbar (gateway-ops Läufe) stood 49 px high on the phone. The toolbar's row of the head block hung below that height and covered the first row of the pane's content.
- **Root cause:** One v2.css rule gives a head with tabs the fixed tabs height on the phone. It was written before a head and its toolbar became one block (#4537) and still applied to a head block, which needs two rows there.
- **Error class:** An older fixed-height rule for a part keeps applying after a newer layout puts more content into the same box.
- **Guard:** The rule now skips a head block (`:not([data-block])`). The `tabs` case of `head-block.browser.test.ts` checks at 390 and 1440 px, on the server's page and the hydrated one, that the toolbar stays in the block and the content starts under it. It was red at 390 px before the fix.
