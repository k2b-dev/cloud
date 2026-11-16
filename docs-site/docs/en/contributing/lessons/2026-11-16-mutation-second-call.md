### A second mutation call could overtake the one in flight

- **What happened:** A second `mutate()` while a call was running started another run, so the Enter key in a form, hotkeys, and code could send a write twice, and state shown for a mutation could belong to a different call than the one that started it.
- **Root cause:** `mutation.create()` from `@k2b/stdlib/solid` before 0.33.0 always let a newer call supersede the running one; only places that checked `loading()` themselves were protected.
- **Error class:** A safety rule that each caller must remember instead of the shared primitive enforcing it.
- **Guard:** `@k2b/stdlib` 0.33.0 drops a second call while one is pending or loading by default, covered by its mutation tests; the few mutations where the newest call must win opt out with `concurrency: "replace"`.
