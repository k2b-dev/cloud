### A thread pool that starts on demand is missing from an outside sample

- **What happened:** The PDF decoder thread-set test sometimes saw no `HeapHelper` thread, although the decoder kept its fixed thread set ([#2256](https://github.com/k2b-dev/cloud/issues/2256)).
- **Root cause:** JSC starts its GC helper thread with the first garbage collection. The test decoder runs a single collection, which an allocation starts close to the 8 MiB limit late in the render. When a run allocates less, or the sampler misses the last milliseconds, the process exits before a sample shows the thread. `BUN_JSC_numberOfGCMarkers=2` pins the pool to one helper; without it, JSC starts one helper for each core, up to seven.
- **Error class:** A test samples a process from outside and expects a pool that starts only when the work needs it.
- **Guard:** `pdf-render.test.ts` runs the real decoder through `fixtures/pdf-decoder-thread-probe.ts`. The probe forces a full collection after the render and reports every thread of its own process. If one of the three pool settings is removed, the test fails on every run.
