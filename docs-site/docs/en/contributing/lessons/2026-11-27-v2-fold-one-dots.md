### A bar showed two "…" when the app's "…" had a name or a menu stood after it

- **What happened:** MW moved the worst-case heads (#4210) onto the bar fold. Two heads showed two "…": one whose "…" had a name of its own ("Weitere Aktionen"), and one with a menu with its own symbol ("Ansicht") after the "…". The decision is "never two '…'".
- **Root cause:** Only a "…" without a `label` offered itself to take the folded buttons. And the "…" counted as the end's last menu only when nothing but the primary or a closing × stood after it. A named "…" or a later menu of its own made the bar add its own "…".
- **Error class:** A rule keyed on an incidental property. The name of a menu does not make it another thing; its symbol does.
- **Guard:** Every `Menu` without a symbol of its own offers itself as the "…", whatever its `label`. A menu with a symbol or words of its own never folds and does not hide the "…" before it. `packages/ui/src/v2/bar-fold.browser.test.ts` checks both heads at 390 px: exactly one "…", no bar "…", and the folded actions first in the app's "…".
