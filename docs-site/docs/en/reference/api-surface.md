---
title: API surface
navTitle: API surface
section: Reference
order: 1205
description: Choose a supported Cloud import and check its runtime and stability.
tags: [api, imports, boundaries, compatibility]
updated: 2026-09-04
---

# API surface

Cloud separates APIs by runtime. Use the entry point for the code you are
writing.

`Supported` means application code may depend on the documented use. It does
not make every symbol in a mixed barrel an application API. `Platform-owned`
is for Cloud itself. `Advanced` paths are public exports, but application code
should use them only when a feature guide gives the exact import.

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
| `@k2b/cloud/ssr` | Supported, server-only | Authenticated, anonymous, minimal, and admin layouts; runtime context; URL filters |
| `@k2b/cloud/workflows` | Supported | Workflow definitions and authoring contracts |
| `@k2b/cloud/ai` | Supported, server-only | AI APIs named by the AI guides |
| `@k2b/cloud/cli` | Supported | Cloud CLI modules |
| `@k2b/cloud/config` | Supported, server-only | Selected typed runtime values |

Use the barrels above by default. Use a subpath when the specialized-entry
table below links its feature guide.

## Define the application

Import `defineApp()` from the package root:

```ts
import { defineApp } from "@k2b/cloud";
```

The returned application's `ssr` renders pages and exposes `ssr.access` for
browser-route rejections and `ssr.error(c, status, options?)` for terminal HTML
errors. See [SSR pages and routing](/en/docs/frontend/ssr-pages-and-routing).

The root also exports the types bound to an application declaration. This
includes typed settings and notification definitions. Registry, heartbeat, and
runtime-composition exports from the same barrel are platform-owned.

See [Define an application](/en/docs/build/define-app).

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
validation, resource access, and response helpers.

See [Server APIs](/en/docs/server) for the request path.

## Use platform services

Code outside an HTTP request uses asynchronous feature services:

```ts
import { logger } from "@k2b/cloud/services";

const log = logger("inventory");
log.info("Import completed", { itemCount: 42 });
```

Use the capability guide to choose the narrow API:

- [Settings](/en/docs/platform/settings)
- [Notifications](/en/docs/platform/notifications)
- [Logging](/en/docs/platform/logging)
- [App capabilities](/en/docs/platform/capabilities)
- [Universal search](/en/docs/platform/search)
- [Document extraction](/en/docs/platform/document-extraction)

Raw stores, runtime starters, gateway telemetry, migrations, and platform
composition helpers from the same barrel are maintainer APIs unless a guide
names them.

`linuxIdentities` is a platform-owned administration service from this barrel.
It checks administrator access on reads and writes. See
[Linux identities](/en/docs/operations/linux-identities) for configuration,
explicit provisioning, and the compatible FreeIPA mirror.

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
| `@k2b/cloud` | `defineApp`, declaration types, typed notifications | Registry, heartbeat, and runtime composition are platform-owned |
| `@k2b/cloud/services` | Feature services used by capability guides | Raw stores, lifecycle starters, gateway telemetry, and migrations are maintainer APIs |
| `@k2b/cloud/ai` | Structured model calls and local tools used by AI guides | Conversation stores, migrations, workers, and maintenance helpers are platform-owned |
| `@k2b/cloud/browser` | Typed Hono client factory | Utility helpers are outside the documented typed-client contract |
| `@k2b/cloud/shared` | Cloud-specific helpers named by feature guides | Generic utility re-exports are compatibility-only |
| `@k2b/cloud/cli` | APIs for application CLI modules | Built-in account, application, and admin modules are platform-owned |

`@k2b/cloud/config` exports `env.APP_SECRET`, `env.PORT`,
`env.IS_DEVELOPMENT`, and `env.ADMIN_LOGIN_TOKEN`. The
[runtime configuration guide](/en/docs/operations/runtime-configuration)
documents all process variables; that larger list is not the shape of `env`.

## Specialized entry points

