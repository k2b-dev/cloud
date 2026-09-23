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

If the endpoint is unhealthy, start it with
`docker compose -f docs-site/compose.yml up --build -d --wait --renew-anon-volumes`. If the MCP
connection is missing or stale, say that clearly and use reduced documentation
mode with `docs-site/docs/en`, public exports, types, and focused tests. Do not
silently rely on an older checkout or rendered HTML.

## Work in Git

`main` is protected. Every change reaches it through a pull request that
passes the `gate` check and is squash-merged. Agents never push to `main`,
never create or move tags, and never trigger a release.

Ask before creating a branch or worktree: the checkout is shared with parallel
sessions. The default answer is a worktree; the maintainer may choose the
current branch instead. Once that is decided, follow this recipe without
further questions:

- Branch names are `type/short-slug` (`fix/recovery-401`, `feat/grids-export`).
- Each piece of work gets its own worktree under `../cloud-wt/<slug>`, outside
  the repository:

  ```bash
  git fetch origin
  git worktree add ../cloud-wt/<slug> -b type/<slug> origin/main
  cd ../cloud-wt/<slug> && bun install --frozen-lockfile && bun run --cwd packages/ui build
  ```

- `dev:*` and `dev:cld` belong to this checkout; Compose mounts its sources.
  In a worktree, verify with `bun run check`, `bun run test`,
  `bun run test --integration` against the local infrastructure, and
  `docker build`. Browser-level checks wait for this checkout or for CI.
- Commit as you go, following the rules below; commits need no approval.
  Pushing, opening the pull request, and enabling auto-merge are one block
  that needs one approval: `gh pr create --fill`, then
  `gh pr merge --auto` (the queue applies the squash), which places the green pull request in the
  merge queue; the queue re-runs the gate on the merge result and merges.
  After the merge, `git worktree remove` the worktree; merged branches are
  deleted automatically.

The PR title becomes the squash commit and must be a Conventional Commit of
the form `type(scope): outcome`. `feat` produces a minor release, `fix` a
patch, and `feat!` or a `BREAKING CHANGE:` footer a major release. Use `!`
only with explicit maintainer approval.

Never edit `version` fields, `CHANGELOG.md`, or `.release-please-manifest.json`;
release-please owns them.

## Track work

GitHub Issues are the public list of work: bugs, tracked debts, and concrete
tasks that someone can pick up. A pull request closes its issue with
`Closes #n`. Dex holds the plan inside one piece of work: slices, status, and
handoff between sessions; a Dex task names its issue number and is discarded
after the merge.

- An issue describes one problem in at most four short sections: what is
  wrong, how to reproduce it (a command), the suspected cause with
  `file:line`, and a proposal. Analysis, plans, and progress belong in Dex.
- Use the "Agent report" issue form for issues an agent files; the "Bug
  report" form is for people.
- Ideas and feature requests go to Discussions, not Issues.
- A one-commit fix needs neither an issue nor a Dex task, only a pull request.

## Keep the model small

A new behavior rides an existing mechanism before it may add a new one:

- a new environment variable is one entry in the config registry
  (`packages/cloud/src/config/env.ts` or the application's `src/env.ts`),
  never a hand edit of `.env.example`, documentation, or Compose;
- a new integration test needs zero configuration; it gates itself on
  `CLOUD_TEST_*` through `scripts/fixtures/test-infra.ts`;
- a new application touches exactly three files: the workspace list,
  `compose.dev.yml`, and `compose.prod.yml`;
- a new repository rule is one module under `scripts/checks/`, never a new
  `package.json` script or workflow;
- a new script is a file with `--help`, not a `package.json` entry, unless CI
  or documentation invokes it.

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
  Localized setting presentation inherits the application's base locale;
  notification senders pass locale metadata to both renderers rather than
  adding locale to application payload schemas.
- **Data and effects:** applications own durable domain data in Postgres;
  NATS JetStream coordinates distributed work; Valkey owns caches and rate limits. Commit domain state before
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
- **Application set:** the application list is derived from the workspace
  through `scripts/workspace.ts`; the `app-set` check fails on drift between
  the workspace, Compose files, and CI.
- **Release surface:** a runtime-contract change needs a `feat` or `feat!`
  title and an operations documentation note, because it lands in the next
  `cloud-vX.Y.Z` automatically.
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
- `.github/workflows` — `ci.yml` (PR gate), `nightly.yml`, `main.yml`
  (sha images and release-please), `release.yml`, `build-images.yml`;
- `scripts/checks` — repository rules;
- `scripts/workspace.ts` — the application list.

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
- The documentation service runs from `docs-site/compose.yml`; see
  [Monorepo development](docs-site/docs/en/operations/monorepo-development.md).
- Run `bun run dev:help` for the complete current command catalog.

The root commands are `dev`, `dev:full`, `dev:down`, `dev:start`, `dev:stop`,
`dev:restart`, `dev:rebuild`, `dev:logs`, `dev:status`, `dev:help`, `dev:cld`,
`check`, `format`, `test`, and `release:preflight`.

Integration suites run only when `CLOUD_TEST_DATABASE_URL`,
`CLOUD_TEST_NATS_SERVERS`, and `CLOUD_TEST_VALKEY_URL` (and, where needed,
`CLOUD_TEST_FILEGATE_URL`, `CLOUD_TEST_GOTENBERG_URL`, `CLOUD_TEST_RSQL_URL`)
are set explicitly. They refuse a database whose name does not end in `_test`
and fail loudly when a target is unreachable. Never point them at the
development database. `bun run test` without these variables runs unit,
render, and behavior tests and reports the skipped integration files;
`bun run test --integration` runs only the integration files.

Reuse a healthy existing stack when possible. Start only what the task needs,
and stop only processes or containers you started and can identify exactly.

When testing the current checkout against the development server, use
`bun run dev:cld -- <args>`. It runs the workspace CLI source against
`http://localhost:3000`. Do not use an installed `cld` for this path because it
may lag behind the checkout. Installed `cld` remains the right choice when the
task only operates a deployed Cloud installation.

Dependency changes belong to the package that imports them. Shared versions
use the root catalog; published packages must resolve to concrete versions.
Update `bun.lock` with the manifest; `bun run check` verifies the result.

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

The `gate` check runs `bun run check`, `bun run test`, the integration suites
with `CLOUD_TEST_*`, Grids certification, and an image boot smoke for
`packages/cloud` or `Dockerfile` changes. Run the same locally before opening a
pull request.

Review only the owned diff and run `git diff --check`. A finished handoff says
what behavior changed, which boundaries were checked, what ran, what passed,
and what could not be verified. Code, tests, current documentation, and agent
knowledge should agree before the work is done.
