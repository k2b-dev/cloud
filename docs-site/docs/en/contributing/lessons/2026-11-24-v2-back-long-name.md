### The v2 way back ran out of its bar with a long name

- **What happened:** On the phone, the way back of an open detail (`Pane back`, the part `Back`) with a long name, such as "Suchergebnisse für …", ran out of its bar and under the controls beside it, on every page. The layout measure did not report it in the v2 tests, because no fixture had a long name.
- **Root cause:** Every v2 button keeps its whole label (`flex: none`, one line without a limit). The text button of `Back` was such a button, and its bar gave it no limit.
- **Error class:** A control whose label comes from data (a list's name, a search) keeps the width of the whole label, so a long value leaves its place.
- **Guard:** The text button of `Back` shrinks with its bar and cuts its label with "…", keeping the whole name as its accessible name and its hint. `primitives.browser.test.ts` opens a detail whose way back has a long name at 390 px. The layout measure accepts a label that ends in "…" in its own box and still reports every other cut label.