| Entry point | Status | Use | Guide |
| --- | --- | --- | --- |
| `@k2b/cloud/ai/browser` | Supported, browser | Create a personal Assistant conversation with an initial structured draft | [Chat and streaming](/en/docs/ai/chat-runtime-and-streaming) |
| `@k2b/cloud/ai/solid` | Supported, browser | AI chat controller and shared Core live connection | [Chat interface](/en/docs/ai/chat-interface) |
| `@k2b/cloud/ai/tools` | Advanced, server-only | Mount Cloud's standard agent-tool factories, including document-aware `read_file` and conversation-file `markdown_to_pdf` | [Files and Projects](/en/docs/ai/files-projects-and-personalization) |
| `@k2b/cloud/ai/ui` | Supported, SolidJS | Shared AI chat components | [Chat interface](/en/docs/ai/chat-interface) |
| `@k2b/cloud/ai/live` | Supported, server-only | AI Realtime UI route and SSR cursor | [Chat and streaming](/en/docs/ai/chat-runtime-and-streaming) |
| `@k2b/cloud/ai/live-events` | Supported, browser and server | AI Realtime UI wire contracts and parser | [Chat and streaming](/en/docs/ai/chat-runtime-and-streaming) |
| `@k2b/cloud/ai/runtime` | Platform-owned, server-only | Core-owned conversation runtime and turn submission | [Chat and streaming](/en/docs/ai/chat-runtime-and-streaming) |
| `@k2b/cloud/ai/admin` | Platform-owned, server-only | AI usage accounting behind the Admin AI Usage report | [Observability](/en/docs/operations/observability) |
| `@k2b/cloud/account/ui` | Supported, SolidJS | Cloud account selectors and avatars | [Building blocks](/en/docs/building-blocks) |
| `@k2b/cloud/access/ui` | Supported, SolidJS | Cloud permission and resource-key controls | [Resource API keys](/en/docs/identity/resource-api-keys) |
| `@k2b/cloud/browser/live` | Supported, browser | Live WebSocket transport with typed channel sends | [Realtime UI](/en/docs/frontend/realtime-ui) |
| `@k2b/cloud/browser/notifications` | Supported, browser | Browser notification state | [Notifications](/en/docs/platform/notifications) |
| `@k2b/cloud/browser/resource-clipboard` | Supported, browser | Copy and recognize stable Cloud resource references | [Resource copy and paste](/en/docs/platform/resource-references) |
| `@k2b/cloud/browser/resource-picker` | Supported, SolidJS | Choose a stable resource reference through Universal Search | [Universal search](/en/docs/platform/search) |
| `@k2b/cloud/clients/core` | Platform-owned, browser | Typed client for the Core platform API | — |
| `@k2b/cloud/workflows/language` | Supported | Workflow compiler, parser, and authoring | [Author workflows](/en/docs/automation/author-and-publish-workflows) |
| `@k2b/cloud/workflows/runtime` | Supported, server-only | Workflow execution runtime | [Workflow effects](/en/docs/automation/effects-retry-and-reconciliation) |
| `@k2b/cloud/workflows/store` | Supported, server-only | Durable workflow store and workers | [Start runs](/en/docs/automation/emit-events-and-start-runs) |
| `@k2b/cloud/workflows/ai` | Supported, server-only | Durable AI task migration and lifecycle for opted-in workflow apps | [Structured and background AI](/en/docs/ai/structured-and-background-ai) |
| `@k2b/cloud/workflows/testing` | Supported, tests | Workflow process fixtures | [Test workflows](/en/docs/automation/workflow-observability-and-testing) |
| `@k2b/cloud/services/document-extraction` | Supported, server-only | Convert authorized document bytes to bounded untrusted Markdown | [Document extraction](/en/docs/platform/document-extraction) |
| `@k2b/cloud/ssr/islands` | Supported, server-only | Shared SSR island helpers | [In-product help](/en/docs/platform/help) |
| `@k2b/cloud/ssr/*` | Advanced | Named SSR modules; prefer the barrel | — |
| `@k2b/cloud/workflows/editor` | Supported, SolidJS | Workflow authoring controls | [Shared components](/en/docs/frontend#choose-shared-components) |
| `@k2b/cloud/styles/global.css` | Supported asset | Alias for the global stylesheet | [Styling](/en/docs/frontend/styling-and-accessibility) |
| `@k2b/cloud/cli/access` | Supported | Resource access commands | [CLI modules](/en/docs/platform/cli-modules) |
| `@k2b/cloud/cli/capabilities` | Platform-owned | Built-in generic capability client | [App capabilities](/en/docs/platform/capabilities) |
| `@k2b/cloud/capabilities` | Supported, browser | Runtime-validated capability catalog, invocation, and Action review client | [App capabilities](/en/docs/platform/capabilities) |
| `@k2b/cloud/capabilities/server` | Supported, server-only | Registry-backed capability catalog, invocation, and Action review client | [App capabilities](/en/docs/platform/capabilities) |
| `@k2b/cloud/capabilities/testing` | Supported, tests | Provider manifest compilation and additive-evolution assertions | [App capabilities](/en/docs/platform/capabilities) |
| `@k2b/cloud/cli/account` | Platform-owned | Built-in account commands | — |
| `@k2b/cloud/cli/apps` | Platform-owned | Built-in application commands | — |
| `@k2b/cloud/cli/admin` | Platform-owned | Built-in administration commands | — |
| `@k2b/cloud/contracts/notifications` | Supported | Browser-safe notification contracts | [Notifications](/en/docs/platform/notifications) |
| `@k2b/cloud/contracts/*` | Advanced | Named contract modules; prefer the barrel | — |
| `@k2b/cloud/config/*` | Advanced | Named configuration modules; prefer the barrel | — |

Every app-facing specialized row has a guide. `Platform-owned` and `Advanced`
rows are exported for Cloud itself or for a narrowly documented integration;
their presence is not an application support promise.

## Platform-owned and limited surfaces

| Entry point | Status | Meaning |
| --- | --- | --- |
| `@k2b/cloud/api` | Platform-owned | Builds the Core platform router |
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
