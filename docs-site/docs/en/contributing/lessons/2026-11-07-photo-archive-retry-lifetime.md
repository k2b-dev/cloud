### An archive retry must start one complete new transaction

- **What happened:** Retrying one photo after a middle ZIP size refusal could reuse the failed archive closure, download its contents, and leave earlier photos dirty with stale errors.
- **Root cause:** Nested save callbacks outlived the archive attempt that owned their captured entries.
- **Error class:** Stale asynchronous transaction continuation.
- **Guard:** Every archive attempt owns a token invalidated on failure, completion and unmount. The Tools browser guard refuses encoding on the second photo, accepts the smaller per-photo retry, checks no stale archive downloads, then starts a fresh whole ZIP and checks all captured entries become clean together.
