---
title: Outgoing mail
navTitle: Outgoing mail
section: Platform services
order: 535
description: Send application mail through operator-managed profiles and read its delivery status.
tags: [mail, smtp, permissions, services]
updated: 2026-10-08
---

# Outgoing mail

Declare `platformPermissions: ["mail:send"]`, then use `mail` from
`@k2b/cloud/services` after `app.start()` completes. Cloud owns sender profiles,
SMTP configuration, delivery, and the send log. Applications never configure
SMTP themselves.

```ts
import { defineApp } from "@k2b/cloud";
import { mail } from "@k2b/cloud/services";

export const app = defineApp({
  id: "inventory",
  name: "Inventory",
  icon: "ti ti-box",
  description: "Stock management",
  baseUrl: "http://inventory:3000",
  routes: ["/api/inventory"],
  platformPermissions: ["mail:send"],
});

// Call after app.start() completes.
const result = await mail.send({
  to: ["customer@example.org"],
  subject: "Your order",
  text: "Your order is ready.",
  ref: { scope: "order", id: "42" },
  key: "order-42-ready",
});
if (result.ok) console.log(result.data.id, result.data.status);
else console.error(result.error.code, result.error.message);
```

Identity is the application started in this process; no method accepts an
application ID. All methods return `{ ok: true, data }` or
`{ ok: false, error }`. Application grants are platform policy, not isolation
for untrusted code: applications share the database and `APP_SECRET`.

## Choose a sender

`mail.profiles()` returns the allowed profiles. Default access follows the
installation's current default. Selected access can allow several profiles;
an empty selection blocks sending. With no configured profiles, discovery
returns an empty list.

| Profile field | Meaning |
| --- | --- |
| `key`, `name`, `from` | Profile key, display name, and sender address |
| `default` | Whether this is the installation's default sender |
| `maxAttachmentBytes` | Total attachment byte limit per message |
| `quota.dailyRecipients` | Per-application rolling 24-hour recipient limit; `null` means unlimited |
| `quota.usedLast24h` | Recipients recorded for this application and profile in the last 24 hours, excluding cancelled records |

Pass `profile: "alerts"` to choose an allowed sender. Omit it to use the default;
if your application cannot use that default, pass an explicit allowed profile.
The quota check and acceptance are atomic, including concurrent sends. Failed
and queued records count toward quota; cancelled records do not. Pacing is
reserved for bulk delivery and does not affect this immediate API.

## Send a message

`mail.send(message, { signal? })` accepts these fields:

| Field | Contract |
| --- | --- |
| `to` | 1–50 email addresses |
| `subject` | At most 998 characters, without CR or LF |
| `text` | Required plain text, at most 512 KiB in UTF-8, without NUL |
| `html` | Optional HTML, at most 512 KiB in UTF-8; sanitized with Cloud's email sanitizer and sent without a frame |
| `fromName` | Optional sender display name, at most 998 characters without CR, LF, or NUL; the sender address always comes from the profile |
| `replyTo` | Optional email address |
| `profile` | Optional profile key |
| `attachments` | Optional streamed attachments, within the profile's total byte limit |
| `headers` | Optional custom headers from the allow-list below |
| `ref` | Optional `{ scope, id }` for domain lookup; not unique |
| `actor` | Optional `RequestActor`; the log keeps a type, ID, and name snapshot |
| `key` | Optional per-application idempotency key, at most 200 characters |

The sender name uses `fromName`, then the profile's name, then the registered
application name (or application ID if offline). The envelope sender is the
profile address. Acceptance fixes `Message-ID` to `<record-id@sender-domain>`;
retries retain that ID.

A failed result means no new message was recorded. Once accepted, the result
is successful even when delivery fails: inspect `data.status` and `data.error`.
`send` waits up to 30 seconds for an attempt to settle, following wakeups and
reading the durable log every two seconds. A timeout can return `queued` or
`sending`. Aborting `signal` stops only the wait; accepted mail remains queued
for delivery. Read its status with `list`.

Core retries temporary SMTP errors, connection failures, and timeouts after
one minute, doubling to at most one hour, until the 24-hour delivery deadline.
Permanent SMTP errors fail the record. If some recipients are accepted and
others rejected, status is `sent`, with the rejected recipients in `failures`.
Delivery is **at least once**: a crash after SMTP acceptance but before the log
update can send the same message again. `sent` means SMTP accepted it, not that
it reached the recipient's inbox.

