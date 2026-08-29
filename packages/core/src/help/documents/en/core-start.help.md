---
id: core-start
title: Start
icon: ti ti-cloud
description: Profile self-service, platform admin overview, announcements, settings, auth, and legal pages.
order: 100
---

Core owns platform-level pages and services: login, profile self-service, notifications, admin overview, global settings, announcements, legal pages, search APIs, and top-level routing fallback. Help is available from the profile, notifications, legal, and admin overview pages before you select a specific setting or record.

## Overview {icon="layout-grid"}

:::reference
- **Profile:** The /me page shows the signed-in user's profile, provider, roles, groups, expiry data, API keys, passkeys, and recent account activity.
- **Admin overview:** The /admin page lists apps with admin panels and summarizes registered apps, admin panels, and navigation entries.
- **Announcements:** Admins can create platform announcements and dismissible banners with publish, expiry, state, and version metadata.
- **Settings:** Core settings cover branding, user lifecycle, FreeIPA, AI, mail, PDF rendering, email templates, security, and legal pages.
:::

## Common paths {icon="route"}

:::reference
- **Check your account:** Open Profile to review account type, provider, roles, groups, expiry dates, profile fields, API keys, passkeys, and recent account events.
- **Find an admin surface:** Open Admin Overview to jump to app-specific admin panels such as Gateway Ops, Accounts, IPA Hosts, or app settings.
- **Publish a notice:** Use Announcements for platform messages or banners that should render through the shared layout.
- **Change platform defaults:** Use Core Settings for global service configuration. Settings resolve from database, environment, and defaults.
:::

:::info Boundary
Core owns platform pages and shared services. App-specific admin workflows stay in the owning app, even when they appear in the Core admin overview.
:::
