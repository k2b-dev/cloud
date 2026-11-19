### Record history used two clocks during hydration

- **What happened:** A record opened by its URL could show a different day divider or relative time in the first browser render.
- **Root cause:** The new timeline used the current clock separately on the server and in the browser. The record history did not receive the server time from the route island.
- **Error class:** A time-dependent first render without a serialized server clock.
- **Guard:** Grids serializes the clock at its route island and passes it to the record history. `RecordHistorySection.render.test.tsx` checks the initial day and relative time with a browser clock across midnight.
