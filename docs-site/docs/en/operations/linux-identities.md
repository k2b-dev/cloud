---
title: Assign Linux identities
navTitle: Linux identities
section: Operations
order: 1175
description: Assign local UID, GID, home and shell attributes and backfill existing accounts without changing authentication.
tags: [linux, identity, administration, freeipa]
updated: 2026-09-08
---

# Assign Linux identities

Administrators configure local Linux identity assignment in **Administration →
Settings → Linux access**. Individual identities and group IDs appear in
**Accounts**. FreeIPA remains the authority for its own identities.

This feature assigns identity data only. It does not enable computer login,
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
directory inventory blocks new local identity assignment, not existing FreeIPA sign-in.
Previously mirrored IPA identities also require a directory range check.

The operator must reserve the range outside Cloud too. Cloud cannot discover
every machine-local account, file owner or concurrent external directory
change. Do not later assign the reserved range to another identity provider.

Saving setup does not change existing accounts. While enabled, creating a local
full account or promoting a local guest to a full account automatically assigns
its UID, private primary group/GID, home and shell. Account changes, new identity
data and the identity audit event commit together. If assignment fails, the
account is not created or the guest remains a guest. Review the Linux settings
and retry after resolving the error; there is no partially created identity.

Guests do not receive new identities. FreeIPA creation, synchronization and
provider transitions keep their existing behavior. Defaults are stored with
each new identity, so later default changes do not rewrite existing identities.
Re-promoting an account with a local identity retains its IDs and overrides.

## Backfill existing accounts

Use **Backfill existing accounts** for local full accounts created before
assignment was enabled. Enabling the feature does not run a backfill.

The table initially shows only eligible accounts with missing attributes. Choose **Show all
accounts** to inspect FreeIPA identities, assigned accounts and conflicts.
Search matches usernames without case sensitivity. Submit the search with
Enter; the account filter applies immediately. Both search the full inventory;
filtering happens before pagination. Changing a filter
clears the selection. Filters remain in the URL when moving between pages.
The checkbox in the table header selects eligible accounts on the current
page. Backfill and clear-selection actions appear only after selection.

Review the account list before selecting local full accounts. Guests are not
eligible. Names must use 1–32 lowercase ASCII letters, digits, underscores or
hyphens, starting with a letter or underscore. Conflicting names, groups or
numeric identities are shown for review; Cloud never silently renames an
account or adopts a pre-existing group.

Choose **Backfill** for the selected accounts and confirm the action. Each account gets a stable
UID, a new private primary group with a stable GID, a home path and a shell.
Each account commits independently and atomically with its audit event.
Repeated assignment returns the existing identity without renumbering it.

The list shows up to 50 accounts per page. Backfill runs one selected account
at a time. **Stop after current account** lets the current request finish;
completed identities remain. Refresh the list and select remaining accounts
to continue after an interruption. Closing the page also stops further
requests, but a request already sent may still complete.

Successful completion shows a toast confirming the assigned attributes, not
computer access. An individual existing account can also receive its missing
identity from its Accounts detail view.

## Manage an individual identity

Open a person in Accounts to inspect its source and Linux attributes. Local
full accounts can override their home path and shell after confirmation. This
does not change UID/GID, move directories or update target computers. Verify
that the selected shell exists on those computers before deploying a client.

An existing local group without a GID can receive one from its group detail
view. This grants no sudo permission. A group referenced as a primary group
cannot be deleted while that identity exists.

Disabling local assignment stops automatic assignment and backfill, retains existing identities and allows their
local home/shell values to be maintained in Accounts. The administration
inventory is only shown while assignment is enabled. Unavailable selections
are disabled, with the reason in the Status column. Deleting an account does not free its
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
configuration is enabled. To disable assignment, set `enabled` to `false` in
the exported file and apply it with `--yes`; existing identities remain.

Use `preview --after <nextCursor> --json` for the next page. A null cursor
means the last page. CLI preview defaults to all accounts; use `--scope ready`
and `--search alice` to narrow it, preserving these flags on subsequent pages.
Preview never changes accounts. Inspect and backfill
individual accounts deliberately:

```bash
cld accounts users linux get alice --json
cld accounts users linux prepare alice --yes
cld accounts users linux update alice --home /home/alice --shell /bin/bash --yes
cld accounts groups make-posix team --yes
```

The existing `prepare` command name is unchanged; it assigns missing identity
data to one existing account. GUI and CLI account creation both use automatic
assignment while enabled.

Both `--home` and `--shell` are required for an update. User and group arguments
accept IDs or exact references; ambiguous references require an ID. Preparation
is safe to repeat for an already assigned identity. There is no implicit bulk
backfill. Local group assignment uses the reserved Cloud range; FreeIPA groups
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
assignment. A provider migration remains a separate operation.

## Administration API

The platform service `linuxIdentities`, exported from
`@k2b/cloud/services`, enforces administrator access on every method,
including calls outside HTTP. It owns identity configuration, reads and
mutations; application-owned access grants do not confer this authority.

| Method and path below `/api/admin/core/linux-identities` | Purpose |
| --- | --- |
| `GET /` | Preview a page; optional UUID `after` cursor |
| `PUT /configuration` | Save `{ config, rangeReserved }`; enabled setup requires confirmation |
| `GET /users/:id` | Inspect one account and its identity state |
| `POST /users/:id` | Backfill missing attributes for one eligible local full account |
| `PATCH /users/:id` | Set local `homeDirectory` and `loginShell` |
| `POST /groups/:id` | Assign a GID to an existing local group |

The configuration is one validated value, `linux.identity_config`, in the
existing settings store. Use the dedicated administration API rather than
editing that JSON setting directly. Allocation and the current configuration
are checked inside each database transaction. No partial account or group
allocation is published when a check fails.
