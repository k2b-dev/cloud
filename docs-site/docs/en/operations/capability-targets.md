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

Spaces and Contacts Actions now use fixed `space` and `book` targets.
Creation inputs omit `spaceId` and `bookId`; contact moves carry their
destination in `refs.targetBookId`. Upgrade Mail with these providers so its
calendar, linked-item and contact-creation calls send the new coordinates.
Directory providers implementing `create` declare a local `book` Type and
move the selected book out of `ContactDirectoryCreateInputSchema`.

The Spaces invitation preparation and commit Actions declare `code: false`.
Resource-owned Code must leave them out; person calls keep their service
permission checks. Stored routine grants and approvals still need the
coordinated migration before this branch is released.

See [App capabilities](/en/docs/platform/capabilities#name-the-resource-an-operation-acts-on)
for the declaration, invocation and digest contract.
