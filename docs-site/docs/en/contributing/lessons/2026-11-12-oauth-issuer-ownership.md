### Platform signing depended on an optional issuer's private schema

- **What happened:** An independent issuer could hold `oauth:issue` but still needed the built-in OAuth application's private client and grant tables to issue tokens.
- **Root cause:** Core resolved private OAuth policy and consumed issuer grants while signing; verifiers also joined the private client table.
- **Error class:** Domain ownership leaking across a public platform boundary.
- **Guard:** The signed third-party issuer integration test runs with `oauth.clients` absent, checks current registry invalidation, and verifies the resulting JWT through the public verifier. Issuer regression tests cover policy, reservations, finalization and notice retries.
