---
title: Manage account expiry and maintenance
navTitle: Lifecycle & maintenance
section: Accounts & sign-in
order: 1087
description: Configure account lifetimes and reminders, then inspect or repair expiry dates.
tags: [accounts, administration, authentication]
updated: 2026-09-09
---

# Manage account expiry and maintenance

Set account lifetimes and expiry reminders under **Administration → Accounts &
sign-in → Registration & requests**. Review a person's expiry date and history
in **Accounts**. Use **Operations** to investigate failed maintenance or repair
expiry dates for an account category.

## Account expiry

| Setting | Default | Meaning |
| --- | --- | --- |
| `user.account.ipa_expires_days` | 365 | Lifetime for FreeIPA accounts |
| `user.account.local_user_expires_days` | 0 | Lifetime for local full accounts |
| `user.account.local_guest_expires_days` | 365 | Lifetime for local Guests |

Values are days; zero means no default expiry. Inspect the actual account date
in Accounts rather than assuming a changed default has rewritten every account.
FreeIPA synchronization also mirrors directory expiry.

An expired account loses access to Cloud, including through its sessions and
personal API credentials.
For FreeIPA accounts, also review the configured
[account transition policy](/en/docs/operations/freeipa#account-matching-and-transitions).
Do not confuse an account's lifetime with **Session Expiry Hours**
(`user.session.expiry_hours`, default 8) under **Sign-in**.

## Reminders and cleanup

| Setting | Default | Meaning |
| --- | --- | --- |
| `user.account.reminder_days` | 30, 7 | Send expiry reminders this many days before the date |
| `user.account.reminder_cron` | `0 9 * * *` | Run the reminder check at 09:00 in the Cloud timezone |
| `user.account.deleted_accounts_retention_days` | 365 | Keep deleted-account history for this many days |
| `user.account.reminder_history_retention_days` | 365 | Keep reminder history for this many days |

Zero retention means keep history indefinitely, not delete it immediately.
Reminder delivery requires working email configuration.
Global cleanup scheduling uses **General** settings.

## Inspect activity

Open **Administration → Accounts & sign-in → Operations**.
Its links open account lifecycle logs, FreeIPA sync logs and scheduled jobs
with the relevant filters already selected. Adjust the time window when
looking for an older run. Use individual account history for record-specific changes.

## Repair expiry dates

These actions can extend expired accounts and restore access.
They do not assign Linux identities or create home directories.

1. Review the intended account lifetime and affected category.
2. In **Operations → Repair account expiry dates**, choose FreeIPA, local full
   accounts or local Guests.
3. Read the confirmation before starting.
4. Follow the log link after the job is queued. A success toast confirms
   submission, not completion.

Maintenance fills missing or premature expiry dates. Its target is never less
than seven days from the run's calculation time, even when the configured
lifetime is zero. A later FreeIPA expiry is not shortened.
Use [Linux identity backfill](/en/docs/operations/linux-identities#backfill-existing-accounts)
for missing UID/GID attributes instead.

For interrupted FreeIPA maintenance and upgrade procedures, see
[FreeIPA recovery](/en/docs/reference/freeipa-recovery).
