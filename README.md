<p align="center">
  <img src="./packages/cloud/public/logo.svg" alt="Cloud" width="96" height="96">
</p>

<h1 align="center">Cloud</h1>

<p align="center">
  <em>Open-source application platform for your infrastructure.</em>
</p>

Cloud bundles a set of apps that cover the common operational needs of an organisation — accounts, settings, observability, notifications, files, notebooks, calendars, OAuth — and is built around the custom apps you write yourself. Custom apps get the same session, UI kit, search hooks, and admin pages as the apps in the box.

## Highlights

- **Built around your own apps.** Adding an app is one config file plus a Dockerfile. The platform picks it up at runtime.
- **Per-app deployment.** Every feature is a separate Bun container, started, updated and scaled on its own.
- **Horizontal scaling.** Apps are stateless and discovered through a NATS-backed registry — `docker compose up --scale notebooks=3` and the gateway routes across all instances.
- **Bun + Hono + SolidJS + Postgres + NATS + Valkey.** End-to-end TypeScript.
- **Admin surface for everything.** Per-app admin pages, settings managed in the UI, requests route-traced through the gateway.

## What ships

Every release publishes one image per application. The list is derived from
the workspace with `bun scripts/workspace.ts apps`.

| Group | Apps |
|---|---|
| **Platform** | [`gateway`](packages/gateway) — routing and app registry &nbsp;•&nbsp; [`core`](packages/core) — auth, profile, settings, legal pages, transactional email &nbsp;•&nbsp; [`dashboard`](packages/dashboard) — personal start page with app widgets &nbsp;•&nbsp; [`capabilities`](packages/capabilities) — discover and run the queries and actions apps publish |
| **Identity & access** | [`accounts`](packages/accounts) — users and groups, FreeIPA and local &nbsp;•&nbsp; [`oauth`](packages/oauth) — OAuth2 issuer &nbsp;•&nbsp; [`proxy-auth`](packages/proxy-auth) — Traefik forward-auth &nbsp;•&nbsp; [`ipa-hosts`](packages/ipa-hosts) — FreeIPA host management |
| **Operations** | [`gateway-ops`](packages/gateway-ops) — app registry, routes, logs, webhooks, notifications &nbsp;•&nbsp; [`pulse`](packages/pulse) — metrics, events, states, and dashboards |
| **Productivity** | [`assistant`](packages/assistant) — AI chat with code mode &nbsp;•&nbsp; [`mail`](packages/mail) — collaborative email &nbsp;•&nbsp; [`notebooks`](packages/notebooks) — collaborative notes &nbsp;•&nbsp; [`spaces`](packages/spaces) — kanban, list, and calendar with iCal &nbsp;•&nbsp; [`grids`](packages/grids) — structured data with bases, views, forms, documents, and workflows &nbsp;•&nbsp; [`filesv2`](packages/filesv2) — Cloud and FreeIPA storage through Filegate &nbsp;•&nbsp; [`files`](packages/files) — shared storage (Filegate v2) &nbsp;•&nbsp; [`contacts`](packages/contacts) — directory views |
| **Content & misc** | [`faq`](packages/faq) &nbsp;•&nbsp; [`venue`](packages/venue) &nbsp;•&nbsp; [`weather`](packages/weather) &nbsp;•&nbsp; [`quotes`](packages/quotes) &nbsp;•&nbsp; [`tools`](packages/tools) |
| **Development** | [`api-docs`](packages/api-docs) — Scalar UI aggregating every running app's OpenAPI spec |

The release set also contains the website image (`cloud-website`), the Cloud
Login PWA image (`cloud-pwa-auth`), and the `cld` CLI.

## Build your own app

Build an independent application with `@k2b/cloud` from npm. Your application
owns its repository and image and connects to the shared Cloud deployment.

