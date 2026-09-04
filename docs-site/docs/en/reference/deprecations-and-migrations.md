---
title: Deprecations and migrations
navTitle: Deprecations
section: Reference
order: 1250
description: Find removed or superseded APIs and the supported migration path.
tags: [deprecations, migrations, compatibility]
updated: 2026-09-04
---

# Deprecations and migrations

## Notebook scripts are now inert Markdown

Notebooks no longer executes fenced `script` blocks. Existing source remains
in each note as visible code. Use `:::toc` for an in-note contents list and
`:::query` with named `:::data` properties for notebook summaries. Update
automation that sends `scriptsEnabled` or uses `--scripts-enabled`; the
setting and script-specific APIs are removed.

The shared `markdown.render()` and `markdown.renderSync()` helpers also render
`script` fences as ordinary code blocks. They no longer emit executable source
carriers or output containers. Application authors must remove any custom
enhancer that depended on those carriers; Markdown rendering does not execute
user code. Help examples remain inert.

## Identity authority rollout prerequisites

Deploy Core's purpose-specific session and invocation JWKS endpoints before
their consumers. Every Core replica behind the configured JWKS origin must
support them, including when Core is itself a consumer. Mixed old/new endpoint
pools can fail on cold caches. Keep all issuance modes in `legacy` until the
corresponding consumers are compatible. Upgrade every OAuth writer to the
database-gate-aware version before enabling Core OAuth issuance. See the
network, database, clock, and rollout requirements in
[Runtime configuration](/en/docs/operations/runtime-configuration).

The public gateway now rejects HTTP and WebSocket paths containing an
`_internal` segment. Broker callers must use the private Core origin. This is
an ingress boundary, not a substitute for workload authentication.

## Confirmed-only mandate coordinates require a coordinated cutover

The mandate uniqueness index now covers confirmed active or paused rows only.
This prevents pending registrations from reserving another workload's identity.
The previous targeted `ON CONFLICT` statement cannot run against that new
index and fails with PostgreSQL `42P10`. This schema change is not compatible
with old mandate-writing processes.

Before starting a Core version that migrates this index:

1. stop mandate-writing Core and application processes, including background
   workers and separately deployed applications using the old Cloud package;
2. update every writer to the version using `ON CONFLICT DO NOTHING`;
3. start updated Core to migrate, then start the updated application writers;
4. verify interactive creation, pending confirmation, and background delivery
   before restoring workload creation traffic.

Do not restart old mandate writers against the new schema. An operator needing
a rolling upgrade must first deploy a compatibility release that changes only
the insert conflict handling on every writer, then deploy the index migration.
This mandate-index change does not itself revoke credentials. The JWT-only
browser hard cut below has a separate coordinated rollout; OAuth retains its
own verification grace.

## Widget response validation and budgets

Widget responses remain extensible: unknown fields are stripped. Safe relative
links and absolute HTTP(S) links remain accepted, while active schemes and
oversized or malformed payloads are rejected. Dashboard runs eight requests at
a time with 500 ms per started widget and a page budget derived from the number
of waves. See [Dashboard widgets](/en/docs/platform/dashboard-widgets).

## JWT-only sessions and internal invocations

This is a coordinated hard cut, not a rolling compatibility release. All
Cloud users must sign in again. Existing OAuth clients, refresh grants, API
credentials, and background mandates retain their separate lifecycles.

1. Back up PostgreSQL and the Core identity-key encryption key. Drain old Core
   and application replicas, including background workers, before migration.
2. Deploy Core and every application with the JWT-only release. Keep the
   Core-only key encryption key configured and both purpose-specific JWKS
   endpoints reachable. There is no browser or invocation issuance-mode switch.
3. Core's migration revokes existing JWT browser families once and removes the
   legacy generation column. Opaque Valkey sessions are always rejected.
   Repeated migrations preserve new logins and do not change user epochs.
