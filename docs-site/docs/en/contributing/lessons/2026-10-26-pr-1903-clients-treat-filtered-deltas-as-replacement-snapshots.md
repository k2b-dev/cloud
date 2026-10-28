### Clients treat filtered deltas as replacement snapshots

- **What happened:** Removed rows survive when a filtered delta is merged into an older window.
- **Root cause:** Clients treat filtered deltas as replacement snapshots.
- **Error class:** Clients treat filtered deltas as replacement snapshots
- **Guard:** Tests: Chat store system resync and selected-item availability cases replace the window and clear unavailable selections.
