### Focus a visible budget row before advancing its tooltip clock

- **What happened:** The phone dashboard browser test waited indefinitely for a budget tooltip while its timer clock was paused.
- **Root cause:** Programmatic focus could scroll the budget row and inherit pointer focus instead of keyboard focus. The shared tooltip requires visible keyboard focus and dismisses on scroll; advancing its delay alone does not establish those conditions.
- **Error class:** A browser fixture waits for feedback without establishing its interaction prerequisites.
- **Guard:** The area and money dashboard cases scroll the row into view, settle the scroll before opening, reach the row with Shift+Tab, and assert visible keyboard focus. They advance the existing 250 ms delay and require the Office tooltip. Exact panel heights, retry states, desktop, phone, and dark coverage remain unchanged.
