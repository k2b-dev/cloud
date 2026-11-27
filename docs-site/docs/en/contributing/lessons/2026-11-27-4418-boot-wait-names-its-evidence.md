### A wait for a page's client names the scripts that did not load

- **What happened:** Two browser tests failed once each in loaded runs, and neither error said why. Chat's `load` called `window.mountChat` and got `TypeError: window.mountChat is not a function` (#4402). The Tools page-swap contract timed out after 10 s, waiting for the shell's navigation announcer (#4393).
- **Root cause:** Both tests acted on, or waited for, something the page's client puts in place when it boots. `page.goto` resolves on `load`, and a module script that failed to load does not stop that event. So the navigation succeeded, and the request that failed or the error that removed the announcer again was gone by the time the test failed.
  - A probe that aborts `/harness.js` gives the Chat symptom every time.
  - A probe that makes the shell's runtime throw while it puts in the announcer gives the Tools timeout every time.
  - Which request or error caused the two runs is not known; neither kept a log.
- **Error class:** A test acts on a page's boot state without waiting for it, or waits without the evidence of why it never came.
- **Guard:** `waitInPage()` in `packages/ui/test/browser.ts` now also names the scripts and documents that failed to load, or were answered with 400 and above, since the page opened. Chat's `load` waits for `window.mountChat` with it, and the page-swap contract waits for the announcer with it, so the next red run names its cause. `packages/ui/test/browser.browser.test.ts` checks that both lines appear.
