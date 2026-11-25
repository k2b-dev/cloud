---
title: Mail interface v2 pilot
navTitle: Mail v2 pilot
section: Operations
order: 1203
description: A Mail administrator setting that shows the mailbox in the new interface to listed people only.
tags: [mail, upgrade, settings]
updated: 2026-11-23
---

# Mail interface v2 pilot

This release adds the Mail administrator setting **UI v2 pilot**
(`mail.ui_v2_pilot`). It lists the email addresses of the people who see the
mailbox page in the new interface, built with `@k2b/ui/v2`. Everyone else keeps
the current interface. `*` shows the new interface to everyone, for example in
a development installation.

The list starts empty, so nothing changes after the upgrade. The setting is
provisional: once the new interface is accepted, it becomes Mail's only
interface and the setting is removed again.

The pilot shows the same mailboxes, data, and permissions; only the drawing of
the list, the reader, and the reply differs. Compose pages, settings, and the
other Mail pages stay as they are.

Set the list on `/admin/mail`, or with `cld`:

```bash
cld admin settings set mail.ui_v2_pilot --app mail \
  --value '["person@example.com"]' --yes
```

No database migration or other operator action is required.
