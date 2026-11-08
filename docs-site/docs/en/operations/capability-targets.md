---
title: Roll out capability targets
navTitle: Capability targets
section: Operations
order: 1258
description: Upgrade Core and capability providers while applications adopt explicit resource targets.
tags: [operations, capabilities, upgrades]
updated: 2026-11-02
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
Core migrates pending approvals before AI workers start. Old Assistant routine
mandates are revoked and their history is frozen at upgrade. Stop old Core and
Assistant replicas first; do not mix old and new workers. Mail rules are retired;
follow the [Mail cutover guide](/en/docs/operations/mail-automation-upgrade).
Follow the [operator migration note](/en/docs/reference/deprecations-and-migrations#capability-targets-major-release-operator-note)
for backups, restart order, confirmation states and rollback.
Existing chats and their stored history stay unchanged.

Legacy mandates constrain domain input only. They are refused for operations
that declare targets or refs unless an explicit target grant covers the call.
Migrate stored work to the [target grant format](/en/docs/identity/background-mandates#bind-operations-to-targets)
before enabling these operations for background callers. Never discard a fixed target field when rebuilding a workload;
unresolvable restrictions require a fresh review. Code version invocations use their mandate instead of
credential scopes and human app-entry rules, while each target still checks
the Code account's own resource access.

Human app-entry rules, including admin-only roles, guest restrictions and app
access lists, do not disable confirmed Code version invocations. To stop that
Code, pause or revoke its mandate, disable its account, or remove its own access
at the target. People's app-entry checks continue to apply to ordinary chats.

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

Pulse dashboard actions (`dashboard.save`, `dashboard.publish`,
`dashboard.unpublish`, and `dashboard.delete`) use a `pulse.base` target with
its public ID. Pass dashboard fields and revisions in `input`, without
`baseId`. Dashboard list queries keep `baseId`; the CLI keeps `--base`.

Examples of `code: false` include Chat Actions, Spaces invitation preparation
and commit, and Gateway Ops' app-status forget Action. Resource-owned Code
must leave them out; person calls retain their existing service permission checks.

## Enable normal sharing for Code

Deploy matching Core and platform versions with providers that support normal
Code service-account sharing. Targets need no Code declaration or adapter.
Keep resource `access.readable` and owner/page declarations where present.
Every share mutation retains current manager authority using
`lockAccessMutationAuthority` and the application's normal target lock.

Existing adapter-created shares are already ordinary permission rows and remain
at their current levels. Core retires the old target journals and cancels
unfinished legacy activations once; activation no longer creates target access.
See [Code activation recovery](/en/docs/operations/code-activation) for upgrade
and rollback constraints. The Mail target migration and Grids execution-account
workloads remain separate.
