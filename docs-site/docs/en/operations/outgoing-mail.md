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
A null sender name uses the registered application name. Mail sent as app `core`
(notifications, magic links, password resets, and notification batches) and
profile test sends use the installation's `app.name`.
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
`smtpPassword` or `imap.password` property, including `null`, to keep secrets out of command
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
bytes; the default is 15728640 bytes (15 MiB). Both mail APIs enforce recipient quota and the total attachment byte limit.
Immediate sending does not use the bulk pacing setting.

## Collect delivery reports

In **Administration → Outgoing mail**, edit a profile and fill in the
**Bounces** section with the IMAP mailbox that receives its delivery reports.
Leave the host empty to turn collection off. With **Implicit TLS** off, Cloud
requires STARTTLS. The profile list shows when the mailbox was last checked or
why the latest check failed, on phones as well as on wide screens.

From the CLI, add an optional `imap` object to the profile configuration
through `profiles put`. For example, include this block in `sender.json`:

```json
{
  "imap": {
    "host": "imap.example.org",
    "port": 993,
    "secure": true,
    "user": "noreply@example.org",
    "password": "replace-with-your-password",
    "folder": "INBOX"
  }
}
```

Supply every connection field, including `folder`; use `"INBOX"` for the inbox.
Hosts follow the SMTP hostname constraints, ports must be 1–65535, usernames
1–320 characters, and folders 1–200 characters without control characters.
User and folder values are trimmed; whitespace-only values are rejected.
`secure: true` uses implicit TLS; `false` requires STARTTLS before authentication.
Hosts may be DNS names or IP addresses; the server certificate must cover the
configured host.
The IMAP password follows the SMTP rules: omission keeps it, `null` clears it,
and changing the host requires entering it again or clearing it. Submit
passwords only through `--config-file` or `--stdin`. Responses expose
`imap.hasPassword`, never the password.

Prefer a dedicated bounce mailbox. SMTP uses the profile's `fromAddress` as
the envelope sender, so delivery reports return to that address; route them
into the configured folder. Core needs outbound access to this IMAP server;
other applications need no IMAP egress for platform bounce collection.

Core polls enabled profiles every five minutes, one after another, within a
four-minute processing budget, with at most another 30 seconds to record an
interrupted check. Profiles left over wait for the next tick. Each profile
processes at most 200 messages, oldest UID first. The first run and a change of
mailbox UIDVALIDITY restart from the last seven days; subsequent runs read UIDs
strictly above the stored cursor. Changing the IMAP host, port, user, or folder
resets that cursor and the check status. Servers without ESEARCH are searched
in bounded UID windows; empty windows advance the cursor so later polls continue.
An interrupted or failed run keeps progress through the last fully processed UID.
Setting `imap` to `null` or omitting it on replacement turns collection off and clears its cursor and check status.

Polling opens the folder read-only and fetches parts without marking mail as
read. It never moves, deletes, or expunges messages. Only standard RFC 3464
`multipart/report; report-type=delivery-status` messages with the
stored Cloud Message-ID are processed. Matching is case-insensitive and uses
the Message-ID fixed at acceptance, so later sender-domain changes do not matter.
Core fetches only the delivery status and original headers, each limited to 64 KiB; oversized parts
are skipped, and returned original bodies and attachments are never downloaded.
`Action: failed` adds recipients and reasons to the send log and changes `sent`
to `bounced` only when Final-Recipient, or otherwise Original-Recipient, matches
one of the message's recipients case-insensitively. Failures keep the stored
recipient spelling; unrelated recipients are ignored. Repeated reports do not
duplicate the same recipient and reason; a record holds at most 100 failures. Delayed and non-standard bounces are
ignored. No bounce does not prove delivery.

If reading a message fails, Core retries it once on a new connection. A second
read failure skips that UID, logs a warning with the profile key and UID, and
continues on another connection. Reconnection failures or a changed UIDVALIDITY
stop the check; database failures are never skipped.

`profiles list` and `profiles get` show the IMAP host and folder plus the latest
check time, error, or `off`. JSON exposes `imap` and `bounces: { checkedAt,
error }`; both are null when disabled. A new mailbox is `pending` until its
first check. Errors are stable codes, cleared by a successful check:

| Code | What to check |
| --- | --- |
| `open_failed` | Credentials, folder, TLS certificate, required STARTTLS, Core's IMAP egress, or a UIDVALIDITY change during reconnection |
| `search_failed` | IMAP server availability and UID search support |
| `apply_failed` | Database availability while recording a report |
| `save_failed` | Database availability while saving progress and check status |
| `interrupted` | Core shutdown or the four-minute budget; collection resumes from saved progress on the next tick |

After resolving an error, wait for the next poll. If the database cannot save
check status, inspect Core's logs; the displayed status may still be older.

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
Queued mail of a deleted profile is cancelled with `profile_removed`: bulk
rows by the next 30-second recovery scan, immediate rows before their next attempt.

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

### Move an application's SMTP account

