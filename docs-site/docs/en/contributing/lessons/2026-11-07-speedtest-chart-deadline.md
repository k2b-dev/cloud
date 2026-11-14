### Keep delayed samples inside a fixed chart domain

- **What happened:** A real browser measurement replaced the island with its error fallback near completion, although deterministic happy-path browser tests passed.
- **Root cause:** A delayed callback reported elapsed time beyond the chart's fixed 14-second axis. The shared renderer correctly rejected an out-of-domain point.
- **Error class:** Timer scheduling drift crossing a visual domain boundary.
- **Guard:** The caller clamps plotted time to the chosen measurement deadline. The browser guard accelerates the monotonic clock relative to timers and requires a completed result without page errors. The shared chart renderer keeps its strict domain validation.
