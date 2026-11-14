### SQL URL client options reached PostgreSQL startup

- **What happened:** A pool limit in `DATABASE_URL` failed with `unrecognized configuration parameter "max"`; parallel smoke processes also retained an unconfigurable 10-connection global Cloud pool.
- **Root cause:** Bun 1.4 forwards URL query parameters other than TLS modes and socket path as PostgreSQL startup parameters. Cloud passed the URL through without separating client options, and initialized its global pool without a configurable `max`. The reported second pool was the smoke harness's independent Bun-global SQL client.
- **Error class:** Client configuration crosses a transport boundary as server configuration.
- **Guard:** `runtime/clients-options.test.ts` rejects native client URL options without a database; `runtime/start.test.ts` verifies startup pool limits, validation and credential-safe failures; `runtime/sql-pool.integration.test.ts` checks real connection limits, queued queries, release and independent owned pools behind the `CLOUD_TEST_DATABASE_URL` gate.
