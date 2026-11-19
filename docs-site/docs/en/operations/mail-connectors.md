---
title: Mail connectors
navTitle: Mail connectors
section: Operations
order: 1163
description: Check whether a mailbox server offers JMAP and which protocols Mail uses.
tags: [mail, operations, protocols]
updated: 2026-11-19
---

# Mail connectors

Mail uses IMAP to read and change mailboxes and SMTP to send messages.
Every connected mailbox continues to use IMAP and SMTP. JMAP is not yet used
for synchronization, message changes or sending.

When a provider connection is verified or its limits are refreshed, Mail checks
whether its IMAP hostname offers JMAP over HTTPS on port 443. This check sends **no credentials**.
It runs alongside verification and stops when verification finishes, or after
five seconds. A failed or unfinished check does not fail IMAP verification.

Run `cld mail admin operations` as a Cloud super administrator to see
`JMAP possible` or `JMAP not detected` for each mailbox. With `--json`, each
mailbox's `jmap` boolean reports whether a non-revoked provider connection
returned a positive hint. Mailbox operators also see the count of active
bindings with a positive hint at `connectors.capabilities.jmap` in
`cld --json mail operator status`.

“Possible” is a discovery hint, not proof that credentials or the account work
with JMAP. “Not detected” also covers older connections that have not been
checked, timeouts and servers that did not answer before the provider check
finished. Neither result changes the mailbox's protocol or sends its password
to a discovered address.
