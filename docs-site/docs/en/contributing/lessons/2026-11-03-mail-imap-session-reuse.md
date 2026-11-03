### Every folder check logged in to IMAP again

- **What happened:** Each folder check opened its own IMAP connection, logged in, read `STATUS` and logged out. A mailbox with five synchronized folders logged in at least five times a minute while nothing changed, which costs latency and counts against provider login limits.
- **Root cause:** A shared IMAP session lived only as long as one batch, although the checks of one account run right after each other under its provider lease.
- **Error class:** Connection setup repeated per unit of work instead of per account and burst.
- **Guard:** `imap-smtp.test.ts` ("a kept connection serves the next session with the same key, once") requires three checks of one account to log in once, another account to log in on its own, and a failed session to give its connection up. "a kept connection that timed out is replaced by a new one" covers the idle timeout. A kept connection lives at most 30 seconds, inside the 60-second socket timeout, and the process closes kept connections when it stops.
