---
title: Mail connectors
navTitle: Mail connectors
section: Operations
order: 1163
description: Check whether a mailbox server offers JMAP and which protocols Mail uses.
tags: [mail, operations, protocols]
updated: 2026-11-20
---

# Mail connectors

Mail uses IMAP for mailboxes and SMTP for sending. No mailbox uses JMAP yet.
Mail can internally apply each batch of JMAP account changes in one transaction
and load a JMAP account's session for a sync run. Only tests call these paths.

Each provider connection has an empty `jmap_origin` column for the JMAP server
an operator approves later. Mail sends credentials only to that origin and
never derives it from detection. No command sets it yet. The column is added
when Mail starts; this is a short metadata change without a table rewrite.

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
