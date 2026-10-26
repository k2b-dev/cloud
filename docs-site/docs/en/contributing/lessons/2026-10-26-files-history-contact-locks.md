### Keep contact observations out of publication contention

- **What happened:** Contact observation used the same non-reentrant root mutex as publication and treated contention as a failed observation.
- **Root cause:** Detail reads and Office saves returned 503 while a local root was locked for a long publication. A no-op move-back could reacquire its own lock.
- **Error class:** Detail reads and Office saves returned 503 while a local root was locked for a long publication. A no-op move-back could reacquire its own lock.
- **Guard:** Local-root integration tests hold the publication lock during detail, stable-reference, upload-start and Office-save calls. Healthy repeated contacts preserve the schedule row version; repeated move-back preserves history. Evidence: Opportunistic contact checks defer busy work; publication observes under its existing lock. No-op paths return their already-authorized result directly.
