---
title: Prepare Linux identities
navTitle: Linux identities
section: Operations
order: 1175
description: Prepare local UID, GID, home and shell attributes without changing account authentication.
tags: [linux, identity, administration, freeipa]
updated: 2026-09-08
---

# Prepare Linux identities

Administrators configure local Linux identity preparation in **Administration →
Settings → Linux access**. Individual identities and group IDs appear in
**Accounts**. FreeIPA remains the authority for its own identities.

This feature prepares identity data only. It does not enable computer login,
TOTP, sudo, a Linux client, an offline gateway or shared storage. Local accounts
remain passwordless, and existing web sign-in is unchanged. Cloud does not
create or move home directories or files.

## Set up local identities

1. Choose **Set up local identities**.
2. Review the home template and login shell. The default values are
   `/home/{username}` and `/bin/bash`.
3. Open **Advanced: reserved UID/GID range** and enter a range reserved for
   Cloud across your directories, computers and storage. There is no default
   numeric range. The first ID must be at least 1000; the maximum is 2147483647.
4. Confirm the reservation and choose **Check and save setup**.

Cloud checks FreeIPA's directory ranges and known IDs, not just the users
currently synchronized into Cloud. When FreeIPA is configured, its service
account must be able to run `idrange_find`. An unavailable or incomplete
directory inventory blocks local preparation, not existing FreeIPA sign-in.
Previously mirrored IPA identities also require a directory range check.

The operator must reserve the range outside Cloud too. Cloud cannot discover
every machine-local account, file owner or concurrent external directory
change. Do not later assign the reserved range to another identity provider.

Saving setup does not change any account. Defaults are stored with each new
identity, so later default changes do not rewrite existing identities.

## Prepare selected accounts

Review the account list before selecting local full accounts. Guests are not
eligible. Names must use 1–32 lowercase ASCII letters, digits, underscores or
hyphens, starting with a letter or underscore. Conflicting names, groups or
numeric identities are shown for review; Cloud never silently renames an
account or adopts a pre-existing group.

Start the selected accounts and confirm the action. Each account gets a stable
UID, a new private primary group with a stable GID, a home path and a shell.
Each account commits independently and atomically with its audit event.
Repeated preparation returns the existing identity without renumbering it.

The list shows up to 50 accounts per page. Preparation runs one selected account
at a time. **Stop after current account** lets the current request finish;
completed identities remain. Refresh the list and select remaining accounts
to continue after an interruption. Closing the page also stops further
requests, but a request already sent may still complete.

New accounts use the same explicit preparation action in their Accounts detail
view. Account creation does not automatically prepare a Linux identity.

## Manage an individual identity

Open a person in Accounts to inspect its source and Linux attributes. Local
full accounts can override their home path and shell after confirmation. This
does not change UID/GID, move directories or update target computers. Verify
that the selected shell exists on those computers before deploying a client.

An existing local group without a GID can receive one from its group detail
view. This grants no sudo permission. A group referenced as a primary group
cannot be deleted while that identity exists.

Disabling local preparation retains existing identities and allows their
local home/shell values to be maintained. Deleting an account does not free its
reserved numbers for reuse. Its primary group remains for deliberate review;
Cloud does not infer filesystem cleanup from account deletion.

## Use the CLI

The native commands use the same administrator-only service as the GUI. Start
by exporting the full configuration and reviewing the first page:

```bash
cld admin linux config get --json > ./linux.json
cld admin linux preview --json
```

Edit `linux.json`: it contains `enabled`, `rangeStart`, `rangeEnd`,
`homeTemplate` and `loginShell`. Reserve a suitable numeric range before setting
`enabled` to `true`; do not copy another installation's range. Then apply it:

```bash
cld admin linux config set --config-file ./linux.json --range-reserved --yes
```

This replaces the complete configuration, not selected fields. Inline JSON
with `--config` or standard input with `--stdin` are also supported; choose
exactly one input source. `--range-reserved` is required whenever the submitted
configuration is enabled. To disable preparation, set `enabled` to `false` in
the exported file and apply it with `--yes`; existing identities remain.

Use `preview --after <nextCursor> --json` for the next page. A null cursor
means the last page. Preview never prepares accounts. Inspect and prepare
individual accounts deliberately:

```bash
cld accounts users linux get alice --json
cld accounts users linux prepare alice --yes
cld accounts users linux update alice --home /home/alice --shell /bin/bash --yes
cld accounts groups make-posix team --yes
```

Both `--home` and `--shell` are required for an update. User and group arguments
accept IDs or exact references; ambiguous references require an ID. Preparation
is safe to repeat for an already prepared identity. There is no implicit bulk
backfill. Local group preparation uses the reserved Cloud range; FreeIPA groups
continue through the existing FreeIPA operation. Local `groups create` does
not assign a GID; prepare the group separately.

All these commands support `--json` and `--jsonl`. Use a CLI build containing
these commands; updating the server alone does not update an installed CLI.
Maintainers testing this checkout use `bun run dev:cld -- <arguments>` instead
of an installed `cld`.

## Upgrade an existing FreeIPA deployment

The additive Core migration creates `auth.user_posix` and
`auth.posix_allocations`; it does not provision local accounts or rewrite
existing IDs. Apply the Core migration before starting updated consumers.

Normal FreeIPA synchronization mirrors UID, primary GID, home and shell into
the common identity table, preserving values and missing attributes. Until
that synchronization, the legacy `auth.user_ipa_data.uid_number` remains a
read fallback. Updated writers also maintain that legacy value for existing
readers; removing the column is not part of this upgrade. The public
`user.ipa.uidNumber` field remains available.

Update all IPA-writing services together: mixing older writers with updated
readers can leave the common mirror stale. No separate destructive SQL
backfill or numeric reassignment is required. Review incomplete identities in
Administration and use the existing IPA sync to refresh them.

The stored identity source is not changed by changing an account provider.
Such accounts show a migration warning and are not silently adopted by local
preparation. A provider migration remains a separate operation.

## Administration API

The platform service `linuxIdentities`, exported from
`@valentinkolb/cloud/services`, enforces administrator access on every method,
including calls outside HTTP. It owns identity configuration, reads and
mutations; application-owned access grants do not confer this authority.

| Method and path below `/api/admin/core/linux-identities` | Purpose |
| --- | --- |
| `GET /` | Preview a page; optional UUID `after` cursor |
| `PUT /configuration` | Save `{ config, rangeReserved }`; enabled setup requires confirmation |
| `GET /users/:id` | Inspect one account and its preparation state |
| `POST /users/:id` | Prepare one eligible local full account |
| `PATCH /users/:id` | Set local `homeDirectory` and `loginShell` |
| `POST /groups/:id` | Assign a GID to an existing local group |

The configuration is one validated value, `linux.identity_config`, in the
existing settings store. Use the dedicated administration API rather than
editing that JSON setting directly. Allocation and the current configuration
are checked inside each database transaction. No partial account or group
allocation is published when a check fails.
