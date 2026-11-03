### A stale services mock prevented the gateway route-removal guard from running

- **What happened:** The App-PWA all-invalid snapshot regression failed before reaching its routing assertions.
- **Root cause:** The gateway runtime imported the new `watchGatewayDomainChanges` service, but the subprocess services mock omitted that export. Module initialization failed.
- **Error class:** An incomplete module mock hides the behavior a regression test should exercise.
- **Guard:** Run `packages/gateway/src/installable.test.ts` singly when changing gateway runtime imports. Its valid-to-all-invalid snapshot transition asserts that both route count and App-PWA installations become zero, independently of SQL persistence.