4. Verify a new login, logout, WebSocket reconnect, search, widgets, and an
   existing OAuth client before restoring traffic and background work.

Do not roll an old binary back onto the migrated schema. Recovery requires a
coordinated compatible release or restoration of the backed-up database and
keys. Do not flush shared Valkey: unused opaque session keys expire naturally;
old generation keys are no longer read or written.

Application code must use request `actor` and `accessSubject`, not parse or
persist session tokens. `session.createDelegation`, `session.getData`,
`session.parseToken`, and the legacy forwarding middleware are removed.
Use `session.authenticate` for live session reauthorization and the public
capability/mandate APIs for cross-application work. Internal capability and
widget endpoints reject browser cookies, OAuth tokens, and API keys; Core
issues target- and operation-bound invocation JWTs for them.

## Conversation files use one namespace

The alpha `/input` versus `/files` path policy was removed. Uploads and
assistant-created artifacts now share the absolute conversation namespace, and
the durable `origin` field owns overwrite policy. Turn payloads reference every
attachment, including images; inline base64 image parts and the CLI
`--workspace` upload switch were removed without a compatibility shim.

Deprecated APIs remain for source compatibility.

Do not use them in new code. Migrate one boundary at a time and keep behavior
covered by tests.

## Server helpers

| Old | Current |
| --- | --- |
| `validator` | `v` |
| untyped `apiClient` | `api.create<TApi>()` |

`validator` is an alias. Replace the import and keep the existing schema.

The old `apiClient` is untyped. Export the final Hono router type, then create a
typed browser client with the real base URL.

See [Browser clients](/en/docs/frontend/browser-clients-and-mutations).

## Access inputs

`getEffectivePermission()` still accepts `userId`, `userGroups`, and
`serviceAccountId`.

Pass `subject` instead.

```ts
await getEffectivePermission({
  accessIds,
  subject: c.get("accessSubject"),
});
```

`userGroups` is ignored. Cloud resolves direct and nested membership from the
authoritative platform tables.

See [Authorization](/en/docs/identity/authorization).

## Notifications

The email-only `notifications.send(params)` overload and
`notifications.sendToUser()` are deprecated.

Declare a typed notification in `defineApp({ notifications })`, then send the
bound definition:

```ts
await notifications.send(app.notifications.stockLow, {
  recipient: { userId },
  data: { itemId, itemName, remaining },
  idempotencyKey: `stock-low:${itemId}:${thresholdVersion}`,
});
```

This adds runtime validation, recipient policy, channel selection, and delivery
history.

See [Notifications](/en/docs/platform/notifications).

## UI

| Old | Current |
| --- | --- |
| `DockWorkspace` | `Panes` with application-owned layout state |
| `DateTimeInput` | `DatePicker` or `DateTimePicker` |
| `SettingsModal.subtitle` | Section descriptions |
| `SettingsModal.icon` | Tab icons |

`DockWorkspace` remains only for legacy screens. Do not extend its persistence
format.

Use the [UI catalog](/ui) to inspect the current UI contract.

## Shared utilities

Import generic utilities directly from `@k2b/stdlib`.

`@valentinkolb/cloud/shared` continues to re-export `dates`, `calendar`,
`encoding`, `fileIcons`, and `gradients` for older applications.

Cloud-specific shared helpers remain on the Cloud path.

## AI names

| Old | Current |
| --- | --- |
| `AiDataPolicy` | `AiDataBoundary` |
| `startAiRuntimeRecovery()` | `startAiRuntime()` |
| `aiConversationStore` | `aiConversations` |

The alpha AI service and runtime renames are hard cuts; there are no compatibility aliases.

## Remove compatibility code safely

1. search application source for the old symbol;
2. migrate and test each call site;
3. run the standalone package typecheck;
4. verify browser and server bundle boundaries;
5. remove local adapters that only supported the old shape.

The current package version does not assign removal dates to these APIs.
