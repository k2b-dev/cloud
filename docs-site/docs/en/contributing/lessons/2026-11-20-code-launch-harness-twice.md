### A browser harness served under two names renders twice

- **What happened:** In Chromium, 46 head scenes of `CodeLaunch.browser.test.ts` at 390 px failed with every locator resolving to two elements (#3810). The whole Code page was in the DOM twice; at 1440 px and in the WebKit gate it was not.
- **Root cause:** The test served the harness entry both as `/__head.js` and under its build name. At 390 px the page loads the phone-sheet chunks lazily, and one of them imports the entry by its build name, so the module ran a second time and `render()` added a second page.
- **Error class:** One module served under two URLs is two module instances in the browser.
- **Guard:** The harness is served only under the entry's build name, and `open()` fails every scene unless exactly one `.cloud-code` is rendered.
