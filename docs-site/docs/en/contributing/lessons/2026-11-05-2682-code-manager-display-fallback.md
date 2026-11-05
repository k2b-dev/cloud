### Keep authorized Code metadata when the registry is unavailable

- **What happened:** Managers lost Code title snapshots and handles when the registry could not answer.
- **Root cause:** The registry failure branch discarded database metadata along with registry presentation.
- **Error class:** Presentation availability incorrectly narrows already authorized data.
- **Guard:** Resolver unit tests cover readers and managers during rejected and stalled registry reads. The AI grant-route integration test checks that the post-commit response and reloaded list retain the handle.
