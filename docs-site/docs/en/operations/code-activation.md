---
title: Code activation recovery
navTitle: Code activation recovery
section: Operations
order: 1255
description: Inspect durable activations and cleanup without recreating revoked target access.
tags: [code, operations, recovery]
updated: 2026-11-03
---

# Code activation recovery

Core runs activation and cleanup workers as part of its normal lifecycle. A
restart resumes unfinished activations with saved grant identities. No extra
service, environment variable or deployment step is needed after the additive
Core migration.

Use the [activation status routes](/en/docs/platform/code-activation) to identify
a blocked target or cancel an unfinished activation. `waiting` means a dependency
will be retried. If the original credential expires or is revoked, the process
rolls back and requires a new explicit activation. `rolling_back` means cleanup
is still pending; older grants and the previous active version remain intact.

For database inspection, `code.activations` is the durable process journal.
`code.activation_outbox` contains pending work with `attempts`, `last_error`,
`next_attempt_at` and `claimed_until`. Activation and cleanup use separate ordered
streams, so draining old runs do not block later activations. Restarting Core or
restoring a target provider lets the workers retry; do not delete outbox rows or
issue grants manually.

Old grants and mandates remain while their version has queued or running runs.
After those runs finish, cleanup removes grants no active version needs and
revokes drained version mandates. Target inspection uses Core's account-bound
`list` authority; compensation uses account-bound cleanup authority. Neither can
create access. An unavailable provider remains a retryable cleanup job.

Cloud-admin notifications use durable recipient rows and stable notification
idempotency keys. Retrying delivery does not create a second notice for the same
activation, target and person. Target access removed by a manager is never
restored by recovery, reconciliation or cleanup.

New Code version entries use app `runner` and `policy IS NULL`. Core owns their
activation and drain lifecycle. Update Core and the shared Cloud library in
capability providers together: provider admission now requires a run-bound,
active entry for personal Code as well as Code service accounts. Existing
`core` mandates keep their policies; do not clear those policies during an
upgrade. Confirm the new model by explicitly activating a new version.

After a policy-free entry exists, older Core versions cannot read that entry.
Upgrade Core and the invocation providers together; roll back only to a version
that understands nullable Code policies. Prefer rolling forward.

## Ordinary target grants during the access-model transition

Target managers can now add a Code service account through the target's ordinary
share service. It receives only direct View or Edit grants, never Manage,
group, signed-in or public access. Applications deployed with an older
`@k2b/cloud` must update before relying on this contract; see
[Authorization](/en/docs/identity/authorization#retain-manager-authority-while-changing-a-grant)
for the required transaction and lock order.

A concurrent identity, settings or directory write can make sharing return HTTP
409 with `retryable: true`. Retry the complete share operation after that write
finishes. Retrying never bypasses the current manager check. Administration
repairs recheck live Cloud-admin authority, including supported delegated
credentials; an app session does not supply that authority.

Existing activation adapters and their recovery workers remain until their
separate removal. This transition adds no migration, credentials, worker or
operator setting. To restore access intentionally removed by a manager, use the
normal share dialog; recovery does not recreate it.
