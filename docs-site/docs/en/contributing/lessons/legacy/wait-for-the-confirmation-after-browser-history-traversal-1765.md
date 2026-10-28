### Wait for the confirmation after browser history traversal (#1765)

- **Error class:** asynchronous UI locator race. The Pulse Back test could resolve the settings form's Discard button before the confirmation appeared, then wait on that hidden button.
- **Guard:** the test waits for the named confirmation dialog and its question before clicking its Discard button. It still checks Back, Escape, Cancel, draft preservation and the resulting URL.