Start with the [Cloud app starter](https://github.com/k2b-dev/cloud-app-starter),
a to-do app with SSR, live updates, permissions, and a `@k2b/ui` workspace.
Choose **Use this template** on GitHub and follow its README to connect it to
your development stack.

Follow [Create the first application](docs-site/docs/en/build/getting-started.md)
for the package setup, application declaration, and first verified endpoint.
Then use [Standalone development](docs-site/docs/en/operations/standalone-development.md)
to connect it to the gateway and shared services.

## How it works

```
                          HTTPS
                            │
                            ▼
                    ┌───────────────┐
                    │    Gateway    │   routes /app/<id>/* by URL prefix
                    └───┬───┬───┬───┘
                        │   │   │
            ┌───────────┘   │   └───────────┐
            ▼               ▼               ▼
       ┌─────────┐     ┌─────────┐     ┌─────────┐
       │  core   │     │  files  │     │   ...   │   each app:
       │         │     │         │     │         │   Bun + Hono + SolidJS SSR
       └────┬────┘     └────┬────┘     └────┬────┘   one container per app
            └───────────────┴────────────────┘
                            │
            ┌───────────────┼───────────────┐
            ▼               ▼               ▼
       ┌─────────┐     ┌─────────┐     ┌──────────┐
       │  NATS   │     │ Valkey  │     │ Postgres │
       │JetStream│     │         │     │          │
       └─────────┘     └─────────┘     └──────────┘
       registry, jobs,  caches,         per-app
       schedules, live  rate limits     schemas
```

Each app boots, registers itself with the gateway through NATS, and starts handling requests at its declared URL prefix. The gateway holds no per-app code — adding an app touches only that app's own files and the compose files.

Apps share Postgres (each owns its own schema), NATS JetStream (registry, jobs, schedules and live events), and Valkey (rate limits, caches and short-lived authentication flows). Browser sessions use JWTs. Per-app traffic, latency and route-trace data live in the gateway and are visible in the admin UI.

## Quick start

```bash
bun install --frozen-lockfile
bun run dev        # infrastructure + core services
open http://localhost:3000
```

Development requires Bun 1.x, Docker, and Docker Compose v2. The development
stack gets its local database, Valkey, app-secret, and admin-token values from
`compose.dev.yml`; no `.env` file is required. `.env.example` is a per-process
reference for running directly on the host; production uses `.env.prod.example`.

Dev admin login: open `/auth/login?method=admin` and paste `dev-admin` into the
token field.

| Command | What it does |
|---|---|
| `bun run dev` | Start infrastructure and the core services |
| `bun run dev:full` | Start infrastructure, core, and every optional app |
| `bun run dev:down` | Remove the app stack, keep infrastructure running |
| `bun run dev:start <app...>` | Add apps to the running stack |
| `bun run dev:stop <app...>` | Stop apps |
| `bun run dev:restart <app...>` | Reload mounted source without rebuilding images |
| `bun run dev:rebuild <app...>` | Rebuild images and restart |
| `bun run dev:logs <app>` | Follow one app's logs |
| `bun run dev:status` | Inventory of all apps |
| `bun run dev:help` | Catalog of every dev command |
| `bun run dev:cld -- <args>` | Run the checkout's CLI against the local server |
| `bun run check` | Repository rules, formatting, every package typecheck |
| `bun run test` | All tests; `--integration` with `CLOUD_TEST_*` runs the integration suites |
| `bun run format` | Format the workspace |
| `bun run release:preflight` | Check a running fleet against a release |

See [Monorepo development](docs-site/docs/en/operations/monorepo-development.md)
and [Testing](docs-site/docs/en/contributing/testing.md).

## Deploy

Releases publish `ghcr.io/k2b-dev/cloud-<image>:vX.Y.Z` for every app plus a
`release.json` with digests. See
[Deployment requirements](docs-site/docs/en/operations/deployment-requirements.md),
[Build and deploy](docs-site/docs/en/operations/build-and-deploy.md), and the
[Release process](docs-site/docs/en/contributing/release-process.md).

## Agent-assisted development

Start the documentation site from the checkout and install its developer skill:

```bash
docker compose -f docs-site/compose.yml up --build -d --wait --renew-anon-volumes
bunx skills add http://localhost:4187
```

Connect the same local documentation as an MCP server named `cloud-dev-mcp`:

```bash
# Codex
codex mcp add cloud-dev-mcp --url http://localhost:4187/_fibel/mcp

# Claude Code
claude mcp add --transport http cloud-dev-mcp http://localhost:4187/_fibel/mcp
```

If port `4187` is occupied, set `FIBEL_PORT=4199` for the Compose command and
replace the port in the URLs. See
[Document Cloud core changes](docs-site/docs/en/contributing/document-cloud-core-changes.md)
for the full setup.

Repository-wide agent instructions live in [`AGENTS.md`](AGENTS.md); Claude
Code loads them through [`CLAUDE.md`](CLAUDE.md).

Install the skills from the repository:

```bash
bunx skills add github.com/k2b-dev/cloud
```

- [`cloud-dev`](docs-site/agent-skills/cloud-dev/SKILL.md) — public application contract for standalone and built-in Cloud apps
- [`cloud-cli`](skills/cloud-cli/SKILL.md) — using a Cloud instance from the terminal with `cld`

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the branch model, pull request
titles, and local checks; [SECURITY.md](SECURITY.md) for reporting
vulnerabilities; and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

GNU Affero General Public License v3.0 or later — see [LICENSE](./LICENSE).

Commercial use, hosting, modification, and redistribution are permitted under
the AGPL. If you modify Cloud and let users interact with it over a network,
you must provide those users access to the corresponding source code under the
same license.

Separate commercial licenses for proprietary, reseller, managed-service,
white-label, or embedded product use are available by contacting the maintainer.
