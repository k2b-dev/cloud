---
title: API surface
navTitle: API surface
section: Reference
order: 1205
description: Choose a supported Cloud import and check its runtime and stability.
tags: [api, imports, boundaries, compatibility]
updated: 2026-10-22
---

# API surface

Cloud separates APIs by runtime. Use the entry point for the code you are
writing.

`Supported` means application code may depend on the documented use. It does
not make every symbol in a mixed barrel an application API. `Platform-owned`
is for Cloud itself. `Advanced` paths are public exports, but application code
should use them only when a feature guide gives the exact import.
`Preview` means the contract may still change before its feature is released,
and such changes are not treated as breaking until then.

## Application entry points

| Entry point | Status | Use |
| --- | --- | --- |
| `@k2b/cloud` | Supported | Application declarations and typed notifications |
| `@k2b/cloud/server` | Supported, server-only | Hono middleware, validation, actors, results, and access |
| `@k2b/cloud/services` | Supported, server-only | Feature services named by a capability guide |
| `@k2b/cloud/contracts` | Supported | Browser-safe schemas and shared data contracts |
| `@k2b/cloud/browser` | Supported, browser | Typed Hono browser clients |
| `@k2b/ui` | Supported, SolidJS | Portable SolidJS components and interactions |
| `@k2b/stdlib/solid` | Supported, SolidJS | Owner-local queries, mutations, and browser interaction primitives |
| `@k2b/cloud/ssr` | Supported, server-only | Authenticated, anonymous, minimal, panel, and admin layouts; runtime context; request path; URL filters; `hintOpen` and `markHintSeen` for [one-time hints](/en/docs/frontend/ssr-pages-and-routing#one-time-hints-for-moved-paths) |
| `@k2b/cloud/workflows` | Supported | Workflow definitions and authoring contracts |
| `@k2b/cloud/ai` | Supported, server-only | AI APIs named by the AI guides |
| `@k2b/cloud/cli` | Supported | Cloud CLI modules |
| `@k2b/cloud/config` | Supported, server-only | Selected typed runtime values |

Use the barrels above by default. Use a subpath when the specialized-entry
table below links its feature guide.

Core's app bar administration uses `railShortcuts` from
`@k2b/cloud/services` and the `RailAdminSchema`, `RailAdminInputSchema`,
`RailAccessSchema`, `RailAdminState`, and `RailAdminEntry` contracts from
`@k2b/cloud/contracts`. These are platform-owned. Applications receive the
resolved navigation through `Layout`; see
[Global app bar shortcuts](/en/docs/frontend/layout-and-navigation#provide-global-app-bar-shortcuts).

## Define the application

Import `defineApp()` from the package root:

```ts
import { defineApp } from "@k2b/cloud";
```

The returned application's `ssr` renders pages and exposes `ssr.access` for
browser-route rejections and `ssr.error(c, status, options?)` for terminal HTML
errors. See [SSR pages and routing](/en/docs/frontend/ssr-pages-and-routing).

The root also exports the types bound to an application declaration. This
includes typed settings and notification definitions, and `skill()` with
`AppSkillDefinition` for [Assistant Skills](/en/docs/platform/assistant-skills). Registry, heartbeat, and
runtime-composition exports from the same barrel are platform-owned.

See [Define an application](/en/docs/build/define-app).

`PanelLayout` and `PanelLayoutProps` from `@k2b/cloud/ssr` render an
application's provider page with its request locale and the embedded panel
runtime. See [Panels](/en/docs/platform/panels).

## Handle server requests

Import request APIs from `@k2b/cloud/server`:

```ts
import {
  type AppContext,
  auth,
  middleware,
  respond,
  v,
} from "@k2b/cloud/server";
```

This entry point contains Hono context types, middleware, actor helpers,
validation, resource access, and response helpers. `buildMetadata` holds the
Cloud `version` and `release` label of the running application's build, for
example to show the version on a settings page.

For an internal endpoint using signed Cloud invocations, the same barrel exports
`requireInvocation` and `InvocationExpectation`. Supply the expected target app,
operation, and schema hash. The middleware verifies the invocation and resolves
current authority into the request context; the handler must still authorize
access to its domain resources. It does not replace operation idempotency.

A dashboard widget handler reads the size and validated settings the board
asks for with `getWidgetRequest(c)` from the same barrel; see
[Dashboard widgets](/en/docs/platform/dashboard-widgets).

`loadPendingApprovals(c, query)` loads an approval page during SSR from this
entry point. Pass it as `initial` to the shared `Approvals` component.
See [Show approvals in your app](/en/docs/identity/approvals#show-approvals-in-your-app).

For a slow handler, `setRequestTimeout`, `REQUEST_IDLE_TIMEOUT_SECONDS`, and
`REQUEST_IDLE_TIMEOUT_MAX_SECONDS` control the bounded request idle timer;
see [Answer slow requests](/en/docs/server/http#answer-slow-requests).

See [Server APIs](/en/docs/server) for the request path.

The widget setting types `WidgetSettingField`, `WidgetSettingsDeclaration`,
`WidgetSettingValue`, and `WidgetSettings`, and the limits
`WIDGET_SETTINGS_MAX_FIELDS`, `WIDGET_SETTING_MAX_OPTIONS`,
`WIDGET_SETTING_TEXT_MAX_LENGTH`, `WIDGET_SETTING_NAME_MAX_LENGTH`,
`WIDGET_ID_MAX_LENGTH`, `WIDGET_KEY_MAX_LENGTH`, `WIDGET_REQUEST_MAX_ENTRIES`,
`WIDGET_REQUEST_MAX_ID_LENGTH`, and `WIDGET_REQUEST_MAX_BYTES` come from
`@k2b/cloud/contracts`; `@k2b/cloud/browser/widgets` re-exports the types. See
[Declare settings](/en/docs/platform/dashboard-widgets#declare-settings).

### Core approval routes

| Route | Use | Guide |
| --- | --- | --- |
| `GET /api/approvals` | List the person's waiting requests; filter by `app` and `link`; paginate with `cursor` | [Approval routes](/en/docs/identity/approvals#approval-routes) |
| `GET /api/approvals/counts` | Read total and per-app open counts | [Approval routes](/en/docs/identity/approvals#approval-routes) |
| `GET /api/approvals/:id/content` | Read the complete pending snapshot | [Approval readers](/en/docs/identity/approvals#approval-routes) |
| `GET /api/approvals/conversations/:conversationId/turns/:turnId/reviews/:callId` | Read an owned historical review snapshot | [Approval readers](/en/docs/identity/approvals#approval-routes) |
| `POST /api/approvals/:id/decision` | Approve or reject a request and continue its chat | [Approval routes](/en/docs/identity/approvals#approval-routes) |

These routes require a user-backed actor.

## Use platform services

Code outside an HTTP request uses asynchronous feature services:

```ts
import { logger } from "@k2b/cloud/services";

const log = logger("inventory");
log.info("Import completed", { itemCount: 42 });
```

Use the capability guide to choose the narrow API:

- [Settings](/en/docs/platform/settings): `SettingUnreadableError`, `SettingRead`, and `StoredSettingState` from `@k2b/cloud/services`; `app.settings.read()` reports stored state before a partial update.
- [Places and maps](/en/docs/platform/places-and-maps): `geoClient` from `@k2b/cloud/server` calls Core with a `CapabilityCaller`; `geoContract`, `geoRouteContract`, geo input/result schemas, route plans/updates, and provenance types come from `@k2b/cloud/contracts`.
- [Outgoing mail](/en/docs/platform/outgoing-mail): `mail.profiles()`, `mail.send()`, `mail.enqueue()`, `mail.list()`, `mail.readableApps()`, and audited `mail.content(id, context)` from `@k2b/cloud/services`, with mail contracts and `PlatformPermission` from `@k2b/cloud/contracts`.
- [Notifications](/en/docs/platform/notifications)
- [Logging](/en/docs/platform/logging): `logger()` and `redactSensitivePath()` for safe request-path logging.
- [App capabilities](/en/docs/platform/capabilities): `cloudResourceHref(ref)` from `@k2b/cloud/contracts` and `cloudResourceUrl(ctx, ref)` from `@k2b/cloud/cli` supply [resource permalinks](/en/docs/platform/capabilities#resource-links).
- [Universal search](/en/docs/platform/search)
- [Document extraction](/en/docs/platform/document-extraction)
- [Secrets and persistent state](/en/docs/data/secrets-and-persistent-state#call-a-public-https-address): `requestPublicHttps()` for server-side requests to a URL that a person, an administrator, or remote content chooses; `resolvePublicNetworkAddresses()`, `NetworkTargetBlockedError`, and `pinnedNetworkLookup()` from `@k2b/cloud/services/network-security` for other transports.
- [Specialized outbound transports](/en/docs/data/secrets-and-persistent-state#call-a-public-https-address): `withNetworkDeadline()`, `awaitNetworkOperation()` and `readNetworkResponse()` from `@k2b/cloud/services/network-transport` share cancellation and close completed HTTP requests. Callers still validate and pin every target through the network guard.
- [Operator-approved internal targets](/en/docs/data/secrets-and-persistent-state#allow-operator-approved-internal-targets): `createAllowedNetworkFetch(allowlist, { lookup?, resolve?, request? }?)` from `@k2b/cloud/services` supplies a fetch-compatible streaming HTTP/HTTPS transport: it refuses URL user information, resolves once, pins the connection without proxies, preserves Host/TLS identity and repeated response headers, and propagates guard refusals. Redirects are never followed (`redirect: "error"` rejects a 3xx; other modes return it); non-identity encoding is rejected. Request normalization supports streaming bodies; the real `Response` streams until completion or cancellation. Signals cover lookup through response streaming, and callers own timeouts, limits and retries. Other internal transports use `resolveAllowedNetworkAddresses(hostname, allowlist, lookup?, port?)` from the same entry point with a `NetworkAllowlist` parsed by `parseNetworkAllowlist()` or `parseNetworkAllowlistEnv(variable, entries)` (errors name the env variable) from `@k2b/cloud/shared`; `isAllowlistedNetworkAddress()` there matches IP networks without DNS. Entries come from the application's operator-controlled env registry, or Pulse's Cloud-admin-managed per-base targets: exact host names, strict IPv4/IPv6, or canonical CIDRs. `host:port` and `[ipv6]:port` restrict hosts/IPs to one port (1–65535, no leading zeros); bare entries cover every port, and CIDRs cannot carry a port. Without a supplied port, only bare entries apply; the HTTP transport supplies the URL's effective port. `NetworkAllowlist.hostPorts` is optional for existing callers. Host entries trust all validated answers; reserved names require a host entry. IPv4-mapped IPv6 also matches IPv4 networks; NAT64 and other embeddings require IPv6 entries. Failed or empty lookups still refuse. `isNetworkTargetBlocked(hostname, allowlist, { resolve?, timeoutMs?, port? })` from `@k2b/cloud/services/network-security` and `@k2b/cloud/services` supplies a save-time hint: only policy refusals return `true`; lookup failures and the default five-second timeout return `false`. Every request still rechecks and pins its target.

Raw stores, runtime starters, gateway telemetry, migrations, and platform
composition helpers from the same barrel are maintainer APIs unless a guide
names them.

`linuxIdentities` is a platform-owned administration service from this barrel.
It checks administrator access on reads and writes. See
[Linux identities](/en/docs/operations/linux-identities) for configuration,
explicit provisioning, and the compatible FreeIPA mirror.

`accountIdentities` is the supported application read service for the acting
user, effective groups, provider availability and administrator-only paginated
identity inventories. It does not allocate identities or track filesystems.
See [Account administration API](/en/docs/reference/account-administration)
for actor requirements and the limits of Cloud's FreeIPA inventory.

`readAccountCategoryPolicy` supplies server-side presentation settings;
`isAccountCategoryAllowed` is for platform-owned credential eligibility checks,
not application resource authorization. The browser-safe contracts barrel
exports `AccountCategory`, `AccountCategoryPolicySchema`, `accountCategory`
and `accountCategoryLabel`. See
[Account types](/en/docs/operations/account-categories) for their use.

The contracts barrel also exports the versioned app-approval input schemas,
signing-message helpers and protocol limits for independent authenticator
clients. Action approval schemas, `APP_ACTION_LIMITS`, and the Action digest
helpers support the signed `inbox`, `action`, and `act` commands.
`appApproval`, `readAppApprovalConfig` and the `AppTerminalLogins` hook type in
the services barrel are Core-owned maintainer surfaces, not general application
authentication. Use the
[app approval HTTP contract](/en/docs/operations/app-approval) for external clients.

For [matching files](/en/docs/platform/file-providers#offer-matching-files),
`@k2b/cloud/contracts` exports `FileProviderContext`, `FileProviderContextSchema`,
`FileProviderContextListInputSchema`, `FILE_PROVIDER_CONTEXT_MAX_REFS`,
`fileProviderContextList`, and `fileProviderAcceptsContext`. The existing base
file-provider contract stays unchanged.

## Share types with the browser

Export the Hono router type from the server. Use it with the browser client.

```ts
import { api } from "@k2b/cloud/browser";
import type { InventoryApi } from "../server";

export const inventoryApi = api.create<InventoryApi>({
  baseUrl: "/api/inventory",
});
```

See [Browser clients and mutations](/en/docs/frontend/browser-clients-and-mutations).

Use `query` and `mutation` from `@k2b/stdlib/solid` for owner-local reads and
user-initiated writes. See
[Server-backed state](/en/docs/frontend/server-backed-island-state).

The `clipboard`, `copyToClipboard`, `url`, and `isImageUrl` exports are utility
helpers outside the documented typed-client contract. Do not choose them as
application APIs unless a guide names them.

## Mixed barrels

Some barrels serve more than one audience. Use this boundary instead of
inferring support from autocomplete.

| Entry point | Application surface | Other exports |
| --- | --- | --- |
| `@k2b/cloud` | `defineApp`, `appAccess`, declaration types, typed notifications | Registry, heartbeat, and runtime composition are platform-owned |
| `@k2b/cloud/services` | Feature services used by capability guides | Raw stores, lifecycle starters, gateway telemetry, and migrations are maintainer APIs |
| `@k2b/cloud/ai` | Structured model calls, local tools, and `listAiOpenQuestions` with `AiOpenQuestion` / `AiOpenQuestions` for [personal chat overviews](/en/docs/ai/chat-runtime-and-streaming#list-the-persons-open-questions) | Conversation stores, migrations, workers, and maintenance helpers are platform-owned |
| `@k2b/cloud/browser` | Typed Hono client factory | Utility helpers are outside the documented typed-client contract |
| `@k2b/cloud/shared` | Cloud-specific helpers named by feature guides | Generic utility re-exports are compatibility-only |
| `@k2b/cloud/cli` | APIs for application CLI modules | Built-in account, application, and admin modules are platform-owned |

For theme-aware server work, `readThemeFromCookieHeader()` returns a resolved
`CloudTheme` (`light` or `dark`); for Automatic it is a best-effort hint that
can be stale. `readThemePreferenceFromCookieHeader()`
returns a `CloudThemePreference` (`light`, `dark`, or `system`). Both readers
and types come from `@k2b/cloud/shared`. See
[Follow the person's theme](/en/docs/frontend/styling-and-accessibility#follow-the-persons-theme).

`@k2b/cloud/config` exports `env.APP_SECRET`, `env.PORT`,
`env.IS_DEVELOPMENT`, and `env.ADMIN_LOGIN_TOKEN`. The
[runtime configuration guide](/en/docs/operations/runtime-configuration)
documents all process variables; that larger list is not the shape of `env`.

### Evaluate Markdown table cells

Import `evaluateTableCell(row, column, context)` and `EvalResult` from
`@k2b/cloud/shared` when a chart or another derived view must use the same
values as a Markdown table. Row and column indices are zero-based. The context
contains `headers`, raw `rows`, `currentRow`, and `currentCol`.

```ts
import { evaluateTableCell } from "@k2b/cloud/shared";

const context = { headers: ["Amount"], rows: [["+1.2e2"]], currentRow: 0, currentCol: 0 };
const result = evaluateTableCell(0, 0, context); // { kind: "ok", value: 120 }
```

A plain cell becomes a number only when its whole text is one decimal number,
including optional sign and exponent. Dates stay text. Formula cells return
the evaluated value or a structured error. Check `result.kind` before using its
value. Use `isTotalRow(row)` from the same entry point to omit total rows from
a derived chart while keeping the full table in the evaluation context.

## Specialized entry points

View readers and types are exported from `@k2b/cloud/ai/browser` and
`@k2b/cloud/ai`: `CloudAiChartView`, `CloudAiGroupView`, `CloudAiTableView`,
`CloudAiExplorerView`, `CloudAiExplorerRequest`,
`CloudAiStatsView`, `CloudAiDetailsView`, `CloudAiViewReference`,
`CloudAiView`, `CloudAiViewSummary`, `CloudAiViewSummarySchema`,
`parseCloudAiView`, `checkCloudAiView`, `cloudAiViewSummary`, `cloudAiViewTable`,
`cloudAiStatsTiles`, `cloudAiDetailsRows`,
`cloudAiTableTsv`, `isAiViewFile`, `isAiViewPath`, `parseCloudAiChartToolView`,
`cloudAiExplorerControls` and `cloudAiExplorerState`,
plus the view directory, suffix, byte and table limits. Both entry points expose
`CLOUD_AI_STATS_MAX_ITEMS` (6), `CLOUD_AI_GROUP_MAX_CHARTS` (6), `CLOUD_AI_VIEW_MAX_MARKS` (3,840),
`CLOUD_AI_CHART_MAX_SERIES` (8), `CLOUD_AI_CHART_MAX_VALUES` (480),
`CloudAiChartInput`, `CloudAiChartInputSchema`, `parseCloudAiChartInput`,
`cloudAiChartSchema`, `cloudAiAppChartSchema`, `cloudAiNumberFormatSchema`,
`cloudAiFormatSchema` and `CloudAiNumberFormat`, `CloudAiDateFormat`,
`CloudAiFormat`. `cloudAiAppChartSchema` reads the same chart input for apps
without the chat's size and fit limits; missing or non-finite data values
become `NaN`, which the renderer leaves out.
Server integrations save run results with `createAiConversationView` and receive
`AiViewInvalidError` for invalid specs. See
[Tools and approvals](/en/docs/ai/tools-and-approvals) for validation and groups.

Custom chart hosts use browser exports `cloudAiChartRenderOptions`,
`cloudAiChartLegend`, `cloudAiChartRows`, `cloudAiChartTable`, `cloudAiChartTooltip`,
`cloudAiChartMarkKey`, `cloudAiChartReferenceMark`, `cloudAiChartXValueFormat`,
`cloudAiNumberFormatters`, `cloudAiChartMarks` and `chartDrawingIssue`, with
`CloudAiChartColumn`, `CloudAiChartRow` and `CloudAiChartTable`. These map
validated chart input to rendering, legend, comparison marks and locale-formatted
rows; `cloudAiChartTooltip(columns, row)` turns a row into the tooltip the chat
shows, so every host tells the same story. A chart's optional
`tooltip: {label?, format?}` names and formats the value in tooltips and table
rows; axes keep their own formats. `ChartExplorer`
from `@k2b/ui` accepts `legend` entries typed as `ChartLegendEntry`
(`{label, color, style?, reference?}`) for a wrapping legend inside its fixed
height; see [Chart presentation and controls](/en/ui/content/charts#chart-presentation-and-controls).

`@k2b/cloud/ai` exposes `AiTaskRequestSchema`, `AiTaskRequest`,
`AiTaskRequestInput`, and `executeAiTask` for bounded text generation,
classification, and extraction. The schema and types are also available from
`@k2b/cloud/ai/browser`. See [Structured and background AI](/en/docs/ai/structured-and-background-ai)
for execution, model access, and usage accounting.

| Entry point | Status | Use | Guide |
| --- | --- | --- | --- |
| `@k2b/cloud/shared-text` | Supported, server-only | Retained collaborative text logs and application-owned snapshot writes | [Shared text documents](/en/docs/data/shared-text-documents) |
| `@k2b/cloud/ai/browser` | Supported, client | Launch Assistant drafts; use SSE parsing, attachment helpers, and client-tool input and output schemas in browser or CLI clients | [Chat and streaming](/en/docs/ai/chat-runtime-and-streaming) |
| `@k2b/cloud/ai/solid` | Supported, browser | AI chat controller over the conversation SSE stream | [Chat interface](/en/docs/ai/chat-interface) |
| `@k2b/cloud/ai/tools` | Advanced, server-only | Mount Cloud's standard agent-tool factories, including document-aware `read_file` and conversation-file `markdown_to_pdf` and `html_to_pdf` | [Files and Projects](/en/docs/ai/files-projects-and-personalization) |
| `@k2b/cloud/ai/ui` | Supported, SolidJS | Shared AI chat components | [Chat interface](/en/docs/ai/chat-interface) |
| `@k2b/cloud/ai/testing` | Supported, tests | `aiQuestionFixtures` demo questions (German and English, fixed times; the data may change in any release) and `aiOpenQuestionFixture`, a question as `listAiOpenQuestions` presents it from a tool block | [Chat and streaming](/en/docs/ai/chat-runtime-and-streaming#list-the-persons-open-questions) |
| `@k2b/cloud/ai/live` | Supported, server-only | `aiLive`: the cursor of AI live updates for server-rendered state; Core mounts its socket | [Chat and streaming](/en/docs/ai/chat-runtime-and-streaming#ai-live-updates) |
| `@k2b/cloud/ai/live-events` | Supported, browser and server | `AiInvalidationSchema` and `AI_INVALIDATION_DOMAINS`, the data of AI live updates | [Chat and streaming](/en/docs/ai/chat-runtime-and-streaming#ai-live-updates) |
| `@k2b/cloud/ai/question-text` | Platform-owned, browser and server | The plain-text form of an Assistant question (`approvalCard`, `actionCardText`, `actionQuestionLines`) that `cld`, notifications, and Cloud Login show | [Tools and approvals](/en/docs/ai/tools-and-approvals) |
| `@k2b/cloud/ai/app-frame` | Platform-owned, browser | The chart, view, and task contracts that an Assistant app frame draws and checks, without the skill parser and schemas of `ai/browser`, because the frame inlines its script in every app | [Chat interface](/en/docs/ai/chat-interface#assistant-apps-and-browser-work) |
| `@k2b/cloud/ai/runtime` | Platform-owned, server-only | Core-owned conversation runtime and turn submission | [Chat and streaming](/en/docs/ai/chat-runtime-and-streaming) |
| `@k2b/cloud/ai/admin` | Platform-owned, server-only | AI usage accounting, model access, and masked request-header names for administration | [Models and providers](/en/docs/ai/models-and-providers), [Observability](/en/docs/operations/observability) |
| `@k2b/cloud/account/ui` | Supported, SolidJS | Cloud account selectors and avatars | [Building blocks](/en/docs/building-blocks) |
| `@k2b/cloud/approvals/ui` | Supported, SolidJS | `Approvals`, `ApprovalsNavStatus`, and `approvalNavCount` for open Action requests | [Action approvals](/en/docs/identity/approvals#show-approvals-in-your-app) |
| `@k2b/cloud/access/ui` | Supported, SolidJS | Cloud permission and resource-key controls; `principalLabel` for localized principal names (also in `@k2b/cloud/shared`); `isManagerEntry` and `ManagerCandidate` for paged grant lists | [Resource API keys](/en/docs/identity/resource-api-keys), [Last manager](/en/docs/identity/authorization#show-the-last-manager) |
| `@k2b/cloud/browser/live` | Supported, browser | `liveConnection` for an application's live channels; `createLiveWebSocket` transport for other sockets | [Realtime UI](/en/docs/frontend/realtime-ui) |
| `@k2b/cloud/events` | Supported, server-only | `defineLive`: live updates written in the transaction that makes the change; `routes(channels)` serves them over one socket per application with access checked at delivery | [Live updates](/en/docs/automation/live-updates) |
| `@k2b/cloud/events/testing` | Supported, tests only | Real live engine, limits and types; memory topic with publish and trim controls; outbox startup for integration tests | [Test channels](/en/docs/automation/live-updates#test-channels) |
| `@k2b/cloud/browser/app-badges` | Supported, browser | `refreshAppBadges` reads the app bar's badge counts again after a change | [Layout and navigation](/en/docs/frontend/layout-and-navigation#show-a-count-on-the-app-icon) |
| `@k2b/cloud/browser/app-approval` | Supported, browser | Authenticator namespace for pairing links, device keys and signed API calls | [App approval](/en/docs/operations/app-approval) |
| `@k2b/cloud/browser/mermaid` | Supported, browser | Mermaid configuration that follows Cloud's light and dark colors | [Styling and accessibility](/en/docs/frontend/styling-and-accessibility#render-mermaid-diagrams-with-cloud-colors) |
| `@k2b/cloud/browser/notifications` | Supported, browser | Browser notification state | [Notifications](/en/docs/platform/notifications) |
| `@k2b/cloud/browser/hints` | Supported, browser | `markHintSeen`: remembers a moved-path hint in the browser cookie before dismissal or navigation | [One-time hints](/en/docs/frontend/ssr-pages-and-routing#one-time-hints-for-moved-paths) |
| `@k2b/cloud/browser/pwa-drafts` | Preview, browser | `pwaDrafts`: keep plain typed text per account and field across mobile app restarts; remove it after saving | [Keep drafts](/en/docs/frontend/mobile-app-pages#keep-drafts) |
| `@k2b/cloud/browser/reload` | Supported, browser | `reloadOnce`: bounded automatic page reload that cannot loop and, under an open modal dialog, offers the reload once the dialog closes; `importOnDemand`: load code when an action needs it and offer a reload when it cannot load | [Realtime UI](/en/docs/frontend/realtime-ui#preserve-reload-behavior), [Islands](/en/docs/frontend/islands-and-hydration#keep-the-first-load-small) |
| `@k2b/cloud/browser/resource-clipboard` | Supported, browser | Copy and recognize stable Cloud resource references | [Resource copy and paste](/en/docs/platform/resource-references) |
| `@k2b/cloud/browser/panel` | Supported, browser | `openPanel`, `closePanel`, and `onPanelBeforeLeave`: open or close the panel and protect unfinished provider work | [Panels](/en/docs/platform/panels) |
| `@k2b/cloud/browser/search` | Supported, browser | Open global search with an optional context and register app navigation | [Universal search](/en/docs/platform/search) |
| `@k2b/cloud/browser/widgets` | Supported, browser | `streamWidgets`: read dashboard widgets from Core as each one answers | [Dashboard widgets](/en/docs/platform/dashboard-widgets#read-widgets-from-a-browser) |
| `@k2b/cloud/browser/commands` | Supported, browser | Open interactive Commands, handle command links, and register context actions | [Capabilities](/en/docs/platform/capabilities) |
| `@k2b/cloud/browser/testing` | Supported, browser tests | Inspect mounted context actions and navigation, and capture search requests | [Universal search](/en/docs/platform/search#test-application-search-and-context-actions) |
| `@k2b/cloud/browser/composer-insert` | Supported, SolidJS | Build insert rows with `cloudInsertMenu` and app-opening rows with `cloudCommandMenu` / `openComposerCommand`; read tags, `commands()` and `state()` from `createCloudComposerCatalog` | [Universal search](/en/docs/platform/search#insert-resources-from-a-composer) |
| `@k2b/cloud/browser/resource-picker` | Supported, SolidJS | Choose a stable resource reference through Universal Search | [Universal search](/en/docs/platform/search) |
| `@k2b/cloud/geo/ui` | Supported, SolidJS | `CloudMap` with authenticated Core map styles and tiles | [Places and maps](/en/docs/platform/places-and-maps) |
| `@k2b/cloud/browser/files` | Supported, SolidJS | `chooseFiles`: add files from this device or from Cloud apps that offer files, as `File` objects; `saveFiles`, `SaveFilesButton`, `saveFilesLabel`, `SAVE_FILES_ICON`: save copies into Cloud apps that store files | [File providers](/en/docs/platform/file-providers) |
| `@k2b/cloud/clients/core` | Platform-owned, browser | Typed client for the Core platform API | — |
| `@k2b/cloud/workflows/language` | Supported | Workflow compiler, parser, and authoring | [Author workflows](/en/docs/automation/author-and-publish-workflows) |
| `@k2b/cloud/workflows/runtime` | Supported, server-only | Workflow execution runtime | [Workflow effects](/en/docs/automation/effects-retry-and-reconciliation) |
| `@k2b/cloud/workflows/store` | Supported, server-only | Durable workflow store, `createWorkflowWorker`, and `notifyWorkflowWorker` | [Start runs](/en/docs/automation/emit-events-and-start-runs) |
| `@k2b/cloud/workflows/ai` | Supported, server-only | Durable AI task migration and lifecycle for opted-in workflow apps | [Structured and background AI](/en/docs/ai/structured-and-background-ai) |
| `@k2b/cloud/workflows/testing` | Supported, tests | Workflow process fixtures | [Test workflows](/en/docs/automation/workflow-observability-and-testing) |
| `@k2b/cloud/services/image-metadata` | Supported, server-only | Strip metadata from content image uploads without re-encoding | [Image upload privacy](/en/docs/platform/image-upload-privacy) |
| `@k2b/cloud/services/document-extraction` | Supported, server-only | Convert authorized document bytes to bounded untrusted Markdown | [Document extraction](/en/docs/platform/document-extraction) |
| `@k2b/cloud/services/outbox` | Supported, server-only | `createPgOutbox`: deliver the rows of an application's own outbox table after commit, in order per key | [Migrations and transactions](/en/docs/data/migrations-and-transactions#deliver-an-outbox) |
| `@k2b/cloud/ssr/islands` | Supported, server-only | Shared SSR island helpers | [In-product help](/en/docs/platform/help) |
| `@k2b/cloud/ssr/WorkspaceNavigation.island` | Supported | SSR-first workspace links for the Cloud mobile menu | [Application shells](/en/docs/frontend/application-shells) |
| `@k2b/cloud/ssr/layout-runtime` | Supported, browser | `layout.update()` and `layout.handleUp()` for islands that navigate in place | [Layout and navigation](/en/docs/frontend/layout-and-navigation) |
| `@k2b/cloud/ssr/*` | Advanced | Named SSR modules; prefer the barrel | — |
| `@k2b/cloud/workflows/editor` | Supported, SolidJS | Workflow authoring controls | [Shared components](/en/docs/frontend#choose-shared-components) |
| `@k2b/cloud/styles/global.css` | Supported asset | Alias for the global stylesheet | [Styling](/en/docs/frontend/styling-and-accessibility) |
| `@k2b/cloud/cli/access` | Supported | Resource access commands | [CLI modules](/en/docs/platform/cli-modules) |
| `@k2b/cloud/cli/capabilities` | Platform-owned | Built-in generic capability client | [App capabilities](/en/docs/platform/capabilities) |
| `@k2b/cloud/capabilities` | Supported, browser | Runtime-validated capability clients, `readCapabilityReviewContent`, and typed `actionReview` builder | [App capabilities](/en/docs/platform/capabilities) |
| `@k2b/cloud/capabilities/server` | Supported, server-only | Registry-backed capability clients and typed `actionReview` builder | [App capabilities](/en/docs/platform/capabilities) |
| `@k2b/cloud/capabilities/store` | Platform-owned, server-only | Capability execution history: migration, recording, listing, summary, and retention | [App capabilities](/en/docs/platform/capabilities) |
| `@k2b/cloud/capabilities/testing` | Supported, tests | Provider manifest, evolution, resource-link and localized review checks | [App capabilities](/en/docs/platform/capabilities) |
| `@k2b/cloud/cli/account` | Platform-owned | Built-in account commands | — |
| `@k2b/cloud/cli/apps` | Platform-owned | Built-in application commands | — |
| `@k2b/cloud/cli/admin` | Platform-owned | Built-in administration commands | — |
| `@k2b/cloud/contracts/notifications` | Supported | Browser-safe notification contracts | [Notifications](/en/docs/platform/notifications) |
| `@k2b/cloud/contracts/*` | Advanced | Named contract modules; prefer the barrel | — |
| `@k2b/cloud/config/*` | Advanced | Named configuration modules; prefer the barrel | — |

Every app-facing specialized row has a guide. `Platform-owned` and `Advanced`
rows are exported for Cloud itself or for a narrowly documented integration;
their presence is not an application support promise.

## Preview surfaces

The mobile app is not released yet, so its part contract and the platform
exports behind it are `Preview`. Their guides say so at the top.

| Surface | Status | Use | Guide |
| --- | --- | --- | --- |
| `pwa` option of `defineApp()` from `@k2b/cloud` | Preview | Add the application's pages to the mobile app | [Define an application](/en/docs/build/define-app#add-pages-to-the-mobile-app) |
| `/pwa/<app-id>` part routes | Preview | Paths that `defineApp()` derives for a part; every other `/pwa` path is reserved | [Pages in the mobile app](/en/docs/frontend/mobile-app-pages#paths) |
| `PwaLayout` and `PwaLayoutProps` from `@k2b/cloud/ssr` | Preview, server-only | Frame every page of a part | [Pages in the mobile app](/en/docs/frontend/mobile-app-pages#pwalayout) |
| `ssr.pwaAccess` of the defined application | Preview, server-only | Handle a part request without an app session | [Pages in the mobile app](/en/docs/frontend/mobile-app-pages#serve-pages) |
| `visiblePwaParts` and `VisiblePwaPart` from `@k2b/cloud/ssr` | Preview, platform-owned | The parts the mobile app lists on Start | — |
| `PWA_*` constants, `isPwaPartId`, `isPwaShellAvailable`, pairing-link helpers and `Pwa*` schemas from `@k2b/cloud/contracts` | Preview, platform-owned | Paths, limits, pairing and phone contracts of the mobile app | [App sessions](/en/docs/identity/authentication#app-sessions-preview) |
| `pwaDevices`, `PwaError` and their types from `@k2b/cloud/services` | Preview, platform-owned | Pairing, app sessions and phone administration | [Account administration API](/en/docs/reference/account-administration#remove-phones-from-the-mobile-app) |
| `sessionKind` on `AuthContext`, `auth.isAppSession`, `auth.rejectAppSession` and `isAppSessionActor` from `@k2b/cloud/server` | Preview | Recognize the mobile app's session and refuse it where an action would outlive the phone | [App sessions](/en/docs/identity/authentication#app-sessions-preview) |

## Platform-owned and limited surfaces

| Entry point | Status | Meaning |
| --- | --- | --- |
| `@k2b/cloud/api` | Platform-owned | Builds the Core platform router, including `createAiOpenAiRoutes` for Core’s models-only [OpenAI-compatible API](/en/docs/ai/openai-compatible-api) |
| `@k2b/cloud/services/help` | Platform-owned | Core Help migration and shared publication/read service |
| `@k2b/cloud/services/approvals` | Platform-owned | Platform requests, decisions, consumption, lists, and counts; see [Action approvals](/en/docs/identity/approvals) |
| `@k2b/cloud/ssr/help` | Supported, server-only | Request-scoped Help metadata for specialized embedded readers |
| Registry, heartbeat, and runtime helpers from `@k2b/cloud` | Platform-owned | Gateway, Core, and platform composition |
| `@k2b/cloud/services/*` | Advanced | Deep service exports; prefer the barrel |
| `@k2b/cloud/server/*` | Advanced | Deep server exports; prefer the barrel |
| `@k2b/cloud/desktop` | Limited | Exported desktop runtime; outside this application guide |
| `@k2b/cloud/desktop/solid` | Limited | Desktop SolidJS integration |
| `@k2b/cloud/services/ipa/service-account` | Blocked | Explicitly excluded from package exports |

“Limited” means the path is exported but not part of the documented web
application contract. It is not a promise of instability.

## Compatibility-only surfaces

| Surface | Use instead |
| --- | --- |
| `@k2b/cloud/shared` utility re-exports | `@k2b/stdlib` |
| `validator` | `v` |
| Untyped `apiClient` | `api.create<TApi>()` |
| Legacy notification send overloads | Typed notification definitions |
| Legacy access inputs | `AccessSubject` |

See [Deprecations](/en/docs/reference/deprecations-and-migrations) for migration
steps.

## Avoid internal imports

Do not import from package source paths such as:

```ts
import { something } from "@k2b/cloud/src/...";
```

Those paths are implementation details.

`requiresAuth` and the other `requires*` values describe OpenAPI security. They
do not protect a route. Use `auth` middleware.

The `@k2b/cloud/ai` export `CODE_SOURCE_TOOLS` and its `CodeSourceToolName` type
define the flat inputs for direct Assistant server tools. See
[Assistant code tools](/en/docs/ai/chat-interface) for loading and execution.
`createCodeCapabilityTransport` and `CODE_CAPABILITY_TOKEN_HEADER` on this
entry point are platform-owned managed-host helpers, not application APIs.
They keep the turn-bound callback credential outside the sandbox and route
capability calls through Core; see [App capabilities](/en/docs/platform/capabilities).


PDF applications use `renderHtmlToPdf`, `renderFacturXHtmlToPdf` and
`attachPdfFiles` from `@k2b/cloud/services` for HTML conversion, invoice XML
embedding and ordinary file attachments. `preparePdfImage` and its input,
variant, result, and error types are available from `@k2b/cloud/services` and
`@k2b/cloud/services/pdf` for bounded print image preparation.
See [PDF and templates](/en/docs/platform/pdf-and-templates)
for their input, access, cancellation and deployment responsibilities.

### Help surfaces

`@k2b/cloud/ssr/islands` exports `Layout.HelpPage` / `LayoutHelpPage` for
full-page and embedded readers, plus `Layout.HelpDocuments` /
`LayoutHelpDocuments` and `openLayoutHelpDialog`.
`@k2b/cloud/ssr` exports `LayoutHelpPanel` with `LayoutHelpPanelProps` for
server HTML with small interaction islands. Render it in a server page, such
as inside `PanelLayout`, never inside an island. Applications normally use the
automatic Help registration.
`openLayoutHelpDialog()` first opens Core's provider in the slot and falls back
to a dialog when no slot accepts it.
See [In-product Help](/en/docs/platform/help).

### Workspace navigation

`@k2b/cloud/ssr/WorkspaceNavigation.island` supplies SSR-first workspace links.
`@k2b/cloud/ssr/islands` exports `WorkspaceNavigationProvider` and
`provideWorkspaceNavigation` for reactive navigation owned by an application
island. See [Application shells](/en/docs/frontend/application-shells#supply-mobile-navigation).

The standalone UI exports `createNavigation`, `Navigation`, `NavigationItem`,
`NavigationController`, `NavigationOptions`, `NavigationProps`,
`findNavigationItem`, `BottomSheet`, `BottomSheetProps`, `bottomSheetOptions`, and
`bottomSheetAdaptiveOptions`. See [BottomSheet](/en/ui/layout/bottom-sheet) for
choosing a bottom-edge sheet or an adaptive decision dialog.


`@k2b/cloud/browser/commands` exports `openCommand`, `registerCommandHandler`,
`registerContextAwareCommand`, and `consumeCommandLink` for interactive
[Commands](/en/docs/platform/capabilities#open-an-interactive-flow-with-commands)
and context actions in the global palette. `@k2b/cloud/capabilities` exports
`resolveCommand` for authenticated HTTP clients that need an entry URL.

`@k2b/cloud/contracts` also exports `isCommandPath` to check Cloud paths.
Import it from `@k2b/cloud/contracts/command-path` to use the check without
loading validators.

## Panel page context

Use `readPanelContext(c)` from `@k2b/cloud/ssr` for a provider's first server
render. Browser code uses `getContext()` and `onContextChange()` from
`@k2b/cloud/browser/panel`; host pages with in-document place changes use
`publishPageContext()`. `PanelPageContext` and its strict schema are exported
from `@k2b/cloud/contracts`. See [Panels](/en/docs/platform/panels#page-context)
for consent, ordering, and the rule that refs never grant access.

`clientIp` and `clientIpBucket` from `@k2b/cloud/server` resolve forwarded
addresses and normalize shared network budgets. See
[Limit requests](/en/docs/server/middleware#limit-requests).

Application entry declarations use `appAccess` from `@k2b/cloud`; see
[App access](/en/docs/identity/app-access). The batch resolver and registry
filtering helpers are platform-owned.
