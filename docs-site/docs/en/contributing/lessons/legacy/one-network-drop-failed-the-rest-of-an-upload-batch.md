### One network drop failed the rest of an upload batch

- **What happened:** After the connection dropped during a large upload, each remaining file failed immediately instead of waiting ([#1167](https://github.com/k2b-dev/cloud/issues/1167)). Stalled and busy transfers also required a manual retry ([#1163](https://github.com/k2b-dev/cloud/issues/1163)).
- **Root cause:** The queue treated temporary transfer failures as final row outcomes. Request deadlines detected stalls, but no attempt-level policy resumed the retained session.
- **Error class:** Transient failure amplified across queued work.
- **Guard:** `upload-retry.test.ts` checks one shared, bounded retry policy. `upload-retry.behavior.test.tsx` checks a 30-file network drop, deadline exhaustion, Retry-After, cancellation, and stale attempts through the real upload adapters and panel. CLI tests and `filegate-transfer.integration.test.ts` check bounded retries and resume with the same key and session.
