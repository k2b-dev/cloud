---
title: FreeIPA setup
navTitle: FreeIPA
section: Operations
order: 1170
description: Connect a Cloud deployment to FreeIPA identity infrastructure.
tags: [freeipa, identity, directory]
updated: 2026-07-30
---

# FreeIPA setup

FreeIPA is optional.

Enable it when Cloud should authenticate and synchronize users from an existing
FreeIPA directory. Local accounts and magic-link login work without it.

## Configure the connection

Set the `freeipa.*` settings in Cloud administration.

The connection needs:

- the FreeIPA host name without `https://`;
- a service account user;
- the service account password;
- directory group rules.

`FREEIPA_URL`, `FREEIPA_SVC_USER`, and `FREEIPA_SVC_PASSWORD` can bootstrap the
first configuration.

Cloud enables the bootstrap automatically only when all three values exist.

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

Grant only these operations. FreeIPA privilege and role names depend on the
directory configuration, so verify them in the target instance.

Cloud authorization still runs before a directory mutation. The FreeIPA
service account is the downstream technical identity.

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

## Configure destructive-change guards

Cloud validates the complete user and group snapshot before changing local
state. A truncated response, invalid payload, or incomplete snapshot stops the
run without destructive changes.

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

Use **Run FreeIPA backfill** in Accounts to fill missing or premature expiry
dates. Each accepted run fixes its target to the configured IPA account
lifetime, with a minimum of seven days, at 23:59:59 UTC. Retries keep that
target even if the settings or current date change. A later expiry read from
FreeIPA is preserved and mirrored to Cloud.

The backfill uses a Sync pump with a finite PostgreSQL scan. Accounts created
after the run's cutoff belong to a later run. The pump saves progress after
each account job is durably accepted. Pump completion means all candidate
jobs were submitted; directory changes may still be running.

The account worker processes one account at a time and rechecks its current
identity. A deleted account, changed provider, or changed username is skipped.
A directory write that succeeded before a local failure is verified again
before retrying, and PostgreSQL updates commit together.

Inspect `auth:ipa:backfill` logs and the pump run in observability for failures.
After two failed attempts, the affected account job enters the
`auth:ipa:backfill:account` dead-letter store. Later accounts continue. Resolve
the provider error and retry that dead letter to retain the original target.
Disabling FreeIPA during a run fails unfinished account jobs rather than
marking them complete. PostgreSQL continues to own account identity and the
local expiry mirror; the pump stores the run target, cursor, and acceptance
checkpoints.

For the upgrade from the former backfill job, quiesce old submitters and
workers before switching versions. The old `auth:ipa:backfill` job's work
stream must contain zero messages, its consumer must have zero pending
acknowledgments, and its dead-letter stream must be empty. Resolve any
accepted work through the old runtime before the cutover. The new pump does
not consume or delete old job state. Old jobs carried no saved target date,
so a partially completed old attempt cannot be converted without recomputing
that date.

## Failure and recovery behavior

The scheduled sync has at-least-once delivery. Cloud holds a distributed
single-run lock, refreshes both lock and job lease during long phases, and
passes cancellation into FreeIPA requests. Loss of ownership aborts the run;
an in-progress local mirror transaction rolls back.

Expired user-backed actors are rejected from request authentication even while
FreeIPA is unavailable. Session revocation happens before retryable remote
account cleanup. A repeated FreeIPA delete that reports an already-missing
account is treated as success.

The primary sync intentionally remains a complete snapshot transaction.
`user_find` and `group_find` do not expose a stable durable cursor suitable for
a direct pump. Consider a staged pump only after measurements show sustained
lease or transaction pressure and only with a persisted complete snapshot,
stable item keys, idempotent apply, and atomic finalization.

The primary snapshot sync remains outside a pump. Reevaluate it when the
seven-day p95 transaction duration reaches 60 seconds or the p95 complete sync
duration reaches 90 seconds (75 percent of the 120-second lease). A staged
snapshot design would use a persisted run id plus entity/external id as the
idempotency key, a stable staged-row cursor, and an atomic publish step; no
partially applied run may become visible. A per-account lifecycle pump would
use `(account_expires, user_id)` as its Postgres cursor and
`user_id:account_expires` as its idempotency key. Its sink must preserve the
existing request-time expiry check, audit uniqueness, and retry-safe
already-missing delete behavior. Test either design with crashes before and
after sink acceptance, cursor checkpoint, and final publication.

When a run fails:

1. classify the log as configuration, TLS, network/timeout, upstream,
   snapshot-integrity, or guard failure;
2. fix the underlying cause rather than disabling verification;
3. use **Test connection** for transport and service-account checks;
4. restore safe guard values after an intentional override;
5. let the next scheduled retry reconcile the idempotent mirror.

Successful sync logs include fetched and in-scope counts, transaction duration,
user and group change counts, percentages, active guard limits, profile drift,
and rebuilt membership counts.

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
