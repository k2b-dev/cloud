---
name: cloud-dev
description: >
  Build applications on Cloud, the open-source Bun, Hono, and SolidJS
  application platform that runs on your infrastructure. Use this skill
  whenever work touches an application built with @k2b/cloud:
  declarations, routes, middleware, services, data, identity and access,
  settings, notifications, jobs, workflows, UI, AI, observability, packaging,
  or deployment. This is the public contract for standalone and built-in
  applications. Inside the Cloud monorepo, also follow its AGENTS.md. Use
  cloud-cli instead when only operating an existing Cloud installation.
---

# Build a Cloud application

A Cloud application is an independently deployed HTTP service that owns its
domain, routes, data, image, version, and release. Cloud supplies shared
platform services. Standalone and built-in applications use the same public
runtime contract.

## Read the public contract

Use the configured Cloud documentation MCP when available: call
`list_collections`, then `search_docs` and `read_doc`. Treat those docs and the
public types of the exact `@k2b/cloud` version as the contract.

- Import only documented entry points, never package source paths, monorepo
  aliases, or another application package.
- A public export is not automatically an application API. Platform-owned and
  advanced surfaces require a guide that names their use.
- Built-in applications are examples, not authority for public behavior.

If the MCP is missing or unavailable, ask the application author to configure
`cloud-dev-mcp` with `https://cloud.k2b.dev/_fibel/mcp` and restart the agent
session. Do not silently continue without it. Only when the application author
cannot connect it, state that reduced documentation mode is in use and inspect
the available public docs, exports, types, and focused tests.

## Own the application boundary

Cloud owns identity, access semantics, routing, registration, and shared
services. The application owns its domain, permissions, Hono routes, pages,
and durable data.

- Use `defineApp()` for the declaration, the Hono router for requests, and
  `app.start()` for registration and lifecycle.
- Keep declared prefixes, mounted routes, and registration aligned. A running
  process alone does not prove route readiness.
- Cloud authenticates and resolves access subjects. The application checks
  concrete resource permissions in every service path. Use `actor` for
  identity and audit context and `accessSubject` for grants. UI visibility is
  not authorization.
- Send an interactive credential only to Core. Framework-owned cross-app calls
  exchange it for a short-lived target- and operation-bound invocation; never
  forward a cookie, OAuth token, or API key directly to another application.
- Durable background work that calls another application stores one revocable
  mandate for the workload. It authenticates to Core with its app-bound
  workload credential and never stores the user's session or personal API key.
- Keep transport conversion in handlers and domain rules in the application.
- Ship server-side files (templates, fixtures a service reads at runtime)
  under `src/assets/` and resolve them with `appAssetPath()` from
  `@k2b/cloud/server`; `import.meta.url` does not point at the source tree in
  the bundled image. Import Bun built-ins statically; the minified server
  bundle breaks `await import("bun")`.
- Store durable state explicitly, never in process memory or container files.
  Use NATS-backed Sync for distributed coordination and Valkey for caches
  and Cloud rate limits. Commit state before retryable
  effects and give those effects stable keys.

## Reuse public building blocks

Choose documented Cloud entry points and services before creating a parallel
mechanism. Public application code must work outside the Cloud monorepo.

Prefer the documented K2B foundations before building an application-local
alternative:

- `@k2b/stdlib` for portable TypeScript and browser utilities, and
  `@k2b/stdlib/solid` for owner-local queries, mutations, and interaction
  primitives;
- `@k2b/ssr` together with `@k2b/cloud/ssr` for SSR, islands, and
  navigation;
- `@k2b/sync` for jobs, queues, schedulers, topics, mutexes, and bounded
  distributed coordination, `@k2b/sync/retry` for local retries, and
  `@k2b/cloud/server` for rate limits;
- `@k2b/cloud/workflows` only when work needs a durable, inspectable,
  recoverable process rather than one bounded job.

Declare Sync handles with `lazySync()`, use them after `app.start()`, start
workers in lifecycle startup, and drain them before releasing dependencies.
Shared resources need one owner and identical settings. Never declare one per
entity: JetStream reserves each stream's bytes, so per-entity logs share one
topic keyed by `tenantId` with watermark cursors (Topics and live events).

Cloud and every application are equal consumers of `@k2b/ui`. The standalone
SolidJS library remains independent of Cloud and application domains.

