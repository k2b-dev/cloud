### Initialize the runtime behind complete read-path fixtures

- **What happened:** Activation and SSR page-link integration tests failed before reaching their page assertions.
- **Root cause:** The app-owned submission fixture reached the existing process registry without starting Sync. The SSR transport adapter omitted the compiled query's schema hash, its service fixture had no registered Code setting defaults, and preview requests included an unrelated chat fixture field.
- **Error class:** Incomplete runtime initialization in an integration fixture.
- **Guard:** The activation suite gates on NATS and owns the Sync lifecycle. The SSR adapter uses the compiled schema hash and asserts that queries and result validation succeed before checking the ready page. Its settings fixture uses the declared Code defaults and requests contain only their declared fields; the existing full-path tests still check both omitted and retained pages.
