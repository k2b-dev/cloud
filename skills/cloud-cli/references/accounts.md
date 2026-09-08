# Accounts CLI

## What Accounts is

Accounts is the shared identity and access app for Cloud users, groups, account requests, service accounts, notification batches, and audit history.

Use `cld accounts` for account and group administration. The commands available to the signed-in user depend on their Cloud roles; group managers can use the group operations they are allowed to manage.

## Users

```bash
cld accounts users list --search "ada" --json
cld accounts users get ada.lovelace --json
cld accounts users create --provider local --email ada@example.org --given-name Ada --sn Lovelace --profile user
cld accounts users update ada.lovelace --display-name "Ada Lovelace"
```

Local and FreeIPA accounts follow different rules. Stored admin access can only be changed for local full accounts:

```bash
cld accounts users set-admin ada.lovelace --enabled --yes
```

The command rejects FreeIPA and guest accounts. Manage FreeIPA administrator membership through its groups instead. Read the specific command help before changing provider, profile, expiry, passwords, or deleting an account.

## Linux identities

These commands require an administrator. Global configuration and paginated
preview live under `cld admin linux`; inspect those before preparing accounts.

```bash
cld accounts users linux get alice --json
cld accounts users linux prepare alice --yes
cld accounts users linux update alice --home /home/alice --shell /bin/bash --yes
cld accounts groups make-posix team --yes
```

Only local full accounts can be prepared. Home and shell updates require both
paths and do not move files or renumber IDs. Group preparation uses the group's
provider: the reserved Cloud range for local groups, the existing FreeIPA
operation for IPA groups. This prepares identity metadata, not computer login,
sudo or shared storage. There is no implicit bulk backfill.

## Groups and requests

```bash
cld accounts groups list --search "Editors" --json
cld accounts groups create "Editors" --provider ipa --description "Content editors"
cld accounts groups members add "Editors" --user ada.lovelace --yes
cld accounts groups managers add "Editors" --user ada.lovelace --yes
cld accounts requests list --scope open --json
```

Group members and managers can be users or groups. Resolve a group and principal first, because these changes affect access recursively. Denying a request and deleting a group both require explicit confirmation.

## Audit events and service-account credentials

```bash
cld accounts audit list --days 30 --search "ada" --json
cld accounts service-accounts list --status active --json
cld accounts service-accounts revoke <credential-id> --yes
```

Use audit events to understand a prior change before making a corrective one. Revoke a service-account credential only after confirming the exact credential ID and its owner.

## Complete command catalogue

Run `cld accounts <command> --help` for flags and argument order.

| Area | Commands |
| --- | --- |
| Users | `users list`, `users get`, `users create`, `users update`, `users set-admin`, `users set-profile`, `users set-provider`, `users demote-to-guest`, `users set-expiry`, `users reset-password`, `users login-token`, `users send-login-link`, `users delete` |
| User avatars | `users avatar get`, `users avatar set`, `users avatar remove` |
| Linux identities | `users linux get`, `users linux prepare`, `users linux update` |
| Groups | `groups list`, `groups get`, `groups create`, `groups update`, `groups make-posix`, `groups delete` |
| Group members | `groups members list`, `groups members add`, `groups members remove` |
| Group managers | `groups managers list`, `groups managers add`, `groups managers remove` |
| Account requests | `requests list`, `requests get`, `requests deny` |
| Audit | `audit list` |
| Service-account credentials | `service-accounts list`, `service-accounts revoke` |
