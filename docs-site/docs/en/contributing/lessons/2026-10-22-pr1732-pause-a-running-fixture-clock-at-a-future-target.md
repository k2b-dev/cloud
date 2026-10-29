### Pause a running fixture clock at a future target

- **What happened:** Pulse SQL browser setup sometimes failed before feature assertions with “Cannot fast-forward to the past” ([#1889](https://github.com/k2b-dev/cloud/issues/1889)).
- **Root cause:** The installed fake clock kept running between protocol calls, passing the identical pause target.
- **Error class:** Fixture clock setup races elapsed real time.
- **Guard:** Install one day before the target, then pause at the exact original fixture time before navigation. Keep controlled timers, explicit advances, assertions, and deadlines unchanged.
