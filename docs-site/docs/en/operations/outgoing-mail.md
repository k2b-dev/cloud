---
title: Outgoing mail operations
navTitle: Outgoing mail
section: Operations
order: 945
description: Configure SMTP sender profiles, choose a default, and control application access.
tags: [mail, smtp, administration, upgrades]
updated: 2026-10-07
---

# Outgoing mail operations

Configure sender profiles in **Administration → Outgoing mail**, or use
`cld admin outgoing-mail` with an administrator account. This platform feature
is independent of the Mail application and its `cld mail` commands.

## Configure a sender

A profile has an immutable lowercase key, a display name, a sender address,
and SMTP connection settings. Keys may contain lowercase letters, digits,
and hyphens; they begin with a letter or digit and contain at most 63 characters.
A null sender name uses the installation's `app.name` when sending.
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
bytes; the default is 15728640 bytes (15 MiB). These limits are stored for
policy administration; this release does not enforce them during delivery.

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
mutations commit together with their audit entries.

Passwords are encrypted at rest using `APP_SECRET`, never returned by the API,
CLI, or `mail.profiles()`, and decrypted only on the platform email send path.
Keep the same `APP_SECRET` across applications and upgrades.
Application grants are platform policy, not isolation: applications share the
database and `APP_SECRET`, so only install application code you trust.
