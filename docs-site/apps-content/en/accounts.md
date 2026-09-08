---
title: Accounts
navTitle: Accounts
section: Platform
order: 310
description: Account access, groups, requests, service credentials, notifications, and audit history.
tags: [accounts, groups, access]
updated: 2026-09-08
---

# Accounts

Accounts is the administration workspace for people, groups, access requests,
and service-account credentials. Users can understand their own access and
management scope. Administrators and group managers use the same app to review
and change the records they are allowed to manage.

## Use Accounts

Account types are **Guest**, configurable **Login** and **FreeIPA**. These are
derived from the existing provider and profile; they are not new providers.
Configure which types are allowed and visible in Core's **Accounts & sign-in**
settings, not in Accounts. See [Account types](/en/docs/operations/account-categories).

- Find a user by uid, name, or email and review provider, profile, roles,
  expiry, and group membership.
- Search groups, distinguish direct from inherited membership, and maintain
  members or managers within your scope.
- Process pending account requests and inspect the history of deleted or
  expired accounts.
- Review user-bound and resource-bound service credentials, then revoke an
  active key when its access should end.
- Trace account and access changes through the audit log, reminder history,
  and notification batches.
- Inspect Linux attributes, prepare eligible local full accounts, and maintain
  their home and shell. Global setup remains in Administration; FreeIPA values
  remain managed by FreeIPA. See [Linux identities](/en/docs/operations/linux-identities).

## Understand the Accounts model

| Resource or surface | Responsibility |
| --- | --- |
| Account | A person's provider, profile, roles, expiry, and identity fields |
| Group | A local or FreeIPA-backed access group with members and managers |
| Linux identity | Stable UID, primary GID, home and shell; identity data only, not computer login |
| Account request | A pending, completed, or denied request for an account |
| Service credential | A user-bound or resource-bound API key and its lifecycle |
| Audit and lifecycle history | Account changes, reminders, deleted records, and outcomes |
| Notification batch | An administrator-created message with resolved recipients and delivery results |

Direct membership is stored on one relationship. Effective access can also
come through nested groups. Removing one direct membership therefore does not
prove that access is gone.

## Create users and groups

Choose **New user** or **New group** and complete one form. When FreeIPA is
available, choose whether Cloud or FreeIPA manages the record. The account
type starts empty, including when only one type is available.
Account requests fill in the person's details and restrict the choice to FreeIPA.

For local users, choose a full or guest account and review any administrator
access. The form explains the selected type and what happens after creation.
FreeIPA
creates a temporary password, included in the welcome email; local accounts
use email links instead. If email delivery is disabled, the form explains how
to give the user access yourself. For FreeIPA groups, review the POSIX option
before creating the
group. A normalized group name is shown when it differs from your input.

**Create account** or **Create group** saves directly. If saving fails, the
form keeps your entries so you can correct them and retry. Use **Cancel** or
the close control to leave; edited forms ask before discarding entries.
Successful changes can show optional follow-up instructions configured in
**Administration → Accounts & sign-in → Registration & requests**. An empty
template adds no notice. User creation, maintenance, group changes and membership
changes use the same action-dependent template; no NFS instructions are built in.
These are instructions for the administrator or group manager, not messages
sent to the affected user. See [Account types](/en/docs/operations/account-categories)
for supported actions and template variables.

Global account settings and lifecycle backfill controls live in Administration.
The Accounts dashboard links to **Operations**; account records, request
processing and lifecycle history stay in Accounts. Disabling new account
requests does not remove existing requests from this workspace.

## How Accounts fits Cloud

Accounts operates the platform identity records and group relationships used
by Cloud access checks. Local records stay in Cloud. When FreeIPA is enabled,
FreeIPA-backed users and groups are written through the Accounts service.
Applications still own their resources and decide which permission each
principal needs.

## Find detailed product help

Open **Help** inside Accounts for users, groups, requests, service credentials,
notification batches, lifecycle views, and audit filters. Developers can read
[Request identity](/en/docs/identity/authentication),
[Resource authorization](/en/docs/identity/authorization),
[Resource API keys](/en/docs/identity/resource-api-keys), and
[FreeIPA](/en/docs/operations/freeipa) for the adjacent platform contracts.

## Inspect Accounts from the terminal

Accounts provides a native CLI module for administration and automation. Start
with read commands before selecting a record for a change:

```bash
cld accounts users list --json
cld accounts groups list --json
cld accounts users linux get alice --json
cld admin linux preview --json
```

Run `cld accounts help` to see requests, audit, and service-account areas. Run
`cld accounts <area> <command> --help` before a mutation to read its current
fields and confirmation requirements.

## Deployment requirements

See [Deployment requirements](/en/docs/operations/deployment-requirements) for
this app’s startup prerequisites, optional integrations, configuration and
functional checks.
