---
id: core-admin
title: Admin
icon: ti ti-settings
description: Admin overview, announcement lifecycle, and Core settings groups.
order: 120
---

Core admin pages configure platform services and link to app-specific admin panels registered by each app.

Account settings offer **Documentation** links to the relevant English guide in
a new tab. Under **General**, **Documentation website** selects the public docs,
a self-hosted mirror or your local Fibel server. This changes help links only;
it does not configure app sign-in. The built-in Help reader stays independent.

## Admin pages {icon="user-cog"}

:::reference
- **Overview:** Lists registered apps with admin panels and summarizes registered apps, manageable admin panels, and user-visible navigation entries.
- **Announcements:** Create and edit announcements or banners. Entries can be active, scheduled, or expired based on publish and expiry timestamps.
- **Settings:** Edit settings by group. Each field shows its current value and source where the settings service exposes it.
:::

## Settings groups {icon="settings"}

In **Accounts & sign-in → Sign-in**, configure **Guest**, passwordless local **Login** and
**FreeIPA** separately. Rename Login, for example to **Company account**.
**Allowed** controls access; **Show in login** only controls the general login
page. A hidden, allowed account can still use direct links. One visible type
opens its form without a selector. Guest self-registration stays separate.

Disabling a type denies subsequent requests from existing sessions,
user OAuth tokens, personal API keys and user-backed background work. It does
not delete accounts or stop FreeIPA sync. Re-enabling restores otherwise-valid
credentials. Keep another allowed admin or your emergency token available
before disabling your own type. Emergency recovery explicitly re-enables all
local Login accounts without changing login visibility.

:::reference
- **General:** Branding, public links and global schedules.
- **Registration & requests:** Configure Guest self-registration, FreeIPA access requests, account defaults, expiry and reminders. New installations require opt-in for requests; upgrades preserve existing behavior. Disabling new requests leaves pending requests available for processing.
- **Follow-up notices:** In Registration & requests, configure an optional Liquid-Markdown notice after successful user or group changes. Use `action` to select relevant instructions and preview sample data. Empty output adds no notice. These are instructions for the administrator or group manager, not a notification sent to the user. No NFS instructions are built in.
- **Operations:** Open filtered lifecycle and FreeIPA sync logs or scheduled jobs. Maintenance repairs account expiry dates, not Linux identities, and can restore access for expired accounts. A toast confirms the job was queued; check its logs for completion. Individual records and request processing stay in Accounts.
- **Linux identities:** Reserve an ID range and configure home and shell defaults. While enabled, new local full accounts and promoted guests receive Linux attributes automatically. Use **Backfill existing accounts** for older full accounts; enabling the feature does not change them. Disabling assignment hides the backfill table and retains existing identities in Accounts. This does not enable computer login or sudo.
- **FreeIPA:** FreeIPA connection settings, sync rules, and group mapping.
- **AI:** Configure model profiles and provider credentials, inspect background work, and use **Skills** or **Projects** to restore access when a shared resource no longer has an administrator. These recovery pages can grant permissions or permanently delete obsolete resources, including Skills initially provided by Cloud.
- **Mail and PDF rendering:** Configure SMTP delivery, sender credentials, Gotenberg connection, credentials, and render limits.
- **Templates, security, and legal:** Transactional email templates, rate limits, access protection defaults, Terms of Service, Privacy Policy, and Imprint.
:::
