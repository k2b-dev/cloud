---
title: Roll out capability targets
navTitle: Capability targets
section: Operations
order: 1258
description: Upgrade Core and capability providers while applications adopt explicit resource targets.
tags: [operations, capabilities, upgrades]
updated: 2026-10-31
---

# Roll out capability targets

Upgrade Core before deploying an application that declares capability `target`,
`refs`, or `code: false`. Then upgrade capability callers to send resource
coordinates beside `input`. Chat and MCP callers keep flat tool arguments;
the platform converts them into the same call.

This is an additive rollout. Applications without target declarations keep
their existing input, schema hashes, approval digests and idempotency behavior.
Existing chats, pending approvals and routine grants are not migrated by this
change. Converting an existing Action's resource ID input into a target changes
its contract and schema hash; coordinate that application's callers and stored
work before deploying its converted declaration.

Legacy mandates constrain domain input only. They are refused for operations
that declare targets or refs. Upgrade target-aware grant support and migrate
stored work before enabling these operations for background callers.

A resource-bound approval and idempotency claim include the target and every
additional reference. Reusing a key with a different target returns
`IDEMPOTENCY_CONFLICT`. A target of the wrong type or a missing additional
reference returns `VALIDATION_FAILED` before application execution. A stale
provider schema returns `SCHEMA_MISMATCH`; refresh the catalog.

Older Core readers omit operations with target fields they cannot understand.
They do not invoke those operations after stripping the fields. Other
operations remain available.

See [App capabilities](/en/docs/platform/capabilities#name-the-resource-an-operation-acts-on)
for the declaration, invocation and digest contract.

## Enable target-side Code access

Upgrade Core before deploying providers with Code access adapters. Core's
capability migration creates `capabilities.code_access_grants`, the platform's
routing and replay index. Applications keep owning their actual permission
rows. No new environment settings are required; proofs use Core's existing
invocation signing keys and public invocation JWKS.

Deploy each provider with all four adapter functions together. A type with
`access`, or a type named in `code.owners`, must have a declared reader or the
provider refuses startup with the type's name. Existing `readable`-only
declarations remain supported when their Type has a reader. This also applies to third-party providers: add a canonical reader
before upgrading if a Type currently declares `access.readable` alone. New
generated Actions carry `unattended: false`, so older Core readers omit them instead of stripping that restriction.

Adapters implement `manages(tx, context, id)`: manager checks run inside the write
transaction and retain locks shared with the provider's manager-change paths.
Update older two-argument adapters before deploying this contract; use the
supplied connection for every adapter query.

Keep the adapter available while its app has Code grants to remove. Core must
finish target cleanup before deleting the Code account. Live grants prevent
account deletion; removing them releases that reference and preserves replay
tombstones. An unavailable target returns a retryable cleanup failure.
Core can inspect and remove a disabled Code account's grants; setting new
grants requires an active account. Generated access calls require explicit
operation-bound Core editor admission.

See [Code access at the target](/en/docs/platform/capabilities#code-access-at-the-target)
for the adapter and Core proof contracts.
