---
title: FreeIPA setup
navTitle: FreeIPA
section: Accounts & sign-in
order: 1083
description: Connect a Cloud deployment to FreeIPA identity infrastructure.
tags: [freeipa, identity, directory]
updated: 2026-10-28
---

# FreeIPA setup

Connect FreeIPA to let directory users sign in to Cloud and manage their
accounts and groups. If your organization uses only local Cloud accounts,
leave this integration disabled.

## Configure the connection

Open **Administration → Sign-in & security → FreeIPA**.
Enable the connection and set the `freeipa.*` values there. Account access and
login-page visibility are separate [Sign-in settings](/en/docs/operations/account-categories).

The connection needs:

- the FreeIPA host name without `https://`;
- a service account user;
- the service account password;
- directory group rules.

FreeIPA connection and group rules are settings only. Cloud does not read
FreeIPA or group bootstrap environment variables. For a fresh installation,
use the temporary [admin-token first access](/en/docs/operations/deployment-requirements#bring-up-a-fresh-installation),
then configure and test FreeIPA before switching to directory sign-in.

## Configure TLS

Use `freeipa.ca_cert` for a private certificate authority.

Paste one or more complete PEM certificates. Cloud validates the PEM bundle
before saving it, uses it as the trust chain, and still verifies the FreeIPA
host name. Certificate verification is explicit and is not weakened by
`NODE_TLS_REJECT_UNAUTHORIZED`.

`freeipa.allow_insecure` disables TLS verification. Use it only for local
development. A configured CA certificate takes precedence.

After saving, choose **Test connection** on the FreeIPA settings page. The test
uses only saved settings and verifies TLS, a fresh service-account login, and
FreeIPA `ping`. Save or discard pending changes before testing.

FreeIPA requests time out after 30 seconds. Cloud reports certificate,
connectivity, timeout, upstream, authentication, and invalid-response failures
separately without logging credentials, session cookies, or certificate
contents.

## Grant service-account permissions

Cloud uses JSON-RPC for:

| Area | Required operations |
| --- | --- |
| Users | add, modify, enable, disable, delete, find, show |
| Groups | add, modify, delete, find, show |
| Membership | add and remove members |
| Member managers | add and remove member managers |
| Hosts | modify, delete, find |
| Host groups | add, modify, delete, find, add members, remove members |
| Connectivity | ping |

For administrative directory reconciliation, also allow `stageuser_show` and
give the service account read visibility across all relevant users and groups,
including preserved and staged users and entries excluded from Cloud sync.
Cloud checks exact upstream identities before labeling a directory orphaned.
An unavailable or denied lookup stays unknown. Directory permissions that hide
entries can return a not-found result, so a restricted view cannot establish
safe absence. This visibility requirement cannot be verified by `ping` alone.
FreeIPA directory cleanup remains an explicit administrator action; see the
[identity reconciliation contract](/en/docs/reference/account-administration).

Cloud does not create hosts.

When using [local Linux identities](/en/docs/operations/linux-identities)
alongside FreeIPA, also allow `idrange_find`. This extra read permission is
needed to avoid overlapping numeric IDs, not for FreeIPA sign-in. The normal
sync mirrors Linux attributes without changing their directory values.

Grant only these operations. FreeIPA privilege and role names depend on the
directory configuration, so verify them in the target instance.

Users still need the relevant Cloud permissions to make directory changes;
the service account does not give them administrative access.

## Define group scope

| Setting | Meaning |
| --- | --- |
| `freeipa.groups.base_sync` | Groups whose members receive Cloud accounts |
| `freeipa.groups.base_ipa_realm` | Groups whose members become full users |
| `freeipa.groups.admin` | Groups that grant the Cloud administrator role |
| `freeipa.groups.excluded` | Groups omitted from mirrored memberships and hierarchy |

`base_sync` and `base_ipa_realm` are required. Cloud does not guess them.

Excluded groups remain available while Cloud evaluates sync scope. Cloud does
not mirror those groups or their membership and hierarchy edges.

## Email changes through Cloud

Cloud rejects a new account email or an actual email change if another account
already uses the normalized address, including local accounts. Case and
surrounding whitespace are ignored. The check stays in application write paths;
no new unique database constraint or startup cleanup is installed.

Existing duplicates remain valid stored identities. Saving their unchanged
address preserves its spelling, and editing other profile fields remains
possible. Explicit local-account promotion keeps its Cloud ID. Synchronization
continues to mirror directory data under the existing matching policy below;
it does not apply the new-address rejection to the directory inventory.

## Account matching and transitions

**User Match Mode** (`freeipa.user_match_mode`) defaults to **Ignore local match**.
Set **Migrate matching local account** only when you intend a unique local
account with the same email to become FreeIPA-managed. Migration keeps its
Cloud ID but changes its username, provider, profile and directory-controlled
data. Multiple local email matches are skipped. This is not an email-login fallback.

**Account Transition Policy** (`freeipa.account_transition_policy`) controls
what happens when an IPA-backed account expires or leaves synchronization scope:

| Choice | Result |
| --- | --- |
| Make local guest (default) | Retain the account as a local Guest |
| Make local (keep profile) | Retain the account and its guest/full profile |
| Make local user | Retain the account as a local full account |
| Delete account | Delete the Cloud account through its lifecycle policy |

Review the destination category's allowed-access policy before changing this.
Retaining an account does not guarantee it can sign in, and a provider transition
is not a migration of workstation file ownership.

When approving a local guest's FreeIPA request, Cloud checks the existing
username before creating an account. An expired or disabled account with the
same email can be reactivated. Cloud keeps its numeric user and group IDs,
home directory and existing directory memberships, restores the configured
sync and full-user groups, and sends a temporary password through the usual
welcome notification. The audit action is `accounts.user.reactivate`.

Cloud refuses a different or missing email, a changed stored numeric user ID,
or an active account without a matching interrupted reactivation. Resolve
these conflicts by verifying the person's directory identity; do not delete
and recreate the account. FreeIPA must expose its unique entry ID for safe
retries. If approval fails after a remote change, resolve the reported error
and retry the pending request. Cloud checks the saved unique entry ID before
continuing, even if the account is already active. Access is restored after
the password and group changes. A failure while restoring access or committing
the local link attempts to restore the original expiry and disabled state.
If that compensation fails, Operations logs an access rollback failure; keep
the request pending and retry after resolving the directory error.

A missing directory account with a stored IPA numeric user ID is also refused:
Cloud does not silently replace that identity with a new numeric owner.

If the directory entry, server or email changed after an interrupted attempt,
inspect the exact user's row in `auth.ipa_reactivations`, including its saved
remote ID and original access state. Verify the old and current directory
identities and numeric owners before recovery. Prefer restoring the original
entry and matching account details. An operator may clear a stale claim only
by its exact Cloud user ID and saved remote ID, after verifying the target is
expired or disabled and its mail and numeric identity belong to that person.
Clearing a claim does not permit linking an active account or replacing a
missing numeric identity.

Reactivation preserves an account that still exists in FreeIPA. It does not
automatically restore numeric IDs lost through an earlier deletion and recreation. For an
already recreated account, the operator must verify the old and current
numeric IDs and repair filesystem ownership and ACLs on the affected storage,
or restore the original directory identity through a planned recovery. This
requires a backup and an explicit storage recovery procedure; approving the
Cloud request alone does not repair NFS ownership.

**Sync Cron** (`freeipa.sync_cron`) defaults to `*/5 * * * *`: every five minutes
in the Cloud timezone. Use Operations to inspect sync logs.

## Configure destructive-change guards

Synchronization stops without destructive changes if FreeIPA returns an
incomplete or invalid user or group list.

The sync policy has two independent limits for users and two for groups:

| Setting | Default |
| --- | ---: |
| `freeipa.sync_guard.max_user_changes` | 10 |
| `freeipa.sync_guard.max_user_change_percent` | 20 |
| `freeipa.sync_guard.max_group_deletions` | 5 |
| `freeipa.sync_guard.max_group_deletion_percent` | 20 |

User changes are the deduplicated union of accounts leaving sync scope and
full users being demoted to guests. Group changes count mirrored IPA groups
that would be deleted. Percentages use the local IPA user or group count before
the run.

A plan is rejected when either its absolute or percentage limit is exceeded.
Equality is allowed. Zero means no destructive changes; it never means
unlimited.

For an intentional large reconciliation:

1. inspect the proposed counts and percentages in `auth:ipa:sync` logs;
2. verify the FreeIPA group graph and scope settings;
3. raise both the absolute and percentage limit for the affected entity;
4. allow one successful sync;
5. restore the normal limits.

Do not raise only one limit: the other continues to protect the directory.

## Backfill account expiry dates

Open **Administration → Sign-in & security → Account operations**.
Read [Repair expiry dates](/en/docs/accounts/lifecycle#repair-expiry-dates)
before starting: maintenance can restore access for expired accounts.
It does not assign Linux identities.

## Password changes and sign-ins

Changing or resetting a FreeIPA password in Cloud ends the person's other
sign-ins, including browsers, `cld`, MCP, connected apps using OAuth, and devices
paired with the Cloud app. This applies to profile changes, administrator
resets, reset links, and expired or temporary password changes at sign-in.
People using the command line run `cld login` again afterwards.

A profile change keeps the current browser signed in with a new cookie and its
original sign-in time and expiry. Cloud Login devices stay paired; a reset link
also unpairs those devices. API keys, passkeys and background mandates stay valid.
A password changed directly in FreeIPA, outside Cloud, ends no Cloud sign-in.
No configuration change or migration is needed.

## Failure and recovery behavior

Use **Test connection** for saved connection settings and **Operations** for
filtered sync logs. Resolve certificate, credentials or group-scope errors
before retrying. Never lower TLS protection to fix a production certificate error.
See [FreeIPA recovery](/en/docs/reference/freeipa-recovery) for interrupted
jobs, dead letters and the older-job upgrade procedure.

## Verify the integration

Before enabling user traffic:

1. verify TLS and `ping`;
2. run a read-only user and group lookup;
3. confirm `base_sync` includes the intended population;
4. confirm full-user and guest classification;
5. confirm administrator group resolution;
6. test one allowed and one denied directory mutation;
7. inspect audit events;
8. test behavior while FreeIPA is unavailable.

See [Authentication](/en/docs/identity/authentication) and
[Identity and access](/en/docs/identity) for the resulting request identity.
