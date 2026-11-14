### A video test expected a range request before WebKit needed one

- **What happened:** The Files Lightbox video test failed in WebKit only: it expected a `Range` request once the clip had its metadata, but WebKit had read the 21 KB test clip with one plain GET.
- **Root cause:** When an engine asks for a byte range is its own choice. Chromium starts with `Range: bytes=0-`; WebKit starts with a plain GET and asks for ranges later, to probe the end of the clip and to seek. The test checked right after the metadata, so it raced WebKit's fetch order.
- **Error class:** A browser test asserts an engine's free fetch or buffering strategy at a fixed moment instead of the server contract and the request a user action causes.
- **Guard:** The test checks `Accept-Ranges: bytes` on the lease's answer and awaits a promise that the route handler resolves when it answers a `Range` request with 206, after the arrow key seeks. No rule can tell an engine's choice from a contract, so the guard is this test plus the `test-waits` rule against polling with a fixed number of attempts.
