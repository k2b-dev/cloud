### Reuse immutable browser upload storage

- **What happened:** A real browser test missed its deadline even without rendering the measurement UI. Each 16 MiB typed-array upload blocked `XMLHttpRequest.send()` for roughly 350 ms on the development host.
- **Root cause:** Every request copied the mutable byte buffer synchronously on the main thread.
- **Error class:** Repeated binary serialization blocks cancellation and deadline callbacks.
- **Guard:** The browser transport creates one immutable Blob per payload size and reuses it across streams. A transport regression checks shared immutable storage and progress before completion; the real browser run verifies the whole measurement boundary.
