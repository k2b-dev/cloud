### Observe an action and its response together

- **What happened:** A browser response wait timed out while a click was still waiting for navigation, producing an unhandled rejection between tests as well as the original failure.
- **Root cause:** The test created the response promise before the click but observed its rejection only after awaiting the click.
- **Error class:** A concurrently running promise rejects before a handler observes it.
- **Guard:** Await both promises with `Promise.all`, registering the response wait before starting the click. The existing mark-all-read test keeps both timeouts, its final-response predicate and all unread-count assertions. This fixes the unhandled rejection; the original intermittent response timeout did not reproduce with request diagnostics and its cause remains unconfirmed.
