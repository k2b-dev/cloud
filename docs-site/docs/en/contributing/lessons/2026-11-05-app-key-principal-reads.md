### App keys failed provider resource-principal checks

- **What happened:** Resource-principal reads returned 403 after an application enabled its enrolled app key, so Chat reported checks as unavailable.
- **Root cause:** Core authenticated the app key and signed an app-query invocation carrying its credential ID, but the provider only accepted legacy API tokens with an explicit `identity:invoke` scope. App keys carry that authority intrinsically.
- **Error class:** Credential migration updated ingress authentication without updating downstream live credential validation.
- **Guard:** `packages/cloud/src/_internal/app-queries.integration.test.ts` calls `readResourcePrincipals()` through the real Core broker and provider with both credential kinds, checks permission admission and app-only identity, and rejects new transmissions and already-issued invocations after revocation, expiry, account disablement, or a changed app binding.
