### Nightly certification ran without its browser

- **What happened:** Nightly Grids certification could not launch Chromium.
- **Root cause:** The certification job omitted the browser installation that its browser phases need.
- **Error class:** A CI job runs a suite without the prerequisites that suite needs today.
- **Guard:** `nightly-grids-reports.test.ts` requires Chromium installation before certification.
