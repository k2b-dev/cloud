### A refused SMTP login sent every message back to the drafts

- **What happened:** When the mailbox's SMTP server refused its password (535, or 534 for a login it wants done another way), each send failed at once and returned to the drafts. The mailbox kept working until IMAP refused the password too, so nothing told the team to sign in again, and every later send failed the same way.
- **Root cause:** Only IMAP and rediscovery recorded a refused login. The send path treated SMTP 534/535 like any other permanent 5xx rejection.
- **Error class:** One credential failure classified differently by two protocols of the same account.
- **Guard:** `sent-projection.integration.test.ts` ("a send whose SMTP login is refused waits for a new login and goes out once the mailbox is signed in again") requires 535 and 534 to mark the mailbox `auth_required` and keep the send waiting, also after a folder sync that finds no binding (review found that such a sync replaced `auth_required` with `connection_required` and ended the wait, on the IMAP path too). Once the account is signed in again, the send goes out with exactly one submission, and a 550 stays final. The test fails without the fix.
