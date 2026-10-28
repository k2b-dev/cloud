### A list count read before its filter re-rendered

- **What happened:** The "Shared in the chat's info" browser test failed about every second merge group. After switching to the Links filter it counted rows while the list was still re-rendering and read 0 instead of 1.
- **Root cause:** The test waited only for the removed row to detach, then counted immediately; the remaining row is re-mounted by the filter and was not yet attached.
- **Error class:** A count or geometry read races a re-render that the test triggered itself.
- **Guard:** The test now waits for the row it expects to remain before counting. Wait for the expected end state, never only for the disappearance of the old one.
