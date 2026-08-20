---
id: core-admin
title: Admin
icon: ti ti-settings
description: Admin overview, announcement lifecycle, and Core settings groups.
order: 120
---

Core admin pages configure platform services and link to app-specific admin panels registered by each app.

## Admin pages {icon="user-cog"}

:::reference
- **Overview:** Lists registered apps with admin panels and summarizes registered apps, manageable admin panels, and user-visible navigation entries.
- **Announcements:** Create and edit announcements or banners. Entries can be active, scheduled, or expired based on publish and expiry timestamps.
- **Settings:** Edit settings by group. Each field shows its current value and source where the settings service exposes it.
:::

## Settings groups {icon="settings"}

:::reference
- **General and user management:** Branding, public links, schedules, defaults, login behavior, expiry, reminders, and self-service behavior.
- **FreeIPA:** FreeIPA connection settings, sync rules, and group mapping.
- **AI:** Configure model profiles and provider credentials, inspect background work, and use **Skills** or **Projects** to restore access when a shared resource no longer has an administrator. These recovery pages can grant permissions or permanently delete obsolete resources, including Skills initially provided by Cloud.
- **Mail and PDF rendering:** Configure SMTP delivery, sender credentials, Gotenberg connection, credentials, and render limits.
- **Templates, security, and legal:** Transactional email templates, rate limits, access protection defaults, Terms of Service, Privacy Policy, and Imprint.
:::
