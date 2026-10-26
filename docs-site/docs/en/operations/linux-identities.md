---
title: Assign Linux identities
navTitle: Linux identities
section: Accounts & sign-in
order: 1086
description: Assign local UID, GID, home and shell attributes and backfill existing accounts without changing authentication.
tags: [linux, identity, administration, freeipa]
updated: 2026-10-26
---

# Assign Linux identities

If the saved Linux configuration cannot be read, administration shows its
defaults with an unreadable warning. Existing provisioning still refuses the
unreadable configuration. Restore the operator's access, or select **Replace
stored value: Local Linux identities** before saving a complete configuration.
Failed saves retain the draft. CLI replacement also requires
`--replace-unreadable` in addition to the usual confirmation flags. If a value
becomes unreadable during editing, a rejected save refreshes the warning and
replacement choice while preserving the entered configuration.

Administrators configure local Linux identity assignment in **Administration →
Accounts & sign-in → Linux identities**. Individual identities and group IDs appear in
**Accounts**. FreeIPA remains the authority for its own identities.

Linux identities contain a user's UID, primary GID, home path and login shell.
They identify accounts to Linux systems; they do not provide computer login,
sudo or shared storage. Cloud does not create or move home directories or files.

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
its UID, private primary group/GID, home and shell. If assignment fails, the
account is not created or the guest remains a guest. Review the Linux settings
and retry after resolving the error; there is no partially created identity.

Guests do not receive new identities. FreeIPA identities are managed in the
directory, not assigned from Cloud's local range. Defaults are stored with
each new identity, so later default changes do not rewrite existing identities.
Re-promoting an account with a local identity retains its IDs and overrides.

## Backfill existing accounts

Use **Backfill existing accounts** for local full accounts created before
assignment was enabled. Enabling the feature does not run a backfill.

The table initially shows only eligible accounts with missing attributes. Choose **Show all
accounts** to inspect FreeIPA identities, assigned accounts and conflicts.
Search by username and press Enter. Changing a filter clears the selection.
The checkbox in the table header selects eligible accounts on the current
page. Backfill and clear-selection actions appear only after selection.

Review the account list before selecting local full accounts. Guests are not
eligible. Names must use 1–32 lowercase ASCII letters, digits, underscores or
hyphens, starting with a letter or underscore. Conflicting names, groups or
numeric identities are shown for review; Cloud never silently renames an
account or adopts a pre-existing group.

Choose **Backfill** for the selected accounts and confirm the action. Each account gets a stable
UID, a new private primary group with a stable GID, a home path and a shell.
Backfilling an already assigned account retains its identity without renumbering it.

**Stop after current account** lets the current account finish;
completed identities remain. Refresh the list and select remaining accounts
to continue after an interruption. Closing the page also stops further
requests, but a request already sent may still complete.

After completion, the list shows the assigned attributes. This does not grant
computer access. An individual existing account can also receive its missing
identity from its Accounts detail view.

## Manage an individual identity

Open a person in Accounts to inspect its source and Linux attributes. Local
full accounts can override their home path and shell after confirmation. This
does not change UID/GID, move directories or update target computers. Verify
that the selected shell exists on those computers before deploying a client.

In Accounts, choose **Create as POSIX group** when creating a local group.
The option is off by default and requires enabled local Linux identities.
Cloud creates the group and assigns its GID together: if assignment fails,
no group is created. Leave the option off for a logical group without a GID.

An existing local group without a GID can receive one using **Convert to POSIX**
in its group actions. Both creation and conversion use the reserved Cloud range
and require an administrator. Local POSIX names must contain 1–32 lowercase
ASCII letters, digits, underscores or hyphens, starting with a letter or
underscore. Accounts normalizes names before validation. Conflicting names or
an exhausted range must be resolved before retrying.

Assigned GIDs are permanent; there is no conversion back to a logical group.
Assignment grants no sudo permission and creates no files. A group referenced as a primary group
cannot be deleted while that identity exists.

### Personal Linux groups

The private primary group created for each local account is its personal Linux
group, named after the username. Linux needs it; people do not work with it as a
team. Group lists and pickers therefore leave personal groups out:

- The Accounts group list, a person's membership list, and **My account → Access**
  hide them. Dashboard and widget group counts include ordinary groups only.
  Inspect the person's Linux identity section for their primary GID.
- Sharing, permission, role and membership pickers do not offer them. Grant the
  person instead.
- Files does not show a personal group as a group area; people use their own
  files area instead.
