### Measure both phone reel themes in one loaded dialog

- **What happened:** The phone reel preview test exceeded Bun's unchanged
  five-second deadline in WebKit (#2956). A local run also exceeded that
  deadline on a fresh Playwright container; subsequent runs passed.
- **Root cause:** Suspected: restarting WebKit's media pipeline for the second
  theme intermittently stalled metadata loading. The matching failure in
  [CI job 128779327641](https://github.com/k2b-dev/cloud/actions/runs/42495362857/job/128779327641)
  stopped at `metadata(tab)` in dark mode, while the light case and neighbouring
  tests passed at normal speed. The issue's older head identified a cancelled
  run; the later failing run retained logs but no browser trace, so the engine's
  internal cause could not be confirmed. Warm local traces showed prompt
  metadata and most time spent opening the page and dialog. Each theme repeated
  that setup, and measurements followed a fixed frame-plus-60-ms wait.
- **Error class:** Repeating expensive browser setup for presentation variants
  and assuming elapsed time means layout is ready.
- **Guard:** The phone reel browser test opens one dialog, waits for real video
  metadata, then applies each theme and awaits the shared `settled()` helper
  before running every original geometry and inline-video assertion in both
  themes. The `settle-reads` check guards layout reads without an awaited
  condition. No deadline or assertion was relaxed.
