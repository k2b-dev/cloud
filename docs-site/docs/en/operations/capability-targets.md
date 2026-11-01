---
title: Roll out capability targets
navTitle: Capability targets
section: Operations
order: 1258
description: Upgrade Core and capability providers while applications adopt explicit resource targets.
tags: [operations, capabilities, upgrades]
updated: 2026-11-01
---

# Roll out capability targets

Upgrade Core before deploying an application that declares capability `target`,
`refs`, or `code: false`. Then upgrade capability callers to send resource
coordinates beside `input`. Chat and MCP callers keep flat tool arguments;
the platform converts them into the same call.

This is an additive rollout. Applications without target declarations keep
their existing input, schema hashes, approval digests and idempotency behavior.
Converting an existing Action's resource ID input into a target changes its
contract and schema hash. Core now migrates existing routine grants and pending
approvals for the coordinated application conversion; see the
[operator migration note](/en/docs/reference/deprecations-and-migrations#existing-assistant-routines-and-approvals-adopt-capability-targets).
Existing chats and their stored history stay unchanged.

Legacy mandates constrain domain input only. They are refused for operations
that declare targets or refs unless an explicit target grant covers the call.
Migrate stored work to the [target grant format](/en/docs/identity/background-mandates#bind-operations-to-targets)
before enabling these operations for background callers. Never discard an old
fixed target field when migrating a routine; unresolvable restrictions require
`needs_attention`. Code version invocations use their mandate instead of
credential scopes and human app-entry rules, while each target still checks
the Code account's own resource access.

Human app-entry rules, including admin-only roles, guest restrictions and app
access lists, do not disable confirmed Code version invocations. To stop that
Code, pause or revoke its mandate, disable its account, or remove its own access
at the target. People's app-entry checks continue to apply to personal Code
and person-owned routines.

A resource-bound approval and idempotency claim include the target and every
additional reference. Reusing a key with a different target returns
`IDEMPOTENCY_CONFLICT`. A target of the wrong type or a missing additional
reference returns `VALIDATION_FAILED` before application execution. A stale
provider schema returns `SCHEMA_MISMATCH`; refresh the catalog.

Older Core readers omit operations with target fields they cannot understand.
They do not invoke those operations after stripping the fields. Other
operations remain available.

Spaces and Contacts Actions now use fixed `space` and `book` targets.
Creation inputs omit `spaceId` and `bookId`; contact moves carry their
destination in `refs.targetBookId`. Upgrade Mail with these providers so its
calendar, linked-item and contact-creation calls send the new coordinates.
Directory providers implementing `create` declare a local `book` Type and
move the selected book out of `ContactDirectoryCreateInputSchema`.

The Spaces invitation preparation and commit Actions declare `code: false`.
Resource-owned Code must leave them out; person calls keep their service
permission checks. Core performs the coordinated routine and approval migration before starting
its AI workers.

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

Deploy Spaces and Mail with the `managerUserIds` set-result field before enabling
Cloud-admin activation in Core. A successful dry-run identifies the current
person managers, including nested manager-group members. Core refuses Cloud-admin
activation when the target cannot identify its managers. No new configuration or
migration is needed for this result field. A target with more managers than the
capability response budget allows refuses preflight with a reason; reduce that
target's manager audience before trying again. During a directory update, retry
a transiently unavailable manager check after the update finishes.

Keep the adapter available while its app has Code grants to remove. Core must
finish target cleanup before deleting the Code account. Live grants prevent
account deletion; removing them releases that reference and preserves replay
tombstones. An unavailable target returns a retryable cleanup failure.
Core can inspect and remove a disabled Code account's grants; setting new
grants requires an active account. Generated access calls require explicit
operation-bound Core editor admission.

See [Code access at the target](/en/docs/platform/capabilities#code-access-at-the-target)
for the adapter and Core proof contracts.

## Converted application Actions

Notebooks binds note, comment and annotation Actions to the notebook. Pulse
binds existing-resource Actions to the Base. Venue binds assignments to the
venue, Weather binds deletion to the saved location, and Core binds Skill
changes to the Skill and routine changes to the AI chat. Chat binds message
changes to the message and notification preferences and follows to the
conversation. Their primary resource selectors move from `input` to `target`;
refresh generated clients and the capability catalog together with these apps.

All Chat Actions declare `code: false` for resource Code, including
personal notification preferences. Calls acting as a person retain their existing permission checks.
