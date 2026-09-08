---
title: Recover FreeIPA synchronization and maintenance
navTitle: FreeIPA recovery
section: Reference
order: 1278
description: Diagnose interrupted FreeIPA backfills and safely upgrade older background jobs.
tags: [freeipa, operations, recovery]
updated: 2026-09-09
---

# Recover FreeIPA synchronization and maintenance

For initial configuration, use [FreeIPA setup](/en/docs/operations/freeipa).
This reference is for operators investigating background work or upgrading it.

## Backfill account expiry dates

Use **FreeIPA account expiry** under **Administration → Accounts & sign-in → Operations** to fill missing or premature expiry
dates. Each accepted run fixes its target to the configured IPA account
lifetime, with a minimum of seven days, at 23:59:59 UTC. Retries keep that
target even if the settings or current date change. A later expiry read from
FreeIPA is preserved and mirrored to Cloud.

A run includes accounts present when it starts. Accounts created later belong
to a later run. Completion of submission does not mean every account update
has finished; directory changes may still be running.

The account worker processes one account at a time and rechecks its current
identity. A deleted account, changed provider, or changed username is skipped.
A directory write that succeeded before a local failure is verified again
before retrying, and PostgreSQL updates commit together.

Inspect `auth:ipa:backfill` logs and the pump run in observability for failures.
After two failed attempts, the affected account job enters the
`auth:ipa:backfill:account` dead-letter store. Later accounts continue. Resolve
the provider error and retry that dead letter to retain the original target.
Disabling FreeIPA during a run fails unfinished account jobs rather than
marking them complete.

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
