---
title: Show notices after account changes
navTitle: Follow-up notices
section: Accounts & sign-in
order: 1088
description: Add optional instructions for the person completing an account or group change.
tags: [accounts, administration, authentication]
updated: 2026-09-09
---

# Show notices after account changes

Use a follow-up notice when an account or group change requires a manual step,
such as arranging access in another system. Leave it empty when there is nothing
else to do.

Edit **Notice after account or group changes** under
**Administration → Accounts & sign-in → Registration & requests**.
The Liquid-Markdown template is empty by default. An empty template or empty
result adds no notice. The editor offers sample data and a rendered preview;
unknown variables and invalid Liquid are rejected on save through both GUI and CLI.

Use `action` to show instructions only when they are relevant:

```liquid
{% if action == "user.create" and category == "freeipa" %}
Confirm workstation setup with {{ uid }} before handing over access.
{% elsif action == "group.delete" %}
Review shared-folder permissions for {{ name }}.
{% endif %}
```

Notices appear after successful changes in Accounts. They are for the person
performing the action, not an email or notification to the affected user.
Administrators can receive user and group notices; group managers receive group
notices. A notice failure does not undo the change or report the change itself
as failed. There is no automatic command execution or storage provisioning.

Supported actions are:

| Area | `action` values |
| --- | --- |
| Users | `user.create`, `user.update`, `user.delete`, `user.profile`, `user.admin`, `user.provider`, `user.expiry`, `user.password_reset`, `user.login_token`, `user.linux` |
| Groups | `group.create`, `group.update`, `group.delete`, `group.posix` |
| Membership and management | `group.member.add`, `group.member.remove`, `group.manager.add`, `group.manager.remove` |

The template can use `action`, `id`, `uid`, `name`, `email`,
`firstName`, `lastName`, `provider`, `profile`, `category` and `relatedId`.
User actions provide person and category fields; group actions provide the name
and provider. Existing records supply their current display data; deleted records
use the action's snapshot. Fields that do not apply are empty strings.
`id` identifies the changed account or group; membership actions put
the added or removed principal's ID in `relatedId`. Provider values are `local`
and `ipa`; profiles are `guest` and `user`; categories are `guest`, `login` and
`freeipa`. Interpolated values are escaped as Markdown text, including when the
template uses Liquid's `raw` filter. Do not treat the
notice as an audit record or a shell-command generator. Passwords, tokens and
other credentials are never included in this context.

Avatar changes, notification sending, background jobs and changes made outside
the Accounts UI do not open follow-up dialogs.

## Save from the terminal

Use [the account administration CLI](/en/docs/accounts/registration#use-the-cli).
Read the current configuration first so you preserve the account-request policy.
