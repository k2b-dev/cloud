### Search results appeared before their URL committed

- **What happened:** The Assistant chat search browser test intermittently failed in WebKit because the result appeared while the address still lacked `q=Gardinen` (#2701).
- **Root cause:** `AllChats` starts loading results after calling `onQueryChange`. That callback uses `navigate()`, whose history commit runs in a view-transition callback. Rendering a result does not guarantee that history has committed.
- **Error class:** Observing one asynchronous effect as proof that another has completed.
- **Guard:** `AssistantPwa.more.browser.test.ts` waits for the promised URL with `page.waitForURL()` after searching and clearing. Its result test also verifies that reload and Back preserve the query and result rows. No fixed wait or timeout increase is needed.
