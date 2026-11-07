### A renamed fetch error code billed unsent AI requests

- **What happened:** On Bun 1.4.3 and later, an AI request to a closed port was booked with its estimated input tokens instead of zero, and it counted as possibly delivered.
- **Root cause:** Bun renamed the fetch error code `ConnectionRefused` to `ECONNREFUSED`. `provider-fetch.ts` listed only the old name, so a refused connection no longer counted as unsent.
- **Error class:** A runtime error code matched as a string without a test against the real runtime.
- **Guard:** `provider-retry.test.ts` connects to a real closed port and checks the booking. It caught this rename, while `app-events` already accepted both names. A Bun upgrade needs a search for every matched error code.
