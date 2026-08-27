# Cloud

Cloud is an open-source application platform built around independently
deployed applications and designed to run on infrastructure controlled by its
operator. The platform supplies identity, access, UI, data foundations,
automation, observability, discovery, and operations. Each application owns
its domain, routes, durable data, image, and release cycle.

The global agent defaults still apply. This file adds the context needed when
working on Cloud itself.

## Work as a Cloud maintainer

Always read the `cloud-dev` skill. It is the portable, public guide for people
building applications on Cloud, so its contracts apply to built-in apps too.
Inside this monorepo, also use the current checkout and the maintainer rules
below. Repository internals, local Fibel setup, and workspace commands belong
here or in maintainer documentation, not in the public skill.

Use `cloud-cli` instead when the task only operates an existing Cloud
installation and does not change its code.

Cloud can be ambitious; an individual change should still have one clear
owner and the smallest model that makes the right behavior unsurprising. Do
not make built-in apps privileged special cases. A third-party app using the
public package should get the same coherent platform contract.

## Know the roles and owners

Use these words consistently:

- **maintainer** means the person directing or reviewing work in this
  repository;
- **application author** means someone building a built-in or third-party
  Cloud application;
- **Cloud user** means an end user of a running Cloud installation;
- **operator** means the person or organization running that installation and
  its infrastructure;
- **agent** means the coding agent reading this file and changing Cloud;
- **platform** means the public application contracts and shared mechanisms in
  `packages/cloud`;
- **Core** means the global Cloud product surfaces in `packages/core`;
- **gateway** means registry-driven request routing in `packages/gateway`;
- **application** means one independently deployed domain service under
  `packages/*`;
- **`@k2b/ui`** means the standalone SolidJS component library in
  `packages/ui`;
- **documentation** means the canonical Fibel sources under `docs-site`;
- **deployment** means placement, networking, configuration, and runtime
  infrastructure.

Put behavior in the lowest shared layer that truly owns it. An application is
evidence for a shared contract, not the authority for one.

Cloud and every Cloud application are consumers of `@k2b/ui`. The component
library is independently usable by other SolidJS projects and must not depend
on Cloud packages, routes, permissions, or domain state.

## Start from the live checkout

1. Inspect `git status` and preserve unrelated or parallel work. This checkout
   is often busy; never broad-format, stage, discard, or rewrite foreign files.
2. Read public exports and types, their implementation and focused tests, then
   the current documentation. Real applications are examples, not contracts.
3. Name the owning layer and observable behavior before choosing files.
4. Search every real caller of the affected contract before changing or
   deleting it.

Use the current checkout's documentation through `cloud-dev-mcp`: call
`list_collections`, then `search_docs` and `read_doc` for the smallest relevant
pages. The default local endpoint is `http://localhost:4187/_fibel/mcp`.

If the endpoint is unhealthy, start it with `bun run dev:fibel`. If the MCP
connection is missing or stale, say that clearly and use reduced documentation
mode with `docs-site/docs/en`, public exports, types, and focused tests. Do not
silently rely on an older checkout or rendered HTML.

## Hit every affected boundary

Before calling a change complete, decide which of these apply:

- **Application routing:** declared prefixes, mounted Hono routes, gateway
  registration, and OpenAPI metadata agree. A running process alone does not
  prove route readiness.
- **Identity and access:** route policy controls entry; every API, SSR path,
  background action, and CLI reaches the same permission-aware service. Use
  `actor` for request identity and audit context, and `accessSubject` for
  grants. Navigation visibility is never authorization.
- **Public application contract:** built-in and third-party apps use the same
  supported exports. Keep conversions at transport boundaries and domain
  rules in the owning application.
- **Server and browser:** SSR owns initial data and permissions. Solid islands
  own only the interaction that needs a browser. Reload, navigation, and URL
  state preserve the same result.
- **Internationalization:** resolve one request-scoped locale. Applications own
  their message catalogs and final human-facing strings; stable codes, logs,
  and message keys do not become translated transport contracts. Use the
  inherited `@k2b/ui` locale for rendering and forward locale metadata across
  capabilities and widgets. Never introduce process-global locale state,
  per-component locale plumbing, or a language picker as incidental scope.
