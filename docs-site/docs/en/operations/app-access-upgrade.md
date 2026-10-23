---
title: Upgrade application access declarations
navTitle: App access upgrade
section: Operations
order: 1190
description: Roll out declarative application access while preserving public routes and existing callers.
tags: [operations, upgrades, identity]
updated: 2026-10-22
---

# Upgrade application access declarations

Update Core before applications that declare configurable access. Core creates
the shared access-list and first-configuration tables. If the shared store is
unavailable, configurable access fails closed, including its transition rule.

Applications without an `access` declaration keep their current behavior in
this release and log a startup warning. Requiring the declaration for all
applications is a separate major-version change.

For each application update:

1. Confirm the chosen fixed rule preserves its supported callers, including
   standalone and delegated service accounts. Navigation roles alone are not
   evidence for the entry rule.
2. Check public share links, webhooks, OAuth callbacks, legal pages, manifests,
   and any endpoint with specialized authentication. Their declared exemptions
   retain their own route authentication.
3. Verify the application disappears from discovery without access, a direct
   link shows a denial, and a permitted API credential still works.
4. Test revocation with an open page and live connection. The next request must
   fail and the connection must close within one minute, even if an event is
   lost.

An installation administrator may repair configurable access without gaining
use of the application. Keep that distinction when investigating an app that
is absent from the administrator's launcher.

The gateway continues to route requests; the application process enforces the
entry rule. See [App access](/en/docs/identity/app-access) for declarations and
transition behavior.
