# Local load and soak testing

The Grids load harness exercises the running application through its public HTTP and WebSocket APIs. It creates a disposable Inventory base, grants a resource-bound service account access only to that base, seeds deterministic records, runs k6 in Docker, and compares Grids and Postgres health before and after the run.

This complements the test suite and `bun packages/grids/scripts/soak-100k.ts`. The direct soak script checks SQL and service correctness at scale; this harness measures the deployed request path, authentication, permissions, workflows, live events, and optional PDF generation.

## Prerequisites

- Run the local Cloud stack with `bun run dev`. Rebuild Grids with `bun run dev:rebuild grids` from the repository root when the image does not match the working tree.
- Keep Docker running. The harness starts only a temporary k6 container and does not restart the stack.
- Pass `--admin-token-file <path>` if the local admin token is not `dev-admin`.
- Configure Gotenberg only when running the optional PDF workload.

## Run a test

From `packages/grids`:

```bash
bun packages/grids/scripts/load-test.ts seed --rows 10000
bun packages/grids/scripts/load-test.ts run smoke
bun packages/grids/scripts/load-test.ts cleanup
```

`seed`/`reset` replace only a previous base carrying the harness safety marker. It refuses to delete an unmarked base. The generated manifest contains short-lived credentials and is stored with mode `0600` under `/tmp/grids-load/manifest.json` by default.

Use the profiles for different questions:

| Command | Default duration | Purpose |
| --- | ---: | --- |
| `bun packages/grids/scripts/load-test.ts run smoke` | 20 seconds | Verify the harness and deployed request paths. |
| `load-test.ts run load` | 10 minutes | Exercise sustained mixed application load. |
| `load-test.ts run soak` | 2 hours | Detect queue growth, stale leases, connection drift, and gradual degradation. |
| `load-test.ts run stress` | 9 minutes | Raise read traffic in stages and observe the local saturation point. |

The standard data scales are 10,000 records for quick iteration, 250,000 for realistic local runs, and 1,000,000 for index and pagination pressure:

```bash
bun packages/grids/scripts/load-test.ts reset --rows 250000
bun packages/grids/scripts/load-test.ts run load
```

The generated Inventory data includes text, select, number, date, formula, and relation fields. Read traffic covers table pagination, search, filtered GQL, and grouped aggregates. Other scenarios perform optimistic writes, invoke a workflow, and hold live record subscriptions.

## Optional workloads and overrides

```bash
bun packages/grids/scripts/load-test.ts run load --include-pdf
bun packages/grids/scripts/load-test.ts run soak --duration 15m
bun packages/grids/scripts/load-test.ts run load --scenarios read --duration 30s
bun packages/grids/scripts/load-test.ts run load --read-rate 35 --duration 1m
bun packages/grids/scripts/load-test.ts run load --settle-seconds 90
```

- `--include-pdf` adds a low-rate Gotenberg document workload.
- `--duration` overrides the duration of every scenario in the selected profile.
- `--scenarios` runs only the named comma-separated scenarios (`read`, `write`, `workflow`, or `live`) for targeted diagnosis.
- `--read-rate` overrides the `load` and `soak` read arrival rate in iterations per second. One read iteration can issue a second paginated request, so HTTP request throughput is higher.
- `--settle-seconds` sets the maximum time to wait for workflow and record-event queues to drain after traffic stops. It defaults to 60 seconds and returns earlier once the fixture is idle.
- `--base-url` changes the host URL used by fixture setup and health checks; `--docker-base-url` changes the URL visible inside the k6 container.
- `--k6-image` overrides the pinned `grafana/k6:0.54.0` image.
- `--state-dir` and `--report-dir` relocate generated state and reports. Run the script with `--help` for the complete list.

## Read the result

Each run writes `k6-summary.json`, `report.json`, and `report.md` below `/tmp/grids-load/results`. The Markdown report summarizes throughput, p95 and p99 latency, failed requests, checks, Postgres connections, database size, and container resource use.

A run fails when more than 1% of requests or domain checks fail, normal-profile p95 exceeds 1.5 seconds, normal-profile p99 exceeds 3 seconds, or the run introduces dead record events, stale workflow runs, or workflow effects requiring attention. Reports count HTTP 429 responses separately so application saturation is distinguishable from the configured Cloud API rate limit. Stress uses wider latency gates because its purpose is finding local saturation.

Inspect `/admin/grids`, Gateway Ops metrics, and traces alongside the report when a gate fails. A flat error rate with growing queues indicates downstream capacity pressure; increasing Postgres connections or container memory across a soak run indicates resource drift.

## Local regression baseline

The current local baseline uses one Grids app replica, the complete local Cloud stack, and 50,000 generated Inventory records:

| Workload | Result | Throughput | Latency | Errors |
| --- | --- | ---: | --- | ---: |
| Read only, 35 iterations/s | PASS | 48.6 HTTP requests/s | p95 197 ms, p99 275 ms | 0 |
| Mixed, 30 read iterations/s plus writes, workflows, and five live clients | PASS | 43.5 HTTP requests/s | p95 177 ms, p99 245 ms | 0 |

Both runs completed without rate limits, request errors, queue damage, workflow failures, Postgres connection growth, or idle transactions in the Grids pool. The mixed run also drained every workflow and record event before its report was written.

The default local API policy limits one source IP to 60 requests per second. One read iteration may fetch a second page, and the mixed profile adds writes, workflow invocations, and WebSocket handshakes. A stress run from one k6 container therefore reaches the configured ingress policy before it establishes the database or GQL compiler ceiling. Keep ordinary regression runs below that policy. Measure a higher backend-only capacity target in a controlled staging environment with an explicit load-test rate-limit policy instead of weakening the production safety limit.

## Cleanup

```bash
bun packages/grids/scripts/load-test.ts cleanup
```

Cleanup revokes the generated credential and session, removes the resource-bound service account and access rows, and hard-deletes only the marked fixture base. Reports remain available for comparison.

Local results are regression and robustness evidence, not a production capacity guarantee. Repeat the same profiles in staging with production-like CPU, memory, Postgres, Redis, and network limits before setting capacity targets or SLO budgets.
