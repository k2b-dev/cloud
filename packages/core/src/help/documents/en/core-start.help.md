---
id: core-start
title: Start
icon: ti ti-cloud
description: Find your profile, the administration overview, announcements, settings, sign-in, and legal pages.
order: 100
---

Core provides the platform pages and shared services: sign-in, profile self-service, notifications, the administration overview, global settings, announcements, legal pages, search APIs, and the fallback page for unknown addresses. Help is available on the profile, notifications, legal, and administration overview pages before you select a setting or a record.

## Know the Core pages {icon="layout-grid"}

:::reference
- **Profile:** The `/me` page shows your profile, provider, roles, groups, expiry dates, API keys, passkeys, and recent account activity.
- **Overview:** In the administration, the `/admin` page lists the apps with administration pages. It also counts the registered apps, the administration pages, and the navigation entries.
- **Announcements:** Administrators create platform announcements and dismissible banners. Each entry has a publish time, an optional expiry time, a state, and a version.
- **Settings:** The Core settings cover branding, user lifecycle, FreeIPA, AI, mail, PDF rendering, email templates, security, and legal pages.
:::

## Find the right page {icon="route"}

:::reference
- **Check your account:** Open your profile. It shows your account type, provider, roles, groups, expiry dates, profile fields, API keys, passkeys, and recent account events.
- **Find an administration page:** Open the administration overview. It links to the administration pages of the apps, such as Gateway Ops, Accounts, IPA Hosts, or app settings.
- **Publish a notice:** Use **Announcements** for platform messages or banners in the shared layout.
- **Change platform defaults:** Use the Core settings for the global service configuration. Each setting comes from the database, the environment, or its default.
:::

:::info Apps keep their own administration
Core provides the platform pages and shared services. Administration tasks of an app stay in that app, even when the Core administration overview lists them.
:::
