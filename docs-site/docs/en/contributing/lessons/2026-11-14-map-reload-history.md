### Restored focus did not mean a map dialog had left browser history

- **What happened:** The WebKit map reload test saw the closed map's query parameter after the tile had regained focus.
- **Root cause:** Closing removes the dialog immediately and returns focus, while `dialogCore` removes its history entry through an asynchronous `history.go()`. The test treated focus restoration as proof that the traversal and any later URL cleanup had completed and read the address too early. The CI log alone does not distinguish those two asynchronous steps. The dialog's result already waits for `historySettled()`; no product history change is needed.
- **Error class:** An asynchronous browser assertion waits for an earlier, independent effect instead of the state it reads.
- **Guard:** The map reload browser test holds the close traversal until after focus returns, then releases it and waits for the map parameter to disappear before checking the preserved conversation and the next Back destination. The old immediate assertion fails deterministically with the held traversal. The fresh-link and remounted-tile cases also wait for the actual URL rather than dialog removal or animation frames.
