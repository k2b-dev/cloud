### Keep browser fixtures within each behavior’s test budget

- **What happened:** A line browser case exceeded its unchanged five-second limit after a main merge. It combined drawing, early-ending legends, hover, keyboard inspection and frame states.
- **Root cause:** Every case mounted the real Pulse, Core, Gateway, Chat and Notebook fixtures, even when it inspected only the line showcase. The combined case also repeated a separate legend scenario within the same deadline.
- **Error class:** Unrelated fixture work and independent scenarios consume a browser behavior’s time budget.
- **Guard:** Only the existing host compatibility cases mount the app fixtures. Early-ending keyboard legends have their own cases at both widths, with every original assertion preserved. Drawing, grouped hover, keyboard and frame-state guards remain intact; no timeout or size budget increases.
