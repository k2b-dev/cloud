---
title: Core
navTitle: Core
section: Platform
order: 300
description: Sign-in, profile, notifications, announcements, settings, and the shared Cloud administration entry point.
tags: [core, accounts, administration]
updated: 2026-09-11
---

# Core

Core is the shared account and administration surface of Cloud. People use it
to sign in, manage their own profile and credentials, review notifications,
and find platform-level Help. Administrators use it for announcements, global
settings, legal pages, and links into the admin surfaces owned by other apps.

## Use Core

Sign-in distinguishes **Guest**, passwordless local **Login** (with an
operator-defined label), and **FreeIPA**. Configure access independently from
login visibility in **Accounts & sign-in**. See
[Account types](/en/docs/operations/account-categories) for examples and recovery.

- Sign in with the method configured for your account and recover access when
  password recovery is available.
- Review your profile, account provider, roles, groups, expiry, and recent
  account activity.
- Manage personal API keys, passkeys and paired sign-in devices, then revoke credentials you no longer
  use.
- Read notification history and choose the delivery preferences available to
  your account.
- Publish platform announcements or change global settings when you are an
  administrator.

## Understand the Core model

| Resource or surface | Responsibility |
| --- | --- |
| Account session | The signed-in browser session and its account identity |
| Profile and credentials | Self-service profile fields, paired sign-in devices, passkeys and personal API keys |
| Notification history | One place to review account and application events |
| Announcement | A platform message or dismissible banner with publication timing |
| Global setting and legal page | Platform-wide configuration and published legal content |
| Admin overview | Links to Core and app-specific administration surfaces |

Core's admin overview is a directory, not a second owner for every setting.
For example, OAuth clients and individual account records stay in their
respective apps. Installation-wide account and sign-in policies belong in
Core Administration.

## How Core fits Cloud

Core owns Cloud's top-level account experience, login and recovery pages,
shared notifications, platform settings, announcements, legal pages, and the
fallback for unmatched routes. Business applications continue to own their
records, permissions, APIs, and app-specific administration.

## Find detailed product help

Open **Help** from Core for profile self-service, sign-in and security,
notifications, and administration. Developers can read
[Request identity](/en/docs/identity/authentication),
[Application settings](/en/docs/platform/settings), and
[Notifications](/en/docs/platform/notifications) for the shared contracts
behind those surfaces.

## Inspect Core from the terminal

Core does not use a separate `cld core` module. Account self-service and
platform administration are grouped by task:

```bash
cld account whoami --json
cld admin apps list --json
cld admin legal list
cld admin legal get terms --json
```

Run `cld account help` for personal account commands and `cld admin help` for
administration commands. Administrators can publish local Markdown or an
external URL with `cld admin legal set`, and reset one complete document with
`cld admin legal reset <document> --yes`. These commands use the current
profile and the same authorization boundaries as the browser surfaces.

## Deployment requirements

See [Deployment requirements](/en/docs/operations/deployment-requirements) for
this app’s startup prerequisites, optional integrations, configuration and
functional checks.

## Refresh cached administration data

Global settings, app-bar shortcuts, and announcements have separate cache
controls on their existing administration pages. Clearing a cache reloads data
on the next request and shows a success toast. It does not change stored data.

On **Announcements**, the shared snapshot lasts up to five minutes. Publication
and expiry times are evaluated on each page request, and each user's dismissed
or seen state is applied separately. Creating, editing, or deleting an
announcement invalidates the snapshot. Reload an already open page to see the
change. If cache invalidation fails during a Valkey outage, the database change
still succeeds and old cached entries expire within their TTL.

The announcement action uses `DELETE /api/admin/core/announcements/cache` with
administrator checks in both the route and service. Settings has its own
control under **Settings → General**. App-bar invalidation remains on
**App bar**. None of these actions flushes Valkey or clears sessions, signing
keys, access state, rate limits, or other application caches.
