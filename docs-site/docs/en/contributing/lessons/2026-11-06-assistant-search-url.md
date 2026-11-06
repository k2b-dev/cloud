### Reloading a rendered search lost its query

- **What happened:** Assistant search results could appear before their query reached the URL, causing a flaky WebKit assertion (#2701). Reloading at that point lost the search.
- **Root cause:** `AllChats` starts loading results after calling `onQueryChange`. That callback used `navigate()` with a deferred view-transition history commit. Results could render first. The query replacement now sets `viewTransition: false`, committing history before loading results.
- **Error class:** Rendering reloadable state before committing its address.
- **Guard:** `AssistantPwa.more.browser.test.ts` uses a `MutationObserver` to reload as soon as search results appear, then verifies the query and identical rows after reload and Back. The test fails on the old product code with an empty query. Search and clear also wait for the promised URL. No fixed wait or timeout increase is needed.