- Personal groups are available only as user identity diagnostics, such as the
  primary GID in the person's Linux identity section.

### Upgrade group exports and integrations

**Operator note:** Personal Linux groups are excluded from Accounts API and
CLI group listings, entity search (including exact group IDs and relation
filters), and OAuth/OIDC `groups` claims in access tokens, ID tokens and
UserInfo. The API query option
`include_personal` is ignored; the CLI rejects the removed `--include-personal`
flag. The server-side `accounts.users.getGroups` projection also excludes
personal groups.
Ordinary groups and inherited memberships through personal groups remain in
these outputs. Internal authorization and Linux primary GIDs retain their
existing meaning. FreeIPA groups are not classified by matching usernames.

Before upgrading, review directory exports and integrations that used the
personal group name. Configure an ordinary team group or use the user's
identity instead. Refresh exported inventories and verify group mapping at the
consumer after upgrading. Stored group references in sharing settings or Grids
may lose their display label or require replacement before editing. Review
existing nested memberships and manager-group relationships before upgrading;
new relationships cannot use personal groups. Inspect Linux attributes with `cld accounts users
linux get <user> --json` when diagnosing an identity.

Operators with database access can inventory existing group relationships before
replacing them with ordinary groups or direct user memberships:

```sql
SELECT 'member' AS relationship, gg.child_group_id AS principal_id, p.group_name, gg.parent_group_id AS target_group_id
FROM auth.personal_groups p
JOIN auth.group_groups_v2 gg ON p.group_id IN (gg.child_group_id, gg.parent_group_id)
UNION ALL
SELECT 'manager', gm.manager_group_id, p.group_name, gm.group_id
FROM auth.personal_groups p
JOIN auth.group_manager_groups_v2 gm ON p.group_id IN (gm.manager_group_id, gm.group_id)
UNION ALL
SELECT 'user-member', ug.user_id, p.group_name, ug.group_id
FROM auth.personal_groups p JOIN auth.user_groups_v2 ug ON ug.group_id = p.group_id
WHERE ug.user_id <> p.owner_id
UNION ALL
SELECT 'user-manager', gmu.user_id, p.group_name, gmu.group_id
FROM auth.personal_groups p JOIN auth.group_manager_users_v2 gmu ON gmu.group_id = p.group_id;
```

After recording the intended replacement, an administrator can remove an old
relationship by its exact IDs without exporting the personal group:

```bash
cld --profile <profile> accounts groups members remove <target-group-id> --group <principal-id> --yes
cld --profile <profile> accounts groups managers remove <target-group-id> --group <principal-id> --yes
cld --profile <profile> accounts groups members remove <target-group-id> --user <principal-id> --yes
cld --profile <profile> accounts groups managers remove <target-group-id> --user <principal-id> --yes
```

Use `--group` for group relationships and `--user` for user relationships. Keep
the owner's own membership in their personal group; it supplies their primary
Linux group and is excluded from the user-member query above.

Files group directories associated with a recorded personal group appear as
**Legacy** in **Files administration → Directories**, including after account
retirement. These are Filegate directories under the configured group path,
not the user's Linux home path. Files preserves their contents and excludes
these bindings from automatic archival. An administrator can browse them and
explicitly archive them or copy their contents to the intended destination.
Bindings use the recorded group ID. For an unbound directory, Files also
recognizes the former group name stored in the ownership record and preserves
it as Legacy if a new team reuses that name. Matching a username alone never
establishes personal ownership. Historical contents are never deleted automatically.

Disabling local assignment stops automatic assignment and backfill, retains existing identities and allows their
local home/shell values to be maintained in Accounts. The administration
inventory is only shown while assignment is enabled. Unavailable selections
are disabled, with the reason in the Status column. Deleting an account does not free its
reserved numbers for reuse. Deleting the account also retires its personal
Linux group in the same transaction, including after a profile or provider
change. The group disappears from lists and lookups; its memberships,
manager relationships and grants are removed. New memberships and grants
cannot target it. Cloud keeps an ownership record, the recorded group name
and its reserved GID.
An application foreign key that restricts deletion of the group makes the
whole account deletion fail and roll back. Application authors should use
`ON DELETE CASCADE` for references that must retire with a Cloud group.
Account deletion does not delete filesystem content. Files preserves recorded
personal-group directories as Legacy; its configured
archive policy still applies to other directories whose identity no longer
exists. Operators can review their contents through Files administration.

### Review historical groups after upgrading

