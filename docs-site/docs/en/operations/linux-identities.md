---
title: Assign Linux identities
navTitle: Linux identities
section: Accounts & sign-in
order: 1086
description: Assign local UID, GID, home and shell attributes and backfill existing accounts without changing authentication.
tags: [linux, identity, administration, freeipa]
updated: 2026-09-09
---

# Assign Linux identities

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

The `prepare` command assigns missing identity data to one account.
GUI and CLI account creation both use automatic
assignment while enabled.

Both `--home` and `--shell` are required for an update. User and group arguments
accept IDs or exact references; ambiguous references require an ID. Preparation
is safe to repeat for an already assigned identity. There is no implicit bulk
backfill. Local group assignment uses the reserved Cloud range; FreeIPA groups
are managed through FreeIPA. Local `groups create` does
not assign a GID; prepare the group separately.

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
