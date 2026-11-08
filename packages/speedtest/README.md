# Standalone speedtest

`@k2b/speedtest` contains the shared measurement engine, public DE/EN website,
Node/Bun CLI and an independent Bun HTTP service. It uses `@k2b/ui` and
`@k2b/ssr`; it needs no Cloud runtime, account, database or cache.

From the repository root, after preparing workspace dependencies:

```bash
bun run --cwd packages/ui build
bun packages/speedtest/scripts/build.ts
SPEEDTEST_PUBLIC_URL=http://127.0.0.1:8080 bun packages/speedtest/dist/server.js
```

Open `http://127.0.0.1:8080/de` or `/en`. The public URL identifies the
measurement server, canonical SEO links and script commands; set it to the
actual HTTPS origin in production. In another terminal, run:

```bash
node packages/speedtest/dist/cli.js --server http://127.0.0.1:8080 --json
```

`--help` lists build, server and CLI options. Each source IP (IPv6 /64) may
start two tests in a rolling minute; cancelled starts count. Capacity defaults
admit one test at a time. Measure and configure the host's bandwidth budget
before making it public.

See [Run a speedtest server](../../docs-site/docs/en/operations/speedtest-server.md)
for HTTPS ingress, capacity, privacy, optional UDP and result definitions.
