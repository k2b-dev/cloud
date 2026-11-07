### WebKit exhausted a shard budget before its final files

- **What happened:** A sync WebKit shard reached its 20-minute budget during SpeedTest after 22 completed files took 1,183.8 seconds. Green main shard 4 took 977.4 seconds for 34 completed files. The completed prefix contained no Code page tests.
- **Root cause:** Stale suite weights and a 15-minute planning target left too little margin for the measured slowdown across unrelated files. The underlying runner slowdown remains unexplained in #1998; extra branch files alone do not explain the failure.
- **Error class:** A measured execution plan leaves insufficient headroom for observed runner variance.
- **Guard:** Reuse #2804's existing 11-minute WebKit planning target, importer recommendation, warning, and exact-coverage budget test. Refresh browser weights from main run 42379681418 and failed sync run 42380036778. The CI matrix test checks exact coverage and the shared 11-minute target for the configured seventeen shards. During verification, a fifteen-shard matrix failed that guard at 708.3 seconds; the final matrix has a slowest predicted shard of 625.2 seconds. The 20-minute execution budget stays unchanged.
