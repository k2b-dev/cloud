### Date parameters inferred as text or intervals

- **What happened:** Pulse writes returned 503, scrape errors could not be saved, and the admin base list failed.
- **Root cause:** PostgreSQL inferred untyped parameters in `INSERT … SELECT`, `CASE`, and timestamp arithmetic before considering the target column. Dates became text or intervals.
- **Error class:** SQL parameters infer the wrong type.
- **Guard:** Explicit `timestamptz` casts at those expression boundaries; Pulse ingest identity, scrape, rollup, and store maintenance integration suites execute these paths against PostgreSQL.
