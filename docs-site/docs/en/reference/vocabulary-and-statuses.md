---
title: Shared vocabulary and statuses
navTitle: Vocabulary and statuses
section: Reference
order: 1240
description: Look up the terms and status values used across Cloud application APIs.
tags: [vocabulary, statuses, contracts]
updated: 2026-09-26
---

# Shared vocabulary and statuses

Use the shared term that matches the Cloud contract.

Do not create an application synonym for an existing platform concept.

## Identity and access

| Term | Meaning |
| --- | --- |
| Actor | Credential that made the request |
| User-backed actor | User session or delegated service account with a user |
| Access subject | Principal whose resource grants are checked |
| Principal | User, group, service account, authenticated users, or public |
| Permission | `none`, `read`, `write`, or `admin` |
| Resource-bound service account | Machine identity restricted to one application resource |
| Delegated service account | Machine credential acting for a user |
| Standalone service account | Machine identity with its own grants and no resource binding (`standalone` or `agent`) |
| Agent | Standalone service account that surfaces as an agent in pickers, activity, and audit |

An actor and access subject can differ.

See [Identity and access](/en/docs/identity).

## Application and runtime

| Term | Meaning |
| --- | --- |
| Application | Independently running HTTP service connected to Cloud |
| Application definition | Metadata and platform declarations passed to `defineApp()` |
| Application ID | Stable machine ID used in routes and registration |
| Built-in application | Application developed and released from the Cloud monorepo |
| Standalone application | Application developed and released from its own repository |
| Base URL | Stable internal service address used by the gateway |
| Resource | Domain object owned by an application |
| Route prefix | Top-level URL path published by an application |
| Registry entry | Current discoverable metadata for one application ID |
| Gateway | Edge service that forwards requests to applications by route prefix |
| Runtime snapshot | Registry-derived application state for one process or request |
| Capability | Executable integration passed to `app.start()`, such as universal search |
| Lifecycle | Application `setup`, `start`, and `stop` hooks |

The registry stores one logical entry per application ID, not one entry per
replica. Replicas refresh the same entry and share the same base URL.

## Platform definitions

| Term | Meaning |
| --- | --- |
| Setting | Typed operator-controlled runtime configuration declared by an application |
| Notification definition | Typed event contract for recipients, payload, presentation, and delivery |
| Search capability | Permission-aware provider that returns application resources to universal search |
| Dashboard widget | Application-owned endpoint rendered on the shared dashboard |

## Service results

Application services return `Result<T>`:

- `{ ok: true, data }`;
- `{ ok: false, error }`.

Common error codes map to bad input, unauthenticated, forbidden, not found,
conflict, dependency failure, and internal failure.

See [Services and results](/en/docs/server/services-and-results).

## Notification delivery

| Status | Meaning |
| --- | --- |
| `deferred` | A fallback waits for an earlier channel |
| `pending` | Delivery is ready for work |
| `sending` | A worker owns the attempt |
| `delivered` | The channel accepted delivery |
| `suppressed` | Delivery was intentionally skipped |
| `failed` | Delivery ended with an error |

See [Notifications](/en/docs/platform/notifications).

## Workflow runs

| Status | Meaning |
| --- | --- |
| `queued` | Waiting for a worker |
| `running` | Executing steps |
| `waiting` | Waiting for a durable dependency |
| `succeeded` | Completed successfully |
| `failed` | Completed with an error |
| `canceled` | Stopped by cancellation |
| `needs_attention` | Requires operator action |

Step planning can also report `planned`, `unsupported`, or `indeterminate`.

See [Workflow overview](/en/docs/automation/workflow-overview).

## AI turns

| Status | Meaning |
| --- | --- |
| `queued` | Turn is waiting for the AI worker |
| `running` | The model or a tool is active |
| `waiting_for_action` | Approval or a browser tool is required |
| `completed` | Turn finished successfully |
| `failed` | Turn ended with an error |
| `aborted` | Cancellation finished |

The browser controller uses presentation states such as `streaming`,
`stopping`, and `reconnecting`. These are UI states, not persisted turn states.

See [Chat runtime](/en/docs/ai/chat-runtime-and-streaming).

## Trace status

A trace span is `unset`, `ok`, or `error`.

An open span past the abandonment threshold is reported as stuck. It is not
still running merely because it has no end timestamp.

See [Tracing](/en/docs/platform/tracing).