- **Data and effects:** applications own durable domain data in Postgres;
  Valkey coordinates bounded runtime work. Commit domain state before
  retryable notifications or external effects. Bound work that can grow or
  repeat: input sizes, pagination, batches, queues and buffers, concurrency,
  retries, and tool or agent loops. Define cancellation and overload behavior
  explicitly. Derive limits from a public contract or operational budget; do
  not invent arbitrary caps.
- **Shared UI:** use public `@k2b/ui` components for controls, feedback,
  surfaces, and layout whenever they can express the requirement. Application
  components compose domain behavior; they do not recreate generic UI
  contracts. If no shared primitive fits, explain the gap and agree with the
  maintainer whether to extend `@k2b/ui` or create app-owned UI. Custom UI must
  follow the same tokens, semantics, interaction, accessibility, responsive,
  and theme principles.
- **Knowledge:** observable public behavior, examples, tests, Fibel pages, and
  the published skill tell one story.

## Where things live

- `packages/cloud` — public platform library and shared server/browser
  mechanisms;
- `packages/core` — authentication, profile, settings, legal, and other global
  Cloud surfaces;
- `packages/gateway` and `packages/gateway-ops` — routing, discovery, and
  operational visibility;
- `packages/ui` — standalone `@k2b/ui` package with no Cloud or
  application-domain dependencies;
- other `packages/*` — independently owned built-in applications;
- `docs-site/docs/en` — canonical developer and operations documentation;
- `docs-site/src/ui/context` and `docs-site/src/ui/demo-sections` — canonical
  UI guidance and representative live states;
- `docs-site/agent-skills/cloud-dev` — portable Cloud development workflow and
  stable cross-cutting invariants;
- `skills/cloud-cli` — operating an installed Cloud through `cld`.

## Develop without collateral damage

After a fresh clone or lockfile change, run `bun install --frozen-lockfile`.

- `bun run dev` starts the infrastructure and core stack; use `dev:full` only
  when every optional application is needed.
- Use `dev:start`, `dev:stop`, `dev:restart`, and `dev:rebuild` for specific
  applications; use `dev:logs` and `dev:status` to inspect them. Application
  source and `packages/core` changes restart only their owning service;
  `packages/cloud/src`, `packages/cloud/scripts`, and root `styles.css` changes
  restart all running Cloud services with `dev:restart --running`. UI,
  dependency, package-manifest, and Dockerfile changes rebuild only the
  consumers needed for the task.
- `dev:down` removes the app stack but keeps its infrastructure available.
  Stop that separately with `dev:infra:down` only when it is no longer needed.
- Use `dev:fibel`, `dev:fibel:logs`, and `dev:fibel:down` for the isolated
  documentation service.
- Run `bun run dev:help` for the complete current command catalog.

Reuse a healthy existing stack when possible. Start only what the task needs,
and stop only processes or containers you started and can identify exactly.

When testing the current checkout against the development server, use
`bun run dev:cld -- <args>`. It runs the workspace CLI source against
`http://localhost:3000`. Do not use an installed `cld` for this path because it
may lag behind the checkout. Installed `cld` remains the right choice when the
task only operates a deployed Cloud installation.

Dependency changes belong to the package that imports them. Shared versions
use the root catalog; published packages must resolve to concrete versions.
Update `bun.lock` with the manifest and run `bun run check:dependencies`.

Do not add speculative hooks, aliases, compatibility paths, casts,
placeholders, or adjacent cleanup. Preserve identity, permission, lifecycle,
data-ownership, and deployment boundaries unless the task explicitly changes
one of them.

## Keep the documentation contract current

Update the canonical Fibel page, example, or UI context when observable
behavior changes: public exports, defaults, errors, permissions, lifecycle,
routes, configuration, deployment, or shared component contracts. Internal
refactors with unchanged behavior need no public prose.

Keep detailed API knowledge in canonical documentation. Change `cloud-dev`
only when the stable development workflow or a cross-cutting platform
invariant changes. Read
[Document Cloud core changes](docs-site/docs/en/contributing/document-cloud-core-changes.md)
for exact ownership and documentation checks.

## Verify the seam you changed

Start with the fastest check that can disprove the change. Reproduce bugs before
fixing them when practical, run focused tests at the highest public seam, then
widen to the owning package's typecheck, build, documentation checks, or root
checks only when the boundary requires it.

Review only the owned diff and run `git diff --check`. A finished handoff says
what behavior changed, which boundaries were checked, what passed, and what
could not be verified. Code, tests, current documentation, and agent knowledge
should agree before the work is done.
