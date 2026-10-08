---
title: Outgoing mail operations
navTitle: Outgoing mail
section: Operations
order: 945
description: Configure senders, inspect the send log, and control outgoing mail retention.
tags: [mail, smtp, administration, upgrades]
updated: 2026-10-08
---

# Outgoing mail operations

Configure sender profiles in **Administration → Outgoing mail**, or use
`cld admin outgoing-mail` with an administrator account. This platform feature
is independent of the Mail application and its `cld mail` commands.

## Configure a sender

A profile has an immutable lowercase key, a display name, a sender address,
and SMTP connection settings. Keys may contain lowercase letters, digits,
and hyphens; they begin with a letter or digit and contain at most 63 characters.
A null sender name uses the registered application name for `mail.send`;
existing system notifications and test sends use the installation's `app.name`.
Profile and sender names are limited to 120 characters, sender addresses and
SMTP usernames to 320, SMTP hosts to 253, and SMTP passwords to 16384.

Save a configuration file such as `sender.json`:

```json
{
  "name": "Notifications",
  "fromAddress": "noreply@example.org",
  "fromName": null,
  "smtpHost": "smtp.example.org",
  "smtpPort": 587,
  "smtpSecure": false,
  "smtpUser": "smtp-user",
  "smtpPassword": "replace-with-your-password",
  "pacePerMinute": 60,
  "dailyRecipientLimit": null,
  "maxAttachmentBytes": 15728640
}
```

Protect files containing credentials and keep them out of Git. Submit them
through `--config-file` or `--stdin`. Inline `--config` rejects any
`smtpPassword` property, including `null`, to keep secrets out of command
arguments and shell history.

```bash
cld admin outgoing-mail profiles put noreply --config-file sender.json
cld admin outgoing-mail profiles put noreply --stdin < sender.json
cld admin outgoing-mail profiles list --json
cld admin outgoing-mail profiles get noreply --json
cld admin outgoing-mail profiles test noreply --to operator@example.org
```

A successful test returns `{ "ok": true }`. SMTP rejection returns
`smtp_failed` and the SMTP message with credentials redacted. It proves SMTP
acceptance; check the recipient inbox to verify final delivery.

For a replacement, include the current `revision` from `profiles get` and all
configuration fields. A stale revision returns `revision_conflict`; creating
an existing key without a revision returns `profile_exists`. Password omission
keeps the stored password, `null` clears it, and a string replaces it.
If a password is stored and you change the SMTP host, supply the password again
or clear it with `null`; surrounding spaces and changes in letter case do not
count as a host change.
The API and CLI return only `hasPassword`, never the password.

`--config` can submit a replacement that contains no password:

```bash
cld admin outgoing-mail profiles put noreply --config '{"name":"Notifications","fromAddress":"noreply@example.org","fromName":null,"smtpHost":"smtp.example.org","smtpPort":587,"smtpSecure":false,"smtpUser":"smtp-user","pacePerMinute":60,"dailyRecipientLimit":null,"maxAttachmentBytes":15728640,"revision":1}'
```

`smtpSecure: true` means implicit TLS, commonly on port 465. With `false`,
STARTTLS is used when the server offers it. The setting is explicit and is not
inferred from the port for profiles you create. Authentication is omitted when
`smtpUser` is null or empty.

Pacing must be 1–6000 per minute. The rolling daily recipient limit
must be at least 1 or null for unlimited. Attachment limits must be 1–26214400
bytes; the default is 15728640 bytes (15 MiB). `mail.send` enforces recipient quota and the total attachment byte limit.
Immediate sending does not use the bulk pacing setting.

## Choose the default profile

The first profile becomes default automatically. There is exactly one default
while profiles exist. Notifications, sign-in emails, and password-reset emails
use the default profile. Changing it affects subsequent sends.

```bash
cld admin outgoing-mail profiles set-default noreply --yes
cld admin outgoing-mail profiles delete old-sender --yes
```

Deleting the default returns `profile_is_default`. Choose another default
first. Deleting another profile also removes its selected application grants.

## Control application access

The application list shows whether each registered application declares
`mail:send`, along with stored policies for applications that are offline.

```bash
cld admin outgoing-mail apps list --json
cld admin outgoing-mail apps set inventory --default --yes
cld admin outgoing-mail apps set inventory --profiles noreply,alerts --yes
cld admin outgoing-mail apps set inventory --none --yes
```

- `--default` removes the stored policy and follows the current default sender.
- `--profiles` selects explicit sender keys. Unknown keys are rejected.
- `--none` stores an empty selected set, blocking the application from sending.

Choose exactly one of these modes. Applications still need to declare
`platformPermissions: ["mail:send"]`; a stored grant does not replace that
declaration. Core's notification, sign-in, and password-reset emails always use
the default profile, and Core's access cannot be changed.

## Inspect the send log

The **Send log** section in **Administration → Outgoing mail** lists app mail
newest first. Filter it by app, status, or recipient; the filters stay in the
page URL. Select an entry to see its recipients, status, attempts, SMTP answer,
rejected recipients, and attachment metadata. **Show content** loads the text
and HTML and writes an audit entry. **Cancel mail** stops a queued entry. The
CLI and admin API offer the same reads:

```bash
cld admin outgoing-mail log list --app inventory --status queued,failed --limit 20 --json
cld admin outgoing-mail log list --profile alerts --since 2026-10-01T00:00:00Z --ref order:42 --recipient @example.org --json
cld admin outgoing-mail log show <id> --json
cld admin outgoing-mail log show <id> --content --json
cld admin outgoing-mail log cancel <id> --yes
```

