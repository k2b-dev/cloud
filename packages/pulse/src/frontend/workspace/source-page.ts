/**
 * Rows the sources table shows at a time, and how many sources the server reads for the first picture. Measured with
 * 1,000 sources in WebKit on the test VM (load 7–12 of 32): 26.11.2026 before identity B, 100 rows 1534–1583 ms and
 * 50 rows 1242–1275 ms; 27.11.2026 with the fetch ticks per row (3 paths each), 50 rows 1644 ms and 40 rows 1490 ms,
 * at the 1.5 s budget of the scale test (brief "Scale": ready < 1.5 s). 30 rows keep a margin; more come on request.
 */
export const SOURCES_PAGE = 30;
