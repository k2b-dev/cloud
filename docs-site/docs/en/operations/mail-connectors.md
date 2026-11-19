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

Mail uses IMAP for mailboxes and SMTP for sending. No mailbox uses JMAP yet.

Adding or changing a provider connection and refreshing its limits checks the
IMAP hostname for JMAP over HTTPS on port 443, **without credentials**.
Background rediscovery never checks. Connection changes do not wait for detection;
limit refresh waits up to five seconds.

Cloud super administrators can run `cld mail admin operations`:

- **JMAP possible** (`true`): the server indicates JMAP support.
- **JMAP not detected** (`false`): the server responded without indicating support.
- **JMAP unknown** (`null`): no result is available.

The JSON field is `jmap`. Failed or unfinished checks preserve the previous
result for the same IMAP host. A changed host cannot inherit that result.

`cld --json mail operator status` counts active bindings with positive hints
in `connectors.capabilities.jmap`. These hints do not verify account access
or change the mailbox's protocol.

Integration tests can project JMAP Email IDs into Mail's shared message store.
Within one remote resource, an Email ID keeps one message across folders;
different Email IDs keep separate contents. An own sent copy can reuse local
content only through an unambiguous outbox record with no other JMAP Email ID
attached in that resource. This test coverage does not enable JMAP synchronization,
body downloads, or message changes on a running mailbox.