Upgrade Core before starting application versions that use `auth.personal_groups`.
The production Compose template only gives OAuth an explicit Core dependency;
other applications can start before Core. Follow the Core-first sequence in
[Deployment requirements](/en/docs/operations/deployment-requirements#upgrade-personal-linux-group-retirement).

Core startup installs the ownership protection and review schema. After startup,
a background pass collects historical candidates with a provisioning audit or
a GID allocation without a current primary-group owner. A GID value alone is
not evidence of personal ownership. Explicitly provisioned ordinary Linux groups are excluded unless
conflicting personal provisioning evidence exists.

The pass retires a historical group automatically only when retained audits
and ID reservations prove one deleted owner and no references remain. It scans
each installed reference table once against the whole candidate set. References
include memberships, grants, nesting, managers, directory shares, application
foreign keys, Files directory bindings, Grids approval policies and JSON values
in Grids, workflows and notifications.

The inspection takes locks only if they are immediately available, uses a
250 ms lock timeout and a two-second statement timeout, and checks a ten-second
inspection budget before each table. A busy, unreadable or oversized table
defers the batch to operator review. Completed cases, including deferred and
unproven cases, are recorded and never automatically scanned again. Core logs
each new completed review case once. Restarting Core does not repeat those
warnings or retry those cases.

**Upgrading alone does not remediate preserved historical groups.** They remain
usable, retain existing memberships and grants, and accept authorized changes
until an administrator resolves them. Operators with database access must work
through the review list:

```sql
SELECT g.id, g.name, g.gid_number, r.reason, r.details, r.completed_at
FROM auth.personal_group_review r
JOIN auth.groups g ON g.id = r.group_id
ORDER BY g.name, g.id;
```

1. Establish ownership from the recorded provisioning audit and UID/GID
   reservations. Names alone do not prove ownership. Resolve missing or
   conflicting evidence before deciding to retain an ordinary group.
2. For a confirmed orphaned personal group, open **Accounts → Groups** as an
   administrator, open that exact local group and choose **Delete** in
   its actions. Confirm deletion. This normal path removes memberships and
   cascading grants; it does not require a personal-group ownership row.
   Its GID allocation stays reserved. A restrictive application reference can
   block deletion; resolve that reference with the application owner and retry.
3. Verify that the group no longer resolves and its grants no longer apply.
   Review filesystem contents separately; deleting the group does not delete
   files. Preserve historical messages, revisions and audit snapshots.

An active personal group with an ownership record cannot be deleted through
that group action; delete its owning account when retiring that account.
The review table can retain a resolved group's row until the next background
pass; the query above excludes groups already deleted.

For `references_unchecked`, either resolve the group through Accounts or fix
the reported contention, permissions or scan cost first. To explicitly retry
one unresolved case, delete only its row from `auth.personal_group_review` by
exact `group_id`, then restart Core. Never remove its ID reservations. A scan
that fails before recording cases logs an error and is retried at the next
Core start.

If Core reports multiple owners for one personal group, startup stops and the
error identifies the group. Verify its account ownership and correct the
conflicting primary-group links before restarting; do not delete its ID
reservations.

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

The `prepare` command assigns missing identity data to one account.
GUI and CLI account creation both use automatic
assignment while enabled.

Both `--home` and `--shell` are required for an update. User and group arguments
accept IDs or exact references; ambiguous references require an ID. Preparation
is safe to repeat for an already assigned identity. There is no implicit bulk
backfill. Local group assignment uses the reserved Cloud range; FreeIPA groups
are managed through FreeIPA. Local `groups create` creates a logical group by default. To create one with a
GID in a single operation, use:

```bash
cld accounts groups create team --provider local --posix
```

The existing `make-posix` command enables POSIX for a group created earlier.
Both operations require enabled local Linux identities for local groups.
FreeIPA continues to manage its groups independently.

All these commands support `--json` and `--jsonl`. Keep your CLI version aligned
with your Cloud installation.

## Upgrade an existing FreeIPA deployment

Apply Core migrations before starting dependent services, and update services
that write FreeIPA account data together. Mixing versions can leave Cloud's
Linux identity data out of date.

FreeIPA synchronization copies UID, primary GID, home and shell without
renumbering accounts. Review incomplete identities in Administration and run
FreeIPA synchronization to refresh them; do not reassign their IDs with a local
backfill.

The stored identity source is not changed by changing an account provider.
Such accounts show a migration warning and are not silently adopted by local
assignment. A provider migration remains a separate operation.

## Administration API

See the [Linux identity API](/en/docs/reference/account-administration#linux-identity-api).
