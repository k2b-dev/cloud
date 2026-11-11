---
title: Privacy screen operations
navTitle: Privacy screen
section: Operations
order: 1555
description: Know what the privacy screen stores, which route saves it, and what it does not protect.
tags: [operations, privacy, shell, preferences]
updated: 2026-11-10
---

# Privacy screen operations

The privacy screen hides the content of every signed-in Cloud page in a
browser after the person's idle time, or at once from the profile menu or
`Ctrl+.` (`Cmd+.` on macOS). It covers; it does not lock and does not end a
session. People continue with a click or a key. See
[Hide the content with the privacy screen](/en/docs/frontend/layout-and-navigation#hide-the-content-with-the-privacy-screen)
for the behavior and the application contract.

## What changes on upgrade

- The timer is on for everyone after the upgrade: content hides after two idle
  minutes until a person chooses another time (30 s, 1, 2 or 5 min) or **Off**.
  There is no installation-wide setting and no environment variable.
- The Core migration adds the table `auth.screen_preferences` with one row per
  person who changed the timer. Without a row the default applies. Rows go
  with the account (`ON DELETE CASCADE`).
- `GET /api/me/screen` reads and `PUT /api/me/screen` saves
  `{ "privacyTimerSeconds": 0 | 30 | 60 | 120 | 300 }` for the signed-in person.
  Every signed-in page reads the value with the page, so the first frame shows
  the saved choice. If the read fails, the page still renders with the default.

## Limits

- Only Cloud tabs of the same browser cover together. Notifications of the
  operating system, other applications, screen sharing and browser features
  outside the page, such as tab previews, are not covered.
- Phones and tablets without a mouse or touchpad have no privacy screen; the
  person's timer applies on their computers only.
- The privacy screen protects nothing against someone who sits down at the
  computer: one click shows everything again. On computers that several
  people use, people still sign out.
