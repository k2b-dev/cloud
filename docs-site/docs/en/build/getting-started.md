---
title: Create the first application
navTitle: First application
section: Build an app
order: 110
description: Build and verify a standalone API-only application with the published Cloud package.
tags: [applications, getting-started, standalone]
updated: 2026-08-12
---

# Create the first application

Build Cloud applications in their own repositories. A standalone application
owns its source, dependencies, image, version, and release cycle while Cloud
supplies the gateway and shared platform services.

This guide creates an API-only `inventory` service with one endpoint:

```text
GET /api/inventory/health
```

The first direct request proves the application package and process. A later
request through the gateway proves that deployment networking, registration,
and route discovery agree.

## Work with a coding agent

Fibel publishes the `cloud-dev` Agent Skill for standalone and built-in Cloud
applications. Open the **Agents** dialog in the documentation footer to install
it for your agent. The skill supplies stable application boundaries and routes
the agent to current documentation instead of duplicating API details.

For documentation access, configure a streamable HTTP MCP server named
`cloud-dev-mcp` at `https://cloud.k2b.dev/_fibel/mcp`, then restart the agent
session. The agent should call `list_collections`, `search_docs`, and `read_doc`
before choosing an implementation.

## Prepare a standalone project

Install [Bun](https://bun.sh/) and create a repository:

```bash
mkdir cloud-inventory
cd cloud-inventory
bun init -y
mkdir -p src
```

Add the Cloud package and its public peer dependencies:

```bash
bun add @k2b/cloud hono solid-js zod
bun add --dev @types/bun typescript
```

Pin `@k2b/cloud` to the version used by the target Cloud deployment
before committing the lockfile. An application and its platform must agree on
their public runtime contracts.

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "lib": ["ESNext", "DOM", "DOM.AsyncIterable"],
    "target": "ESNext",
    "module": "Preserve",
    "moduleDetection": "force",
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "noEmit": true,
    "strict": true,
    "skipLibCheck": true,
    "noUncheckedIndexedAccess": true
  },
  "include": ["src/**/*.ts", "src/**/*.tsx"]
}
```

The application imports only published package entry points. It does not need
the Cloud source repository, workspace aliases, or another application package.

## Declare the service boundary

Create `src/config.ts`:

```ts
import { defineApp } from "@k2b/cloud";

export const app = defineApp({
  id: "inventory",
  name: "Inventory",
  icon: "ti ti-packages",
  description: "Track stock and warehouse movements.",
  baseUrl: "http://inventory:3000",
  routes: ["/api/inventory"],
});
```

The declaration is the service's public platform identity:

- `id` remains stable across releases;
- `baseUrl` is the private address the gateway can reach;
- `routes` contains only prefixes the service actually handles.

This API-only application declares no page, asset, or administration prefix.
See [Define an application](/en/docs/build/define-app) for every declaration
option and [Routes and discovery](/en/docs/build/routing) for prefix ownership.

## Handle one request

Create `src/index.ts`:

```ts
import { Hono } from "hono";
import { app } from "./config";

const router = new Hono().get("/api/inventory/health", (c) =>
  c.json({
    app: app.meta.id,
    status: "ok",
  }),
);

export default await app.start({
  fetch: router.fetch,
});
```

`defineApp()` does not create routes. Hono owns request matching and the
application passes its final Fetch handler to `app.start()`.

This public health endpoint needs no caller identity or platform settings. Add
[request middleware](/en/docs/server/middleware) when a route needs request
context, authentication, settings, logging, or rate limits.

## Verify the process directly

Every application needs a Valkey connection for live registration and the same
non-empty `APP_SECRET` as its Cloud deployment. For an isolated local smoke
test, point both values at development-only infrastructure:

```bash
REDIS_URL=redis://127.0.0.1:6379 \
APP_SECRET=local-development-only \
bun src/index.ts
```

In another terminal, request the application directly:

```bash
curl http://127.0.0.1:3000/api/inventory/health
```

The response is:

```json
{
  "app": "inventory",
  "status": "ok"
}
```

This check proves the public package, application declaration, Hono router, and
process startup. It does not prove gateway routing, shared identity, or other
platform services.

## Connect the application to Cloud

Run the application on the same private network as the target Cloud deployment.
The deployment must provide:

- a gateway and Core;
- Valkey through `REDIS_URL`;
- the deployment-wide `APP_SECRET`;
- Postgres through `DATABASE_URL` once the application stores domain data;
- any optional platform service the application uses.

The hostname and port in `baseUrl` must resolve from the gateway. After the
application starts, call the same route through the public gateway origin:

```bash
curl https://cloud.example/api/inventory/health
```

A gateway `502` means no usable live service owns the prefix. A `404` means the
gateway reached the application but Hono did not match the path. Follow the
[route diagnosis](/en/docs/build/routing#diagnose-an-unreachable-route) before
adding application logic.

Do not expose the application container as a second public origin. The gateway
is the public boundary for routing, identity, and platform-wide policy.

## Grow by responsibility

The first version needs only two files:

```text
src/
├── config.ts
└── index.ts
```

Add a file or directory only when that responsibility exists:

```text
src/
├── config.ts
├── index.ts
├── contracts.ts
├── migrate.ts
├── api/
├── data/
├── service/
└── frontend/
```

| Path | Responsibility |
| --- | --- |
| `config.ts` | Application identity and declarative platform integrations |
| `index.ts` | Middleware order, route mounting, and `app.start()` |
| `contracts.ts` | Input and output schemas shared across boundaries |
| `migrate.ts` | Idempotent application-schema changes |
| `api/` | HTTP transport |
| `data/` | Queries and repositories |
| `service/` | Domain rules |
| `frontend/` | SSR pages and interactive islands |

Keep business rules and persistence out of route handlers. Domain services
receive explicit inputs instead of a Hono context.

## Continue by capability

- [Protect routes and resources](/en/docs/identity).
- [Define typed HTTP APIs](/en/docs/server/http).
- [Store domain data](/en/docs/data/postgres-queries).
- [Add SSR pages](/en/docs/frontend/ssr-pages-and-routing).
- [Declare settings](/en/docs/platform/settings).
- [Run setup and background work](/en/docs/build/lifecycle).
- [Build and deploy the application](/en/docs/operations/build-and-deploy).
