### A fake camera that always reads a code closed the scanner that Back was meant to close

- **What happened:** The Code page browser test "tables sort on their headers; the scanner writes into its field and sends nothing" failed now and then: after `page.goBack()` with the scanner open, the page was on `about:blank`, or the second scanner never showed at all.
- **Root cause:** The test's fake camera reads "W-42" from every picture. The scanner that the test opened only to close it with Back read that code within a few frames and closed itself, with its own synthetic Back. When that Back ran together with the test's Back, history moved two steps and left the page; when it ran before Playwright saw the dialog, the wait for the dialog timed out. The product was right both times.
- **Error class:** A test fake that acts on its own, here a camera that always sees a code, races the step the test wants to drive.
- **Guard:** The fake detector in `packages/core/src/code/page.browser.test.ts` reads nothing while `cameraSeesCode` is `false`, and the Back check sets it before it opens the scanner, so that scanner stays open until Back.
