---
title: Deprecations and migrations
navTitle: Deprecations
section: Reference
order: 1250
description: Find removed or superseded APIs and the supported migration path.
tags: [deprecations, migrations, compatibility]
updated: 2026-09-02
---

# Deprecations and migrations

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
Keep the existing session and OAuth compatibility windows; this coordinated
mandate cutover does not require discarding user credentials.

## Widget response validation and budgets

Widget responses remain extensible: unknown fields are stripped. Safe relative
links and absolute HTTP(S) links remain accepted, while active schemes and
oversized or malformed payloads are rejected. Dashboard runs eight requests at
a time with 500 ms per started widget and a page budget derived from the number
of waves. See [Dashboard widgets](/en/docs/platform/dashboard-widgets).

## Browser sessions move from Valkey to JWT families

The release initially keeps `CLOUD_SESSION_ISSUANCE_MODE=legacy`. Deploy that
dual-read release to every application first. Then change only Core to
`CLOUD_SESSION_ISSUANCE_MODE=jwt`; new logins use signed
`cloud-session+jwt` credentials backed by PostgreSQL session families.
Existing opaque `userId:random` credentials remain readable from Valkey until
their configured original expiry, so the rollout does not log users out.

During this compatibility window, revoke-all updates both the PostgreSQL
`auth_epoch` and the legacy Valkey generation. Individual logout revokes the
JWT family or deletes the opaque session as appropriate. Operators should use
the bounded `legacy_session_use` process metric and the durable sampled
`Legacy session compatibility path used` log to establish a zero-use grace
period before removing the legacy reader in a later release.

Applications do not need to change cookie or Bearer handling. Code that parsed
the old opaque value was never a supported contract and must switch to the
request `actor` and `accessSubject`.

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
