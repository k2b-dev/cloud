### Live dictation must preserve streamed text and finish accounting once

- **What happened:** Microphone setup could fail on browsers with different stream and context sample rates. Normalized final text and overlapping cancellation cleanup could turn a completed dictation into a failure or duplicate its usage record.
- **Root cause:** Microphone setup forced a context rate before connecting the stream. Completion assumed the provider's final text extended every delta, while two asynchronous cleanup paths could both finish accounting.
- **Error class:** Browser capability assumptions and asynchronous lifecycle races.
- **Guard:** `live-dictation-browser.test.ts` checks default-rate capture, stored devices, fallback errors, and terminal socket closes. `live-dictation.integration.test.ts` checks final-text mismatches, early completion, cancellation during accounting startup, replica clock skew, quota charges, connection deadlines, and migration idempotence.
