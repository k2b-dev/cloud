---
title: Deprecations and migrations
navTitle: Deprecations
section: Reference
order: 1250
description: Find removed or superseded APIs and the supported migration path.
tags: [deprecations, migrations, compatibility]
updated: 2026-09-08
---

# Deprecations and migrations

## Grids schema baseline: bridge update

This update retains the existing Grids migration paths and records
`grids_schema_baseline_v1` after they finish successfully. Fresh databases
receive the same marker. It uses the existing `grids.storage_contracts` table
and commits with the schema changes; repeated startup preserves its original
`activated_at` timestamp.

Before updating an older installation, back up PostgreSQL and stop old Grids
replicas and writers. Existing alpha migrations still include intentional
removal of obsolete workflow, dashboard, and access structures; this update
does not make those old transitions lossless. Start the bridge version after
Core has prepared its authentication and workflow schemas, then verify:

```sql
SELECT name, activated_at
FROM grids.storage_contracts
WHERE name = 'grids_schema_baseline_v1';
```

One row confirms that the migration completed and checked the public-ID schema,
the scalar contract, the workflow contract, and App definition versions. It does not certify
artifact contents, business validity, or recovery of previously lost data.
Missing resources can still leave a v5 App draft editable but invalid.
An older App definition, including an archived one, prevents the first baseline
activation; recover that definition and retry rather than inserting the marker
manually. A failed migration does not create the marker.

Keep a verified backup and the bridge build available. Do not run older Grids
binaries against the marked schema. The planned next update will remove old
migration code and accept only fresh schemas or this baseline; an older
installation will need this bridge update first. That removal and rejection
gate are **not part of this update**. Removing migration code must not delete
current Records, grants, number-series state, Documents, or retained history.

## Mail automation authority is mandate-only

Mail incoming automations no longer create, store or forward user API tokens.
Spaces actions require a mandate and Mail's app-bound `identity:invoke`
credential. The authority-mode flag and credential backfill have been removed.

Mail is unreleased alpha, so this change does not convert old automation data.
Use a fresh Mail schema when replacing an older alpha installation. Existing
test data and previously issued credentials are not deleted automatically;
resetting them is a separate operator action, not an application startup step.

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
pools can fail on cold caches. Drain every old replica before the coordinated
hard cut; no issuance-mode or old-writer fallback remains. See the
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
browser and OAuth hard cut below must be coordinated with it.

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

### OAuth signing hard cut

OAuth no longer accepts `CLOUD_APP_CREDENTIAL` or the Compose input
`CLOUD_OAUTH_APP_CREDENTIAL`. Replace them with `CLOUD_OAUTH_BROKER_SECRET` on
Core and OAuth; see [Runtime configuration](/en/docs/operations/runtime-configuration).
Revoke any previously provisioned OAuth workload credential through the admin
identity API. The retired `identity:oauth-issue` scope is no longer provisionable
and remains blocked at ordinary API entry points. Client secrets are unrelated
and do not need replacement.

Include every OAuth replica in the maintenance window. Configure the same
`CLOUD_OAUTH_BROKER_SECRET` exclusively on Core and OAuth, start updated Core,
then start updated OAuth. Its migration drops only the obsolete `oauth.keys` and
`oauth.issuance_state` tables and the old code-audience compatibility trigger.
Client registrations, client secrets, authorization codes and refresh families
are retained. Existing code snapshots are backfilled where needed.

Old OAuth access and ID tokens are no longer supported by the updated Cloud.
Clients with a valid refresh grant can obtain Core-issued tokens; others need
another authorization. No supported OAuth grant type, PKCE, dynamic
registration, consent or resource-binding feature is removed. Clients using
discovery do not need a new client ID or secret. A client that manually pins
signing keys must load Core's keys from the unchanged public JWKS URL. An
external client's cached old keys are not remotely erased by this update.

The combined `/.well-known/cloud-identity-jwks.json` endpoint is removed.
Current applications use the separate session and invocation JWKS endpoints.
Do not restart old binaries against this schema. Restoring removed signing
material requires the pre-upgrade database backup; there is no signing-mode
rollback switch.

Scheduled AI/chat tasks without a stored mandate no longer acquire one during
background execution. Admission marks them `needs_attention`; the owner must
delete and recreate them. Existing mandated tasks are unaffected. This removes
the system-migration authority path, including the obsolete Mail variant.

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

`@k2b/cloud/shared` continues to re-export `dates`, `calendar`,
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
