### A claim replaced every kanban column and card

- **What happened:** Claiming a card detached it during the refresh, losing focus and hover and leaving a WebKit box read empty ([#1391](https://github.com/k2b-dev/cloud/issues/1391)).
- **Root cause:** Solid's `<For>` keyed columns and cards by refetched object references.
- **Error class:** A mutation’s refresh re-creates a rendered entity’s element.
- **Guard:** `keptThrough()` checks element identity and height in the kanban and detail claim tests. The held-card test checks that refresh keeps a press until its card leaves the column. Convention: [Keep focus while content refreshes](/en/ui/focus#keep-focus-while-content-refreshes).
