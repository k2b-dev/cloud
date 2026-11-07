# Standalone speedtest

`@k2b/speedtest` contains the shared browser-safe measurement engine and an
independent Bun HTTP service. It has no runtime package dependencies.

From the repository root:

```bash
bun build packages/speedtest/src/cli.ts --target=node --outfile=packages/speedtest/dist/cli.js
bun build packages/speedtest/src/main.ts --target=bun --outfile=packages/speedtest/dist/server.js
bun packages/speedtest/dist/server.js
```

The service listens on port 8080. In another terminal, run
`node packages/speedtest/dist/cli.js --server http://127.0.0.1:8080 --json`.
`--help` lists the server configuration and CLI options.

See [Run a speedtest server](../../docs-site/docs/en/operations/speedtest-server.md)
for HTTPS ingress, anonymous budgets, optional UDP and result definitions.
