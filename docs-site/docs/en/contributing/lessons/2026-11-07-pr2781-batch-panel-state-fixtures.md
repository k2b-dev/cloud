### Exercise panel states together before reloading a workspace

- **What happened:** The WebKit shard reached its run budget even though all Pulse dashboard assertions passed. The dashboard file took 346.6 seconds; the three area and money variants took 36.1 seconds combined.
- **Root cause:** The new cases loaded a separate page per viewport/theme and reloaded the whole workspace twice for each of four panels. Each reload repeated unrelated shell and chart setup. The shard's measured-duration rebalance is tracked separately in #2804.
- **Error class:** Browser fixtures repeat expensive setup for independent state assertions.
- **Guard:** One area and money case reuses its page across desktop, phone and dark mode, batches cold error and recovery loads for all four panels, and still uses every panel's retry control. It retains the same exact frame, keyboard tooltip, empty, error and recovery assertions within the existing 30-second test timeout. Compare the file and case durations in CI before and after fixture changes; do not reduce coverage or raise budgets to fit a shard.
