### A send repeated IMAP login for each Sent operation

- **What happened:** Bulk sends repeatedly connected and logged in to the same mailbox while holding its provider lease, delaying subsequent mailbox work.
- **Root cause:** A fresh send searched Sent before SMTP despite having no earlier provider effect, then used separate IMAP connections for the existing-copy lookup, APPEND, and confirmation lookup.
- **Error class:** Related provider operations bypass an existing session scope and repeat connection setup inside a serialized operation.
- **Guard:** `sent-projection.integration.test.ts` counts real connector IMAP connects and SMTP submissions for a fresh send, requires IMAP to open after SMTP, and checks that retries with durable provider-effect evidence still reconcile before sending. A dropped-session regression preserves confirmed delivery with a pending Sent copy. Send-attempt logs expose preparation, lookup, SMTP, Sent-copy, lease-acquisition, and total durations without message content.
