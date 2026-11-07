### A storage fault mock silently left writes enabled

- **What happened:** The comment storage-failure test timed out waiting for a warning because the request token was saved successfully.
- **Root cause:** Happy DOM's Storage proxy ignores method assignment, so spying on the instance's `setItem` did not install the throwing implementation.
- **Error class:** Fault injection does not reach the dependency being exercised.
- **Guard:** The task-detail behavior test defines the throwing method explicitly, asserts that the token write reached it, and checks that no token or POST exists before restarting with only the durable draft text.
