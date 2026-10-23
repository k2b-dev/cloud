---
title: Operate Studio machine execution
navTitle: Studio machine execution
section: Operations
order: 1460
description: Monitor bounded Studio executions and their machine audit records.
tags: [operations, studio, service-accounts]
updated: 2026-10-23
---

# Operate Studio machine execution

Studio supports [explicit machine execution](/en/docs/identity/studio-machine-execution)
through the existing Assistant service and its managed Chromium sandbox.
Deploy the Assistant migration and runtime assets together. No new service,
environment variable, personal account or default execution grant is required.

Existing app grants retain their meaning. Machine execution and effect rights
start empty. App managers configure them in Studio permissions. Machine secrets
are separate from personal secrets and are encrypted with the existing Cloud
secret service.

Executions share Studio's existing limit of 8 code hosts and its 45-second
operation deadline. Database, shared storage and HTTP use their existing
configuration and budgets. Machine execution does not create or configure an
app database; an app manager prepares it first.

Audit events named `studio.machine.*` identify the machine account,
credential reference, app, published version, operation, request correlation
and outcome. They contain no source, input bodies, secret values or output
payloads. OAuth references are one-way credential fingerprints; API-token
references are credential IDs.

Execution status records retain the existing 2-day HTTP claim window and are
cleaned at admission. Requests outside the 1-day admission window cannot
replay after cleanup. An abandoned running request is reported as
`EXECUTION_UNKNOWN` when inspected after its operation deadline.

When execution ends without a known result, inspect the app's shared data and
external systems before issuing a new request. Studio never automatically
replays an admitted request. Revocation prevents the next operation; it cannot
undo an external effect already admitted.
