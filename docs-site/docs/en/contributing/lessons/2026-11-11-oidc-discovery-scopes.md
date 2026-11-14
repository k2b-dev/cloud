### Discovery omitted supported scopes

- **What happened:** OpenID discovery omitted `groups` and `admin`, preventing clients that rely on discovery from requesting supported scopes.
- **Root cause:** Discovery reused the restricted dynamic-registration scope policy instead of the server's supported scope schema.
- **Error class:** Discovery derives supported capabilities from a registration policy subset.
- **Guard:** `packages/oauth/src/contracts.test.ts` checks both discovery documents against `OAuthScopeSchema.options` and verifies that dynamic registration still rejects `groups` and `admin`.
