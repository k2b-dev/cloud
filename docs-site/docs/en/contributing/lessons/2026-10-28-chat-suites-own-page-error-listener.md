### A Chat suite failed on WebKit's refused load during its own reload

- **What happened:** In the merge group of #2020, `Chat info reopening > info stays reachable after X and preserves Back on phone` failed with the page error `Fetch API cannot load …/api/capabilities/v1/catalog?limit=25 due to access control checks.` after the test's `page.reload()`.
- **Root cause:** The Chat browser suites registered their own `pageerror` listener. During a navigation that the test starts, WebKit refuses a request that the old page still makes and reports the refusal as a page error, also when the page handles the rejection. `pageErrors(page)` ignores exactly this report, but the Chat suites did not use it.
- **Error class:** Navigation-refused load reported as a page error.
- **Guard:** The `page-errors` check (convention TEST-15) fails on a new own `pageerror` listener in a test, browser suite, or browser harness. Its baseline lists the older suites and only shrinks. All Chat browser suites now use `pageErrors(page)`.
