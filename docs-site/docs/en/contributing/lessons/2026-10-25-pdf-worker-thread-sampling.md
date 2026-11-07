### Count decoder workers by their assigned names

- **What happened:** The PDF image test sometimes counted three Bun pool threads although the worker pool was limited to two.
- **Root cause:** Linux gives a new thread its creator's name until it sets its own. A syscall trace and a controlled scheduling diagnostic caught a libvips child temporarily sharing its Bun worker's name.
- **Error class:** Sampling transient thread names mistakes an inherited identity for an additional worker.
- **Guard:** The sampler counts distinct numbered Bun worker names. Regression cases cover an inherited duplicate and a real third worker; the existing two-worker limit, decoder configuration, and deadlines remain unchanged.
