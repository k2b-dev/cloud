### A state timeline over a day showed almost no times and durations without a unit

- **What happened:** A state timeline over a day of millisecond instants showed one axis label at an odd time ("13:33") or none, and its tooltip gave a duration of 4 seconds as "Dauer: 4.000".
- **Root cause:** The timeline picked its ticks with `niceStep` over raw numbers, which steps in powers of ten of milliseconds, not in hours. The tooltip's duration had no formatter, and the shared renderer kept `timeAxis` for line charts only.
- **Error class:** A chart that draws time as plain numbers: steps, labels and spans that ignore the clock and its units.
- **Guard:** The state timeline takes the line chart's `timeAxis` (round wall-time ticks in a zone, 24-hour labels, durations with their unit). Render tests in `chart-state-timeline.test.ts` pin a Berlin day's ticks and the durations, and `chart-state-timeline.browser.test.ts` checks round hour labels without overlap and a tooltip with a unit.
