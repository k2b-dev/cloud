---
title: Deprecations and migrations
navTitle: Deprecations
section: Reference
order: 1250
description: Find removed or superseded APIs and the supported migration path.
tags: [deprecations, migrations, compatibility]
updated: 2026-09-26
---

# Deprecations and migrations

## Contacts CLI commands

`cld contacts` now uses the shared command verbs and addresses contacts by
ID or `<book>:<name>`. The old command names are removed without aliases;
scripts must switch to the new names. The `--book` and `--contact` flags and
the local default book (`use`, `current`) are gone: pass the book in every
address. `show --email <address>` finds a contact by email. Contact JSON input
is `--from <file|->` instead of `--json-input` and `--stdin`; note text is
`--from <file|->` or `--content <text>` instead of `--file` and `--stdin`.
Destructive commands need `--yes` without a terminal. See
[Contacts](/en/apps/contacts#automate-contacts-from-the-terminal).

| Old command | New command |
| --- | --- |
| `books` | `ls` |
| `use`, `current` | removed; pass the book in every address |
| `book` | `show <book>:` |
| `create-book [--use]`, `update-book`, `delete-book` | `books add`, `books update`, `books delete` |
| `list` | `ls <book>` (`--q`, `--tag`) |
| `get` | `show <contact>`, `show --email <address>` |
| `create` | `add <book>[:<name>]` |
| `update` | `set <contact>` |
| `move --target-book` | `mv <contact> <book>` |
| `delete` | `rm <contact>` |
| `notes`, `note`, `update-note`, `delete-note` | `notes list`, `add`, `update`, `delete` |
| `tags`, `create-tag`, `update-tag`, `delete-tag` | `tags list <book>`, `tags add\|update\|delete <book>:<tag>` |
| `import-preview` | `import <book> --from <file\|-> --dry-run` |
| `--query` | `--q` |
| `--output` | `--out` |
| `--firstName`, `--per_page`, and other camelCase or snake_case aliases, `--parent-contact` | the kebab-case flag (`--first-name`, `--per-page`), `--parent` |

`import` without `--dry-run` now creates the previewed contacts, skipping
matches unless `--include-duplicates` is given. `search`, `tree`, `export`,
and the `access` group keep their names. The Contacts API adds
`GET /api/contacts/resolve`. No stored data changes.

## Notebooks CLI commands

`cld notebooks` was rebuilt around note addresses and a local Markdown mirror.
The old command names are removed without aliases; scripts must switch to the
new names. Notes are addressed as a note ID, `<notebook>:<path>`, or a file in
a pulled mirror instead of `--notebook` and `--note` flags, and the local
default notebook (`use`, `current`) is gone. Content input is `--from <file|->`
or `--content <text>` instead of `--file`, `--stdin`, and `--content`. See
[Notebooks](/en/apps/notebooks#automate-notebooks-from-the-terminal).

| Old command | New command |
| --- | --- |
| `list` | `ls` |
| `use`, `current` | removed; pass the notebook in every address |
| `get` | `stat <notebook>:` |
| `notes` | `ls <notebook>[:<path>]` |
| `note`, `content`, `read` | `stat <note>`, `cat <note>` (`--json`, `--numbered`, `--blocks`) |
| `block` | `cat <note> --block <name>` |
| `create-note` | `write <notebook>:<path> [--parents]` |
| `edit --set-content` | `write <note>` |
| `move-note` | `mv <note> <target>` |
| `copy-note` | `cp <note> <notebook>[:<path>]` |
| `delete-note` | `rm <note>` |
| `lock-note` | `lock <note>` |
| `search --all`, `tag-notes` | `search [query] [--notebook] [--tags]` |
| `favorite`, `unfavorite`, `favorites` | `favorites add`, `favorites remove`, `favorites list` |
| `comments`, `add-comment`, `update-comment`, `delete-comment` | `comments list`, `add`, `update`, `delete` |
| `versions`, `version`, `restore-version` | `versions list`, `versions cat`, `versions restore --into` |
| `upload-attachment` | `attach <note> <file>` |
| `attachments`, `download-attachment`, `delete-attachment` | `attachments list`, `download`, `delete` |
| `attachment`, `attachment-usage` | `attachments list --json`, usage shown by `attachments delete` |
| `create-from-template` | `create <name> --template <id>` |
| `api-keys`, `create-api-key`, `revoke-api-key` | `api-keys list`, `create`, `revoke` |
| `snapshot`, `update-snapshot`, `snapshot-logs`, `run-snapshot` | `snapshots show`, `set`, `logs`, `run` |
| `--output-file` | `--out` |

`cld notebooks create` now creates an empty notebook without the welcome note;
the web UI still seeds it. The Notebooks API adds `GET /api/notebooks/notes/:noteId`,
`GET /api/notebooks/:id/outline`, and `GET /api/notebooks/:id/resolve`, and
`POST /api/notebooks/:id/notes` accepts `parentPath` and `createParents`. No
stored data changes.

## Spaces CLI commands

`cld spaces` now uses the shared `cld` verbs and item addresses. The old
command names are removed without aliases; scripts must switch to the new
names. An item is addressed as an item ID or `<space>:<title>` instead of a
leading space argument or `--space`, and the local default space (`use`,
`current`) is gone. Text input is `--from <file|->` instead of `--file` and
`--stdin`; `--page-size` is `--per-page`. See
[Spaces](/en/apps/spaces#automate-spaces-from-the-terminal).

| Old command | New command |
| --- | --- |
| `list` | `ls` |
| `use`, `current` | removed; name the space in every address |
| `get [space]` | `show <space>:` |
| `create` | `create` (no `--use`) |
| `items [space]` | `ls <space>` |
| `items --assigned-to me`, `unassigned` | `ls <space> --mine`, `--unassigned` |
| `items --deadline`, `--activity inactive` | `ls <space> --due`, `--inactive`; new `--due-before` |
| `item [space] <item>` | `show <item>` |
| `add-item [space] <title> --column` | `add <space>:<title> [--column]` (defaults to the first column) |
| `update-item [space] <item>` | `set <item>` |
| `update-item --column` | `mv <item> <column>` |
| none | `rm <item> --yes`, `assign <item> <user\|me\|none>`, `due <item> <date\|none>` |
| `blockers`, `blocks` | `deps <item>` |
| `block <task> <blocker>` | `deps <task> --add <blocker>` |
| `unblock <task> <blocker>` | `deps <task> --rm <blocker>` |
| `comments` | `comments list` |
| `comment` | `comments add` (new `comments update`, `comments delete`) |
| `attachments` | `attachments list` |
| `add-attachment --file <path>` | `attachments add <item> <path>` |
| `download-attachment --output` | `attachments download <item> <attachment> --out` |
| `delete-attachment` | `attachments delete` |
| `checklist add --label <text>` | `checklist add <item> <text>` |
| `references remove` | `references delete` |
| `calendar --from --to` | `calendar <start> <end>` |
| `overlap --from --to --exclude-item` | `overlap <start> <end> --exclude <item>` |
| `activity`, `work`, `claim`, `release`, `progress`, `done`, `reopen`, `invitation context`, `invitation draft`, `access …` | unchanged names; the item is one address argument |
| `--file`, `--stdin` | `--from <file\|->` |
| `--page-size` | `--per-page` |

The Spaces API adds `GET /api/spaces/items/:itemId` and
`GET /api/spaces/resolve?space=&title=`; the item filter accepts
`deadlineBefore`, and assignable users include `uid`. No stored data changes.

## Workflow action costs

Move budget counts from `plan().consumes` into the action's `cost(ctx, config)`
hook. `plan()` now produces only dry-run summaries, issues and optional output;
it is never called during execution. Both modes use `cost()` for budget counts.
Update all action declarations together with the platform; there is no fallback
to `plan().consumes`. No stored workflow data migration is required.
See [effect budgets](/en/docs/automation/effects-retry-and-reconciliation#plan-and-charge-effects).

## Contextual Universal Search

Search Queries now accept an optional resource scope in the canonical input
schema and may declare local `scopeTypes`. Update all search-provider images
together with the platform; old manifests do not match the new shared schema.
No stored data changes are required. Use
[the shared browser search API](/en/docs/platform/search#open-search-from-an-application)
in place of app-local navigation Spotlight dialogs. Selection pickers remain
separate.

## Production configuration cleanup

Built-in images use production mode and port 3000. Remove runtime `APP_ID`
and `PORT` overrides; application identity comes from its declaration. Build
and development scripts still accept `APP_ID` to select an application.

FreeIPA and Files no longer import environment configuration. Configure the
`freeipa.*` (including group rules) and `files.filegate_*` settings in administration.
Remove Cloud-side `FREEIPA_*`, `GROUPS_*`, `FILEGATE_URL` and `FILEGATE_TOKEN`
bootstrap inputs. Filegate's own server configuration remains separate.

Grids query limits moved to `grids.query_pool_size`, `grids.query_concurrency`,
`grids.query_queue_limit` and `grids.query_queue_timeout_ms` on its admin page.
Remove the corresponding `GRIDS_QUERY_*` environment variables. Restart all
Grids instances after saving these settings.

Mail's unreleased Google/Microsoft managed OAuth integration has been removed:
provider environment variables, `mail.oauth.*` settings, browser callbacks,
automatic token refresh and reconnect flows are no longer available. Users
create IMAP/SMTP connections with a password, app password or manually supplied
access token. Manual access tokens are not renewed automatically. No migration
of old alpha managed OAuth connections is provided; use a fresh Mail schema.
The Cloud OAuth application and its client integrations are unchanged.

Mail's alpha migration chain (versions 1 to 126) was collapsed into a single
baseline schema. Mail has never been deployed, so no upgrade path exists: a
development database that still holds the old versions is refused at startup and
is reset with `DROP SCHEMA mail CASCADE;`.

Pulse is included in production Compose and the release image set. Fresh Core
installations use an explicitly supplied temporary `ADMIN_LOGIN_TOKEN` for
first access; see [Deployment requirements](/en/docs/operations/deployment-requirements).

## Grids starts with a fresh schema

Grids creates its current schema at startup. There is no in-place migration
from older Grids schemas. Before switching an existing installation, the
operator must stop Grids and explicitly reset its schema and Grids-owned
shared workflow and access data. This discards the existing Grids content;
keep any required backups or exports separately. Delete only Grids-owned rows
in shared Core tables, never the shared schemas or another application's data.
Start Core before Grids. Subsequent Grids starts preserve the current data.

### Reset an existing Grids installation

This procedure permanently discards Grids content, workflow runs, generated
documents, and resource-bound credentials. It is not an upgrade that preserves
data. Confirm the target database and NATS namespace, obtain approval for this
scope, and keep a restorable backup before starting. A schema-only reset is
incomplete: old kernel runs would still appear in Grids health reports.

Stop every Grids replica and worker, and prevent new Grids invocations during
the maintenance window. Inventory foreign keys and cross-application references
before deleting anything. If another application references a Grids resource or
service account, stop and resolve that dependency; do not let `CASCADE` remove it.

Perform the database cleanup in one transaction, in this order:

1. Capture access IDs from `grids.base_access` and `grids.custom_app_access`,
   Grids resource-bound service accounts and their grants, and kernel workflow
   and event IDs where `app_id = 'grids'`. Retain this inventory until verified.
2. Check that captured grants and service accounts are not used by another
   application. Preserve shared grants and ordinary user accounts.
3. Delete `workflows.event_delivery` rows referencing the captured workflow
   **or** event IDs. Delete rows from `workflows.workflow`, `workflows.event`,
   and `workflows.dependency_signal` only where `app_id = 'grids'`. Their
   kernel child rows are removed through foreign keys.
4. Delete `capabilities.idempotency_claims` and `capabilities.executions` only
   where `app_id = 'grids'`, so old results cannot be replayed.
5. Run `DROP SCHEMA grids CASCADE` only after the dependency checks above.
6. Delete captured, exclusively Grids-owned `auth.access` rows. Remove mandates
   only where `owner_app_id = 'grids'`, then the captured resource-bound service
   accounts and their credentials. Do not delete delegated user accounts.
7. Commit. On an unexpected dependency or error, roll back and investigate.

PostgreSQL and NATS cleanup are separate operations. Keep Grids stopped until
both finish. Inventory streams by their Sync metadata, not a guessed name
prefix. Delete only streams with the verified `sync.namespace`,
`sync.owner=grids`, and these resource IDs, including their associated
key-value and dead-letter streams:

- `grids:workflow-record-events`
- `grids:evidence-export`
- `grids:controlled-destruction`
- `grids:workflows`
- `grids:external-record-operation-retention`
- `grids:records`
- `grids:metadata`
- `grids:workflow-runtime`
- `grids:workflow-runs`

Do not delete shared volumes, other namespaces, or other applications' streams.
If transport cleanup fails, leave Grids stopped and resume from the inventory;
do not start new workers against old queued work.

Start the updated Core before the updated Grids. Check gateway registration,
an authenticated Grids page, empty Base/Record/Document lists, and the health
view for leftover Grids runs. Confirm a second Grids start preserves the schema
and any newly created data. Old Grids links in other applications remain but
point to removed resources; do not delete their chats or audit history.

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

Use the [coordinated upgrade checklist](/en/docs/operations/deployment-requirements#coordinate-an-existing-installations-identity-upgrade)
for preparation, startup order, verification, and rollback. The contract below
defines what changes for sessions and OAuth clients.

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

## Encoded JSON metadata upgrade

For upgrades from the June 23, 2026 production baseline, the startup migrations
automatically repair encoded deleted-account, audit, and Venue objects. They discard
malformed Tools logs and Gateway registry snapshots, and cancel notification batches with
invalid selection containers. Valid data survives repeated startup. Stop old
writers before starting updated services; no manual repair command is required.
See [JSON metadata upgrade](/en/docs/operations/repair-jsonb-containers) for the
preservation rules and optional diagnosis. The NATS, identity, and OAuth release
prerequisites still apply independently.

## Notification delivery upgrade

When replacing the queue-based notification runtime, stop old application
instances before starting the new version. Preserve notification tables:
startup recovery resumes accepted pending deliveries and scheduled retries.
The job-based runtime does not consume old queues. Remove their transport
resources only after verifying delivery recovery.

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

## Help moves to Postgres

Update Core and every Help-producing application to the same new Cloud release.
This is a coordinated breaking change; old processes still write the retired
NATS Help registry and cannot populate the new store.

1. Prepare the new application images and the existing Postgres connection.
2. Run Core setup to create the Help schema and start the updated Core readers.
3. Restart every application with the updated Cloud package. Each application
   publishes its packaged Markdown before advertising readiness.
4. Verify an article, a search, and an AI or MCP Help read in the intended language.

No export or import of the old NATS Help registry is required. Keep app-owned
Markdown and `app.start({ help })`. The dedicated Help ephemeral and its
`helpRegistry`, `getHelp`, `listHelp`, and `HELP_REGISTRY_CONFIG` exports are
removed, along with the old registry corpus types and `resolveHelpManifest`.
Apps should use the automatic Help surfaces instead of those platform internals.
Runtime app metadata now contains a Help reference rather than article lists.
The article endpoint returns `HELP_NOT_FOUND` (404) for an absent article or
published version; the old `HELP_STALE` response is retired. Search returns no
matches for an absent app or version. Database failures still return errors.

Core owns the SQL schema. If it is missing, rerun Core setup before restarting
applications. Existing app heartbeats restore missing collections once the
schema is available. See [In-product Help](/en/docs/platform/help) for search,
limits, and lifecycle behavior.

Do not upgrade a Postgres volume merely to enable optional BM25. Native search
works without that extension. Rolling back requires a consistent old image set
and application restarts to repopulate its NATS registry; retained SQL rows do
not make old readers compatible. Retired NATS resource removal is a separate
operator action after verifying the cutover.

## Workspace mobile navigation

The `AppWorkspace.SidebarMobileTrigger`, `SidebarMobile`, `SidebarMobileItems`,
and `SidebarMobileBody` slots and their prop types have been removed. There is
no compatibility renderer. Use `createNavigation` and let the host render
`Navigation`; Cloud applications bind it through `WorkspaceNavigationProvider`
or the SSR `WorkspaceNavigation` island. Keep `SidebarDesktop` for desktop.
See [Application shells](/en/docs/frontend/application-shells#supply-mobile-navigation).


## Capability protocol 2

Capability manifests now include a required `commands` array. Providers declare
`protocolVersion: 2`; compilation emits an empty array when no Commands are
published. Protocol 1 manifests are rejected, with no compatibility adapter.
Upgrade the shared package and every provider together. The existing
`/capabilities/v1` HTTP routes remain unchanged; the manifest protocol is a
separate contract. No database migration is required.

Mail's interactive task/event creation now opens the owning Spaces form through
a Command. The old Mail `POST .../conversations/:conversationId/spaces/items`
and `GET .../spaces/:spaceId` form-support routes are removed. Existing resource
link/unlink operations and calendar automation continue to use their domain APIs.

## Application keyboard shortcuts

Register browser context commands with an optional `shortcut` instead of
application `hotkeys.create()` calls or window key listeners. Remove the old
registration when moving each action; retaining both executes it twice.
Shortcut-only event relays should call the existing command or search API.
See [Context command shortcuts](/en/docs/platform/search#context-command-shortcuts).

The portable UI package no longer exports `isSpotlightShortcut` or
`SPOTLIGHT_SHORTCUT*` constants. `SpotlightButton` has no implicit shortcut
label. Supply `shortcutLabel` only when the host actually owns that binding.
