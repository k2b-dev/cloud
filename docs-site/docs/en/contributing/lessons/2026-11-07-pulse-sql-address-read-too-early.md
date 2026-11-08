### A Pulse SQL test read the address before the edit reached it

- **What happened:** `SqlConsole.browser.test.ts` › "saved selection loads only this base …" failed in CI on an unrelated pull request (#1774): after `fill("SELECT 42")` the address still held `SELECT :host`.
- **Root cause:** The editor writes the draft SQL into the address with `history.replaceState` after it reports the change. The test read `tab.url()` right after `fill()`, so on a loaded runner it saw the previous address.
- **Error class:** A test samples state before it settled.
- **Guard:** The test waits with `waitForFunction` until the address holds the edited SQL, then checks the path.
