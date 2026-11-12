### The first column response was mistaken for a complete board refresh

- **What happened:** The invalid-filter Kanban test intermittently counted only two or three of four refresh requests in Chromium and WebKit (#1909).
- **Root cause:** The test awaited the first filter response and immediately asserted the total request count. The no-error check was already true before the other columns refreshed, so it did not synchronize the test with those columns.
- **Error class:** One response is used as the completion signal for independent work on several resources.
- **Guard:** The browser case waits for a response for each distinct column and for every response body to finish. A route gate holds the later three requests until the first response arrives, verifies that only one request reached the server, and then releases the remaining requests. Under a 50% CPU quota, this guard fails before the fix with one request instead of four and passes afterward. No timeout or retry changed.
