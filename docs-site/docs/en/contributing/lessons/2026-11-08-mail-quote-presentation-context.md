### Persist a quote's locale and time zone before reviewing outgoing mail

- **What happened:** Automatically appended replies used English attribution and UTC dates for German senders.
- **Root cause:** The quote loader supplied a fixed English/UTC context rather than using the context of the person who enabled the quote.
- **Error class:** Deferred content rendering loses the originating person's presentation context.
- **Guard:** `compose-quote.test.ts` validates quote context and hash changes; `capability-reviews.integration.test.ts` compares German/Berlin preview and frozen send output and rejects sends after either saved value changes. Drafts without a quote retain their previous hash representation.
