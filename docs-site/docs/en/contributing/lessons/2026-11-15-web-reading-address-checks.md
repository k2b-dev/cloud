### Web extraction validates requested and returned addresses

- **What happened:** Web extraction accepted URL credentials and returned page addresses without applying its input address rules. The hosted API connection also used the default redirect behavior.
- **Root cause:** Address validation omitted URL credentials and ran only on the requested address; the API request did not set a redirect policy.
- **Error class:** Inconsistent address validation at a service boundary.
- **Guard:** `packages/cloud/src/ai/firecrawl-tools.test.ts` checks that URL credentials stop the request, all returned address fields use the same rules, and hosted API requests set `redirect: "error"`.