- Use existing `@k2b/ui` components whenever they express the required
  control, feedback, surface, or layout behavior.
- Do not recreate generic component contracts inside an application. If no
  primitive fits, surface the gap and agree with the application author
  whether to extend `@k2b/ui` or build application-owned UI.
- Custom UI follows the same tokens, semantics, interaction, accessibility,
  responsive, theme, and state principles. Reusable presentation belongs in
  the library; applications retain their domain behavior.
- Give an application's landing page the shared overview pattern: either a
  sidebar-first `AppWorkspace` (objects as `SidebarItem variant="object"` rows,
  `AppWorkspace.Main width="content"`, a `PanelHeader size="lg"` page header
  with one primary action) when users own many objects, or `AppOverview` with
  `AppOverview.Cards` of `LinkCard`s when they own few. Keep rows and cards to
  one secondary fact.

## Keep server and browser behavior coherent

- SSR owns the authorized initial snapshot; Solid islands own only browser
  interaction. Prefer typed Hono clients over raw transport calls.
- Invalidate the canonical read after writes instead of maintaining a second
  client-side domain model.
- Keep reloadable state in the URL. Acknowledge live events only after all
  affected queries commit a covering snapshot.
- Hand islands the route as a path (`requestPath(c)` from `@k2b/cloud/ssr`),
  never the absolute request URL: behind the gateway its origin is the
  internal upstream, not the browser's.
- Resolve the request locale once. Use `getLocale(c)` on the server and the
  inherited `@k2b/ui` locale in Solid; never keep a process-global locale or
  thread it through ordinary component props. Applications own localized
  human messages, while stable codes remain locale-independent. Transport
  final display strings across capabilities and widgets, not message keys.
  Setting presentation inherits the application's base locale; notification
  senders pass locale metadata so `render` and `email` produce final text from
  the same canonical locale without adding locale to the domain payload.
  Keep product text calm and precise; localizations preserve meaning, while code, identifiers,
  paths, and external labels stay verbatim. Show group names via `groupDisplayName()` (`@k2b/cloud/shared`).
  `Layout`, `AdminLayout`, and `MinimalLayout` install the SSR locale provider.
  Use `MinimalLayout` for an app-styled standalone page that needs Cloud's
  persisted locale and theme without Cloud chrome. A custom root using none of
  these layouts must install one provider around its returned tree.

## Ship CLI commands as a plugin

Read **Application CLI modules** (`/en/docs/platform/cli-modules`) before
adding `cld` commands. Define the module with `defineCliCommands()` and publish
it as a package with `"cld": { "apiVersion": 1, "entry": "dist/cli.js" }`
(one bundled ESM file). The module name is the plugin ID (`cld <id>`, always
reachable as `cld plugins run <id>`); built-in names are reserved. Commands
are API clients with the user's `CloudCliContext` only; the server keeps
authorization, and command names, flags, and JSON output are stable syntax.

## Build and verify one complete slice

For capability design or changes, read **App capabilities** in the Docs
collection (`/en/docs/platform/capabilities`), especially its machine-composition
and design-review guidance. Trace real task paths and consumers before choosing
result fields or changing contracts; keep detailed API rules in that guide.
Cloud records one execution row for every capability call on every surface;
an application writes `context.requestId` into its own audit rows so the two
trails join without sharing payloads. For a shared cross-app contract such as
the contact directory, read `/en/docs/platform/contact-directory`.

For deployment questions, read **Deployment requirements** in the Docs
collection (`/en/docs/operations/deployment-requirements`) before selecting
services or secrets. Distinguish startup prerequisites from optional feature
dependencies, then follow the linked runtime and migration guides for the
deployed version. Do not infer feature readiness from container health.

In a repository development environment, refresh only the processes affected
by a source change. Prefer a no-build restart when source is mounted into the
runtime; rebuild only when an image-baked input changed. Follow the repository's
commands and ownership map rather than rebuilding the complete stack by default.

Build the smallest end-to-end behavior through its public seam. Avoid
speculative paths, one-off abstractions, and unrelated cleanup. Start with the
fastest relevant check, then verify each affected permission, data,
registration, and SSR/browser boundary. Integration tests gate on `CLOUD_TEST_*`
variables and never touch a database whose name does not end in `_test`. Before
release, test against the target Cloud version with the published package
version used in production. Update the application's docs when observable
behavior changes. Finish when code, focused tests, and documentation describe
one contract.