Coordinate this switch with the application author. They replace their SMTP
transport with the [application mail API](/en/docs/platform/outgoing-mail#move-from-an-application-owned-smtp-account)
and declare `platformPermissions: ["mail:send"]`.

1. Create a dedicated sender profile using the app's former SMTP credentials.
   Follow [Configure a sender](#configure-a-sender) for the complete JSON shape
   and protect the configuration file containing the password.
2. Test the profile and check the recipient inbox. Assign it to the application.

   ```bash
   cld admin outgoing-mail profiles put inventory --config-file inventory-sender.json
   cld admin outgoing-mail profiles test inventory --to operator@example.org
   cld admin outgoing-mail apps set inventory --profiles inventory --yes
   ```

3. Have the updated app pass `profile: "inventory"` explicitly unless that
   profile is also the installation default. Verify an application send in
   **Administration → Outgoing mail**, under **Send log**. Then remove the old
   SMTP secret and settings from the application's deployment.

## Inspect the send log

The **Send log** section in **Administration → Outgoing mail** lists app mail
newest first. Filter it by app, status, or recipient; the filters stay in the
page URL. Select an entry to see its recipients, status, attempts, SMTP answer,
rejected recipients, and attachment metadata. **Show content** loads the text
and HTML and writes an audit entry. **Cancel mail** stops a queued entry. An
entry sent with `mail.enqueue` also shows its batch ID and **Cancel batch**.
The action stops the batch's still-queued mail whatever the state of the opened
entry. The CLI and admin API offer the same reads:

```bash
cld admin outgoing-mail log list --app inventory --status queued,failed --limit 20 --json
cld admin outgoing-mail log list --profile alerts --since 2026-10-01T00:00:00Z --ref order:42 --recipient @example.org --json
cld admin outgoing-mail log show <id> --json
cld admin outgoing-mail log show <id> --content --json
cld admin outgoing-mail log cancel <id> --yes
cld admin outgoing-mail log cancel --batch <batchId> --yes
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

`log cancel` takes exactly one message ID or `--batch <batchId>`, with `--yes`. A batch cancellation changes all
still-queued members to `cancelled`, deletes their stored attachments, publishes
their settled status, and writes one `outgoing_mail.batch.cancel` audit entry
with application IDs and the cancelled count. Sent rows stay sent; rows already
`sending` finish normally. The response is `{ batchId, cancelled }`, including
zero when no queued rows remain. Unknown batches return `batch_unknown` (404).

The administrator-only routes use `Cache-Control: no-store`:

| Route under `/api/admin/core/outgoing-mail` | Result |
| --- | --- |
| `GET /messages` | Filtered metadata page; query parameters mirror the CLI flags |
| `GET /messages/:id` | One metadata record |
| `GET /messages/:id/content` | Audited content read or purge marker |
| `POST /messages/:id/cancel` | Cancel queued mail and audit the cancellation |
| `POST /batches/:batchId/cancel` | Cancel queued batch members and audit once |

## Set retention

Open **Administration → Outgoing mail**, then choose **Retention** in the
**Send log** section to read and change both retention periods.

| Setting | Default | Constraint |
| --- | --- | --- |
| `outgoing_mail.content_retention_days` | 90 days | Whole days from 1 to 36500 |
| `outgoing_mail.record_retention_days` | 365 days | Whole days from 1 to 36500, at least content retention |

The CLI offers the same settings:

```sh
cld admin outgoing-mail retention show --json
cld admin outgoing-mail retention set --content-days 90 --record-days 365 --yes
```

Both day flags are required for `set`. Administrators can also use
`GET /api/admin/core/outgoing-mail/retention` and
`PUT /api/admin/core/outgoing-mail/retention` with JSON
`{ "contentDays": 90, "recordDays": 365 }`. Updates through this API require
whole days from 1 to 36500 and record retention at least as long as content
retention; they save both values together and audit the old and new values as
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
for application mail and notification email comes from Core only. Notifications
and notification batches appear in the send log as app `core`; the direct-SMTP
notification path has been removed.

Notification batches use the default profile's bulk lane and pace. They respect
that profile's daily recipient limit for app `core` and continue as the rolling
24-hour window frees capacity. Core's magic links, password resets, and other
notification email share that limit: leave headroom or keep the default profile
unlimited. Tune that profile's `pacePerMinute` to the provider's limit.
Individual notifications use the immediate lane, retain their HTML frame, and
stay pending during temporary SMTP failures without spending notification attempts.

`mail.enqueue` uses the bulk lane. `pacePerMinute` (`pace_per_minute` in
Postgres) spaces bulk attempts for one profile across all applications and Core
replicas. The atomic profile slot gate prevents two drainers from reserving the
same slot; message claims also lock and skip rows already claimed elsewhere.
Core runs four profile drainers per worker. Sync coalesces queued or running
jobs by `profile:<id>`; PostgreSQL still protects slots and rows if a stale run
is redelivered. A run stops claiming new rows after 60 seconds and lets its
current SMTP attempt finish within its own 60-second timeout; shutdown can
abort that attempt. Core heartbeats the Sync job after each attempt. A closed
gate returns a continuation delayed until the next slot or due retry, capped
at the 30-second recovery interval so fresh mail does not join a long backoff.
Due retries and fresh mail go out in due-time order.
Reserving an idle slot consumes that slot; the next attempt may wait one
pacing interval.

The queue limit for a profile is `pacePerMinute × 1440` queued bulk messages.
An enqueue that would exceed it is rejected whole with `backlog_full` (409).
This is nominal admission capacity, not a delivery promise. One drainer sends
a profile's bulk mail one message at a time and opens a new SMTP connection
per message. Connection setup and SMTP round trips bound real throughput;
a pace above that does not speed delivery. Mail that cannot be sent before
its 24-hour deadline fails. Choose a pace the provider and this sequential
sender can sustain. Batch uploads run sequentially within one shared
60-second upload budget.

Reserve JetStream storage for the Core-owned object store
`cloud-outgoing-mail-attachments`: **2 GiB** on every node that holds one of
its replicas, 25 MiB maximum per object, and 48-hour object expiry. Bulk mail
keeps its attachment objects until its attempt, so large paced batches with
attachments can fill the shared store for hours. While it is full, every
application's sends and enqueues with attachments fail with
`attachment_storage_full`. The store limit is fixed, so send links instead of
large attachments in bulk mail.

The settled topic `cloud-outgoing-mail-settled` retains message-ID wakeups for
five minutes with a 2 MiB stream limit; with its dead-letter stream it reserves
4 MiB. The jobs `cloud-outgoing-mail-send` and `cloud-outgoing-mail-drain` use
Sync's default bounded job retention, 66 MiB each. Together, outgoing mail adds
about 2.1 GiB to Core's reservation per replica; see
[Reserve JetStream storage](/en/docs/operations/deployment-requirements#reserve-jetstream-storage).
Losing a wakeup does not remove the durable mail row.

Every 30 seconds, Core recovers attempts stuck in `sending` for more than five
minutes in both lanes and resubmits due immediate rows and bulk profile drains.
Recovery cancels queued bulk mail of removed profiles with `profile_removed`
and fails expired queued bulk mail with its last answer, without using a pacing
slot. Immediate mail of removed profiles is cancelled before its next attempt.
Temporary SMTP failures retry after one minute, doubling to at most one hour
until the 24-hour deadline. Revoked access cancels accepted mail before its
next attempt. Dropping the `mail:send` declaration cancels accepted mail of a
registered app before its next attempt with `profile_not_allowed`, in both lanes.
Temporary absence from the registry does not cancel mail.
Terminal mail releases attachment objects. Failed cleanup is retried by
recovery; object expiry bounds orphan lifetime.

Delivery is at least once. A crash between SMTP acceptance and the log update
can produce duplicate delivery with the same Message-ID. A `sent` status
records SMTP acceptance, including individual recipient rejections in
`failures`; it does not prove inbox delivery. Optional IMAP collection can later
mark the record `bounced` when a standard delivery report identifies failed
recipients.

## Upgrade and rollback

Core adds nullable IMAP configuration and cursor columns automatically during
setup. Existing profiles keep bounce collection off. Enable it explicitly with
`profiles put` and allow IMAP egress from Core only when needed. Rolling back
stops collection; keep the additive columns and previously collected records.

This upgrade activates the bulk lane and adds an index on message `batch_id`
and two partial indexes for queued bulk mail: `outgoing_mail_messages_bulk_due`
for profile due-time order and `outgoing_mail_messages_bulk_deadline` for expiry.
Existing profile pacing settings now control `mail.enqueue` delivery. Core
must run this version to process bulk rows. Before rolling back to a version
without the drainer, stop accepting new bulk mail and finish or cancel its
queued batches; older Core workers cannot deliver that lane. No new
configuration variables are required.

Since 0.34.0, outgoing mail adds about 2.1 GiB to Core's JetStream reservation
on every NATS node that holds its replicas. Before you upgrade from an older
release, make sure `max_file_store` on every node fits Core's new total; see
[Reserve JetStream storage](/en/docs/operations/deployment-requirements#reserve-jetstream-storage).
Otherwise NATS refuses the new streams with
`insufficient storage resources available`, and Core does not start.

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
attachment content. The entry for an accepted message commits together with
the message. Each enqueue call writes one `outgoing_mail.send` entry for the
batch with profiles, actors, message count and IDs; acceptance and its audit
commit together. Denied calls also audit once without content. Batch
cancellations use `outgoing_mail.batch.cancel`.

Passwords are encrypted at rest using `APP_SECRET`, never returned by the API,
CLI, or `mail.profiles()`. SMTP credentials are decrypted only on the platform
email send path; IMAP credentials only in Core's bounce poller.
Keep the same `APP_SECRET` across applications and upgrades.
Application grants are platform policy, not isolation: applications share the
database and `APP_SECRET`, so only install application code you trust.
