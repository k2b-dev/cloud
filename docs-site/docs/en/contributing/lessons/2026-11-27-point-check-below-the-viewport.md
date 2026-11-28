### A link below the viewport read as covered

- **What happened:** The weather city search test checks that each source link in the add-place dialog is the element at its own centre. In WebKit at 390 px it failed in about half the runs (#4444). A probe showed the link at y 1414 in a viewport of 1000 px, so `elementFromPoint` found nothing there.
- **Root cause:** On the phone the dialog is a sheet whose body scrolls. With the search's options open, the source lines stand below the fold. The test read the point before the link was in view and before the sheet came to rest.
- **Error class:** A point-based check (`elementFromPoint`) on an element outside the viewport or still in motion.
- **Guard:** The test scrolls the link into view and awaits `settled(page)` before the point check (`packages/weather/src/frontend/weather-geo.browser.test.ts`). It passed in Chromium and in two WebKit runs in a row.
