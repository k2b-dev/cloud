---
title: FreeIPA setup
navTitle: FreeIPA
section: Accounts & sign-in
order: 1083
description: Connect a Cloud deployment to FreeIPA identity infrastructure.
tags: [freeipa, identity, directory]
updated: 2026-09-09
---

# FreeIPA setup

Connect FreeIPA to let directory users sign in to Cloud and manage their
accounts and groups. If your organization uses only local Cloud accounts,
leave this integration disabled.

## Configure the connection

Open **Administration → Accounts & sign-in → FreeIPA**.
Enable the connection and set the `freeipa.*` values there. Account access and
login-page visibility are separate [Sign-in settings](/en/docs/operations/account-categories).

The connection needs:

- the FreeIPA host name without `https://`;
- a service account user;
- the service account password;
- directory group rules.

`FREEIPA_URL`, `FREEIPA_SVC_USER`, and `FREEIPA_SVC_PASSWORD` can bootstrap the
first configuration.

All three bootstrap values must be present. For an already configured
installation, edit the saved settings in Administration.

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
| Users | add, modify, delete, find, show |
| Groups | add, modify, delete, find |
| Membership | add and remove members |
| Member managers | add and remove member managers |
| Hosts | modify, delete, find |
| Host groups | add, modify, delete, find, add members, remove members |
| Connectivity | ping |

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

Open **Administration → Accounts & sign-in → Operations**.
Read [Repair expiry dates](/en/docs/accounts/lifecycle#repair-expiry-dates)
before starting: maintenance can restore access for expired accounts.
It does not assign Linux identities.

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
