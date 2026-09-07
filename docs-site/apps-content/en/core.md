---
title: Core
navTitle: Core
section: Platform
order: 300
description: Sign-in, profile, notifications, announcements, settings, and the shared Cloud administration entry point.
tags: [core, accounts, administration]
updated: 2026-09-07
---

# Core

Core is the shared account and administration surface of Cloud. People use it
to sign in, manage their own profile and credentials, review notifications,
and find platform-level Help. Administrators use it for announcements, global
settings, legal pages, and links into the admin surfaces owned by other apps.

## Use Core

- Sign in with the method configured for your account and recover access when
  password recovery is available.
- Review your profile, account provider, roles, groups, expiry, and recent
  account activity.
- Manage personal API keys and passkeys, then revoke credentials you no longer
  use.
- Read notification history and choose the delivery preferences available to
  your account.
- Publish platform announcements or change global settings when you are an
  administrator.

## Understand the Core model

| Resource or surface | Responsibility |
| --- | --- |
| Account session | The signed-in browser session and its account identity |
| Profile and credentials | Self-service profile fields, passkeys, and personal API keys |
| Notification history | One place to review account and application events |
| Announcement | A platform message or dismissible banner with publication timing |
| Global setting and legal page | Platform-wide configuration and published legal content |
| Admin overview | Links to Core and app-specific administration surfaces |

Core's admin overview is a directory, not a second owner for every setting.
For example, OAuth clients, account administration, and gateway operations stay
in their respective apps even when Core links to them.

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
