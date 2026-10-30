### Measure disposable database storage separately from query execution

- **What happened:** CI integration statements sometimes took several seconds without a blocking session; one multi-table `TRUNCATE` took 7.8 seconds while the local equivalent took 33 ms. Refs #2153 and #2118.
- **Root cause:** Suspected: storage work during relation creation or transaction completion on CI runners. Checkpoint and commit timings do not prove that fsync or file operations caused the stalls; tmpfs and disabled durability are a measurement experiment.
- **Error class:** Test infrastructure overhead can obscure the behavior under test.
- **Guard:** Convention: confine non-durable PostgreSQL settings to disposable containers, bound their tmpfs, and compare statement logs and sampled cluster storage before drawing conclusions. No deterministic regression test, because the source of the sporadic stalls is not confirmed.
