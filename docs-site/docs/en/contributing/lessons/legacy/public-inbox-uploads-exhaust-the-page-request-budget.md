### Public inbox uploads exhaust the page request budget

- **What happened:** A 15-file inbox upload hit rate limits after only a few files ([#1168](https://github.com/k2b-dev/cloud/issues/1168)).
- **Root cause:** Upload control requests shared the public page limit of 10 requests per minute per IP. The initial per-link upload key let one client bypass the cap by spraying tokens.
- **Error class:** Rate-limit scope and budget mismatch.
- **Guard:** `public-rate-limit.integration.test.ts` checks the separate 120-request per-client (IPv6 /64) upload budget, token spraying, mounted routes, similar paths, page isolation and secret-free Valkey keys. `public-upload-rate-limit.test.ts` checks address bucketing without Valkey. `public-inbox.behavior.test.tsx` checks automatic waits during a 15-file batch and the terminal rate-limit message.
