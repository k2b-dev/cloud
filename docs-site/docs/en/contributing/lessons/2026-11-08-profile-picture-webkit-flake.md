### A save starts a reload before its test finishes the new page

- **What happened:** The profile picture browser test lost its WebKit page while opening the next dialog in CI (#2935). The job recorded a compositor SIGSEGV at the same time; no browser trace was uploaded.
- **Root cause:** The test treated the arrival of a reload request, or even the save request, as completed work and closed its context while the new document was still loading. A local trace ended during the reload response, and a load-count assertion failed with one completed load instead of two. Whether this teardown race caused the CI compositor crash is unconfirmed.
- **Error class:** A request starting is mistaken for the browser finishing the resulting navigation.
- **Guard:** `profile-picture.browser.test.ts` subscribes to the next document load before Save, Retry, or closing after deletion, waits for the new avatar trigger and rendering to settle, and checks both document requests and completed loads. The completed-load assertion fails against the previous request-only wait. Dialog interactions use the named avatar trigger and wait for the loaded editor to settle; timeouts and test budgets stay unchanged.
