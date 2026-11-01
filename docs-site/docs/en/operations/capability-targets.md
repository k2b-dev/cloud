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

This is a coordinated contract change for the major Code release. Every Action
with resource ID input must declare its resource target, including third-party
applications. Application authors must update their declarations themselves.
In this repository, the `capability-targets` check fails on missing declarations;
report-only mode has ended. Targetless application-wide Actions and shared
foreign-provider contracts retain their published shapes, as described in
[App capabilities](/en/docs/platform/capabilities#name-the-resource-an-operation-acts-on).

Converting an existing Action's resource ID input into a target changes its
schema hash. Refresh catalogs and generated callers with the provider upgrade.
Core migrates stored routine grants and pending approvals before AI workers
start. Stop old Core and Assistant replicas first; do not mix old and new
workers. Mail also migrates incoming automations before its workers start.
Follow the [operator migration note](/en/docs/reference/deprecations-and-migrations#capability-targets-major-release-operator-note)
for backups, restart order, confirmation states and rollback.
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

## Upgrade application callers

Use the provider's guide for its exact input changes:

- [Mail targets](/en/docs/platform/mail-capabilities) lists mailbox-bound
  Actions and Queries, plus discovery and outcome checks that keep their inputs.
- [Grids and Files targets](/en/docs/operations/grids-files-capability-targets)
  lists base, table, and storage-root calls and copy destination refs.
- [Spaces and Contacts migration](/en/docs/reference/deprecations-and-migrations#spaces-and-contacts-actions-name-their-container)
  covers Space and book targets and contact moves.
- [Chat discussion targets](/en/docs/platform/chat-discussions#action-targets)
  covers message and conversation targets and the foreign item exception.

Notebooks binds note, comment and annotation Actions to the notebook. Pulse
binds existing-resource Actions to the Base. Venue binds assignments to the
venue, Weather binds deletion to the saved location, and Core binds Skill
changes to the Skill and routine changes to the AI chat. These primary resource
selectors move from `input` to `target`; contained object IDs remain in `input`.
[Code version and execution Actions](/en/docs/platform/code-versions#submit-a-version)
use `core.code`, as do manual runs and secret set/delete Actions. Code Queries,
including `code.attention` and `code.attention.list`, retain their discovery and
filter inputs: the mandatory-target rule applies to Actions. Installation-wide
policy changes keep their group-rule input.

Examples of `code: false` include Chat Actions, Spaces invitation preparation
and commit, and Gateway Ops' app-status forget Action. Resource-owned Code
must leave them out; person calls retain their existing service permission checks.

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

Deploy the updated Core activation transport together with providers that expose
the generated Code access routes. Dry-run answers reveal only what the person
may read through the target Type's existing `access.readable`. Core obtains
Cloud-admin notification recipients through its separate target-bound server
authority; they are not required in an unreadable person's dry-run answer.
Adapters return the current human managers, including nested manager-group
members, on dry runs. A target that omits its audience refuses activation; a
network outage waits for retry. No new configuration or migration is needed. An
audience exceeding the capability response budget refuses preflight; reduce that target's
manager audience before retrying. During a directory update, retry a transiently
unavailable manager check after the update finishes.

Keep the adapter available while its app has Code grants to remove. Core must
finish target cleanup before deleting the Code account. Live grants prevent
account deletion; removing them releases that reference and preserves replay
tombstones. An unavailable target returns a retryable cleanup failure.
Core can inspect and remove a disabled Code account's grants; setting new
grants requires an active account. Generated access calls require explicit
operation-bound Core editor admission.

See [Code access at the target](/en/docs/platform/capabilities#code-access-at-the-target)
for the adapter and Core proof contracts.
