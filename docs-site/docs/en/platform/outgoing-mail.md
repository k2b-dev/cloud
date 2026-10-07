---
title: Outgoing mail
navTitle: Outgoing mail
section: Platform services
order: 535
description: Discover the outgoing mail sender profiles available to your application.
tags: [mail, smtp, permissions, services]
updated: 2026-10-07
---

# Outgoing mail

Cloud owns outgoing mail sender profiles and their SMTP configuration.
Applications declare their need for mail and read the profiles the operator
allows them to use. Configure senders through Cloud rather than app-owned SMTP.

## Declare mail access

Add `platformPermissions` to your application declaration:

```ts
import { defineApp } from "@k2b/cloud";

export const app = defineApp({
  id: "inventory",
  name: "Inventory",
  icon: "ti ti-box",
  description: "Stock management",
  baseUrl: "http://inventory:3000",
  routes: ["/api/inventory"],
  platformPermissions: ["mail:send"],
});
```

The declaration is visible to administrators. It does not select a sender.
The operator's access policy determines which profiles your application sees.

## Read available profiles

Call `mail.profiles()` on the server after `app.start()` completes:

```ts
import { mail } from "@k2b/cloud/services";

const result = await mail.profiles();
if (result.ok) {
  for (const profile of result.data) {
    console.log(profile.key, profile.from, profile.default);
  }
} else {
  console.error(result.error.code, result.error.message);
}
```

Identity comes from the application started in this process; the method takes
no application ID. Its result follows Cloud's `{ ok, data }` or
`{ ok: false, error }` service convention.

| Profile field | Meaning |
| --- | --- |
| `key`, `name` | Stable sender key and display name |
| `from` | Sender email address |
| `default` | Whether this is the installation's default sender |
| `maxAttachmentBytes` | Configured attachment size limit |
| `quota.dailyRecipients` | Configured per-application rolling 24-hour limit; `null` means unlimited |
| `quota.usedLast24h` | Currently `0` |

Pacing, recipient limits, and attachment limits are stored configuration;
`profiles()` reports them without enforcing sending limits. The result never
includes SMTP hosts, usernames, or passwords.

## Understand profile access

Applications use the current default profile unless the operator selects a
specific set of profiles. A selected set can contain several senders or be
empty. An empty set means the application may not send. If no sender exists,
default access returns an empty list too.

| Error code | Meaning |
| --- | --- |
| `mail_not_declared` | The application did not declare `mail:send` |
| `mail_unavailable` | Startup has not bound the process identity, or profile storage is unavailable |

Grants are platform policy. Applications share the database and `APP_SECRET`,
so these grants do not isolate untrusted application code. SMTP passwords are
encrypted at rest using `APP_SECRET`, never returned by the API, CLI, or
`mail.profiles()`, and decrypted only on the platform email send path.

See [Outgoing mail operations](/en/docs/operations/outgoing-mail) for sender
configuration and [Notifications](/en/docs/platform/notifications) for typed
notification delivery.
