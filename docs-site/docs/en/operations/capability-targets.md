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

See [App capabilities](/en/docs/platform/capabilities#name-the-resource-an-operation-acts-on)
for the declaration, invocation and digest contract.
