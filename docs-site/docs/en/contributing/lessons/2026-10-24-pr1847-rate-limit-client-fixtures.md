### Rate-limit fixtures share a client budget

- **What happened:** A token matrix received HTTP 429 before reaching its authorization assertions.
- **Root cause:** Independent API and relay clients reused the anonymous IP bucket or addresses within one IPv6 network.
- **Error class:** Rate-limit fixtures share a client budget.
- **Guard:** Test: Files `machine-access.integration.test.ts` uses the shared `uniqueCallerAddress()` fixture for each independent API and relay client, through the app-access gate.
