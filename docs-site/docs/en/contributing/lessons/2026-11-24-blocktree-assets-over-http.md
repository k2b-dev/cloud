### A BlockTree test that opens three pages ran out of time in WebKit

- **What happened:** In WebKit, the BlockTree test "a search preview's picture keeps one 4:3 place while it loads, once drawn, and when refused" hit its 5 s limit on a pull request that did not touch BlockTree (#4082); every picture state still arrived.
- **Root cause:** Each fixture page received the 2.4 MB global stylesheet inline in its HTML and the 3.6 MB harness through Playwright's route channel, so one page took 1.1–1.5 s in WebKit and the three pages of this test took 3.6–4.7 s.
- **Error class:** Fixture asset transport consumes the interaction budget.
- **Guard:** Test: `BlockTree.browser.test.ts` "each page receives the compiled stylesheet and harness over HTTP, outside Playwright's route channel" fails when a page receives them through the route again; the test limits stay unchanged.
