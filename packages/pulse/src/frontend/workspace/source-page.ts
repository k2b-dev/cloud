/**
 * Rows the sources table shows at a time, and how many sources the server reads for the first picture. Measured with
 * 1,000 sources in WebKit on the test VM (6 runs each, 26.11.2026): 100 rows were ready in 1534–1583 ms, over the
 * 1.5 s budget of the scale test (brief "Scale": ready < 1.5 s); 50 rows in 1242–1275 ms.
 */
export const SOURCES_PAGE = 50;