`list` accepts `--app`, `--profile`, comma-separated `--status`, ISO `--since`,
`--ref scope[:id]`, recipient substring `--recipient`, `--cursor`, and `--limit`
(1–100). Continue with the returned `nextCursor`. Metadata includes recipient
addresses, subject, actor snapshot, attachment names, sizes and checksums,
attempt count, delivery errors, and the SMTP response line. Metadata reads
never return text, HTML, or custom headers. Treat send-log access as sensitive.

`show --content` calls a separate audited endpoint and returns text, HTML, and
headers, or a marker that content was purged. Every such read writes
`outgoing_mail.message.read`. `cancel --yes` changes only `queued` mail to
`cancelled`, with `cancelled_by_admin`, deletes attachment objects, and writes
`outgoing_mail.message.cancel`. Other states return HTTP 409,
`message_not_queued`; unknown IDs return `message_unknown` (404).

The administrator-only routes use `Cache-Control: no-store`:

| Route under `/api/admin/core/outgoing-mail` | Result |
| --- | --- |
| `GET /messages` | Filtered metadata page; query parameters mirror the CLI flags |
| `GET /messages/:id` | One metadata record |
| `GET /messages/:id/content` | Audited content read or purge marker |
| `POST /messages/:id/cancel` | Cancel queued mail and audit the cancellation |

## Set retention

Open **Administration → Outgoing mail**, then choose **Retention** in the
**Send log** section to read and change both retention periods.

| Setting | Default | Constraint |
| --- | --- | --- |
| `outgoing_mail.content_retention_days` | 90 days | Positive whole number |
| `outgoing_mail.record_retention_days` | 365 days | Positive whole number, at least content retention |

The CLI offers the same settings:

```sh
cld admin outgoing-mail retention show --json
cld admin outgoing-mail retention set --content-days 90 --record-days 365 --yes
```

Both day flags are required for `set`. Administrators can also use
`GET /api/admin/core/outgoing-mail/retention` and
`PUT /api/admin/core/outgoing-mail/retention` with JSON
`{ "contentDays": 90, "recordDays": 365 }`. Updates through this API require
positive whole days and record retention at least as long as content retention;
they save both values together and audit the old and new values as
`outgoing_mail.retention.update`.

Core runs daily retention in batches of at most 1000 rows,
stopping after five minutes. Content retention removes text, HTML, and custom
headers and records the purge time. Record retention deletes the entire row;
subject, recipients, actor, and attachment metadata remain until then. An
idempotency key is reusable after its row is deleted. If values set through
generic settings make record retention shorter than content retention, the row
is deleted at record age, including any content that has not yet been purged.

## Plan delivery capacity and recovery

Application mail is committed to Postgres before a Sync job wakes Core. Core
runs up to eight immediate SMTP attempts concurrently per worker. SMTP egress
for `mail.send` comes from Core only; existing system notification delivery is
unchanged in this slice.

Reserve JetStream capacity for the Core-owned object store
`cloud-outgoing-mail-attachments`: **2 GiB**, plus replication overhead,
25 MiB maximum per object, and 48-hour object expiry. The settled topic
`cloud-outgoing-mail-settled` retains message-ID wakeups for five minutes with
a 2 MiB stream limit (plus its dead-letter stream and replication overhead).
The send job uses Sync's default bounded job retention. Losing a wakeup does
not remove the durable mail row.

Every 30 seconds, Core recovers attempts stuck in `sending` for more than five
minutes and resubmits due immediate rows. Temporary SMTP failures retry after
one minute, doubling to at most one hour until the 24-hour deadline. Revoked
access cancels accepted mail before its next attempt; removed profiles cancel
it with `profile_removed`. Terminal mail releases attachment objects. Failed
cleanup is retried by recovery; object expiry bounds orphan lifetime.

Delivery is at least once. A crash between SMTP acceptance and the log update
can produce duplicate delivery with the same Message-ID. A `sent` status
records SMTP acceptance, including individual recipient rejections in
`failures`; it does not prove inbox delivery. Bounce collection, bulk enqueue,
pacing, and notification migration are separate slices.

## Upgrade and rollback

On upgrade, Core imports the stored `mail.noreply.*` settings when there are
no profiles and the prior SMTP host is non-empty. The imported profile is
`noreply`, named **No-reply**, and becomes default. Its missing or invalid port
defaults to 587; port 465 selects implicit TLS. Undecryptable settings are treated
as missing and logged by key only. A missing, unreadable, or invalid host leaves
the installation unconfigured. The password ciphertext is preserved only when
it decrypts to a string in the same `APP_SECRET` encryption format; otherwise
the imported profile has no password. Repeating the migration does not
change existing profiles. An unconfigured installation remains empty.

The prior SMTP definitions, the **Mail** settings tab, and its test route are removed;
old links to that tab open **Administration → Outgoing mail**. Email templates stay
under **Email templates**. The stored
settings rows are retained and protected from legacy cleanup for one release
to permit rollback. Changes made to profiles after upgrading are invisible to
an older version, which still reads the prior settings. Check those stored
values before rolling back.

## Security and audit

Every administration route requires the admin role. Profile writes, deletion,
default changes, test sends, and application policy changes produce
`outgoing_mail.*` audit events without SMTP secrets. Profile and access
mutations commit together with their audit entries. Each application send
call also writes `outgoing_mail.send` with application, actor, profile,
recipient count, and record ID; it omits subject, body, addresses, and
attachment content.

Passwords are encrypted at rest using `APP_SECRET`, never returned by the API,
CLI, or `mail.profiles()`, and decrypted only on the platform email send path.
Keep the same `APP_SECRET` across applications and upgrades.
Application grants are platform policy, not isolation: applications share the
database and `APP_SECRET`, so only install application code you trust.
