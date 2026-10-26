### Webhook testing bypasses outbound address policy

- **What happened:** The Webhook Tester could send requests to addresses inside the server's own network.
- **Root cause:** Tools kept its own address classifier, which missed some IPv6 notations. A failed DNS lookup let the request through, and `fetch()` resolved the name again after the check.
- **Error class:** Server-side request forgery.
- **Guard:** Tools, Mail, Grids, and the Assistant web tools use the one platform guard (`resolvePublicNetworkAddresses` and `pinnedNetworkLookup`) instead of their own classifiers. The `network-guard` check fails when application code imports `node:dns` (other than SRV, MX, or TXT record lookups) or Bun's `dns`, calls `fetch()` in a file that checks hosts with the guard, or sends a `node:http` request with a pinned lookup but without `agent: false`, which an environment proxy could otherwise take over. Platform tests cover every IP literal form and failed, empty, or mixed DNS answers; Tools tests verify refusal, the pinned connection, and that redirects are not followed.