### Stream attachments

Each `MailAttachment` has `filename`, `contentType`, and `content` as a
`Uint8Array`, `Blob`, or `ReadableStream<Uint8Array>`. A stream is consumed once.
Attachment filenames and content types must be non-empty, at most 998
characters each, without CR, LF, or NUL. Cloud counts bytes and computes
SHA-256 while uploading; oversized input stops
the upload. A stalled upload has a 60-second budget. An attachment is stored
outside Postgres, and the record keeps only filename, content type, byte size,
and SHA-256. Core verifies size and checksum before delivery. Missing or
changed attachments fail the record with `attachment_lost`. Terminal records
release stored attachment objects.

### Supply custom headers

Header names are case-insensitive. Allowed headers are `X-*` except
`X-Cloud-*`, `List-Id`, `List-Unsubscribe`, `List-Unsubscribe-Post`,
`In-Reply-To`, `References`, `Auto-Submitted`, and `Precedence`.
Names use printable ASCII except colon; values cannot contain CR, LF, or NUL. The complete custom header block is limited to
8 KiB in UTF-8, including names and separators. Duplicate names with different
casing are rejected. Cloud owns addressing, Message-ID, and MIME headers.

### Retry a call with an idempotency key

A known `key` returns the existing record for this application without another
send. Newly supplied stream attachments are cancelled without being read. A
concurrent loser removes its already uploaded objects and returns the winning
record. Keys live as long as their log rows: after record retention deletes a
row, the key can accept another message. Idempotency does not remove the
at-least-once SMTP caveat.

## Read application delivery status

`mail.list(filter?, page?)` returns only the calling application's records.
Filters are `ref: { scope, id? }`, `ids` (at most 100 UUIDs), `batchId`,
`status` (an array), and `since` (an ISO timestamp). Status values are `queued`,
`sending`, `sent`, `failed`, `bounced`, and `cancelled`; bounce ingestion is not
part of this API slice.

```ts
const first = await mail.list({ ref: { scope: "order", id: "42" } }, { perPage: 20 });
if (first.ok && first.data.nextCursor) {
  const next = await mail.list(
    { ref: { scope: "order", id: "42" } },
    { perPage: 20, cursor: first.data.nextCursor },
  );
  console.log(next);
}
```

Pages follow `createdAt` descending, then ID ascending, with a maximum of 100
records. Use `nextCursor` with the same filter and page size for stable
navigation even when newer rows arrive or the cursor row is deleted. The page
also retains Cloud's `items`, `page`, `perPage`, `total`, and `hasNext` fields;
`page` without a cursor uses offset paging, and `total` reflects current rows.

A `MailRecord` includes `id`, `profile`, optional `batchId` and `ref`, `to`,
`subject`, optional `text`, attachment metadata, `status`, optional `error`,
`failures: [{ recipient, reason, at }]`, `attempts`, optional `actor: { id, name }`,
`createdAt`, optional `sentAt`, and optional `contentPurgedAt`. Text disappears
after content retention; subject, recipients, actor, and attachment metadata
remain until record retention. SMTP credentials are never returned.

## Handle errors

| Acceptance error | Meaning |
| --- | --- |
| `bad_input` | Invalid addresses, message, headers, filter, or page |
| `mail_not_declared` | The application did not declare `mail:send` |
| `profile_unknown` | The requested profile does not exist |
| `profile_not_allowed` | The application cannot use the requested profile |
| `profile_required` | No usable default; choose an allowed profile explicitly |
| `quota_exceeded` | Rolling recipient quota exhausted; error includes `limit`, `used`, `requested` |
| `attachments_too_large` | Total attachment bytes exceed the profile's limit |
| `attachment_storage_full` | Attachment storage has no capacity |
| `mail_unavailable` | Application not started, no profile configured, or required storage unavailable |

Recorded delivery errors include `smtp_failed`, `attachment_lost`,
`profile_removed`, `profile_not_allowed`, and `cancelled_by_admin`.
Profile administration also uses `profile_exists`, `profile_is_default`,
`revision_conflict`, and `invalid_profile`. Admin log reads use
`message_unknown`; cancelling a non-queued row returns `message_not_queued`.

See [Outgoing mail operations](/en/docs/operations/outgoing-mail) for sender
configuration, retention, and admin log access, and
[Notifications](/en/docs/platform/notifications) for typed notifications.
