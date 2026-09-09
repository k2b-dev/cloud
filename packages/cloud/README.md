<p align="center">
  <img src="https://raw.githubusercontent.com/k2b-dev/cloud/main/packages/cloud/public/logo.svg" alt="Cloud" width="96" height="96">
</p>

<h1 align="center">@k2b/cloud</h1>

<p align="center">
  <em>Modular Hono+SolidJS framework for building per-app docker services behind a dynamic gateway.</em>
</p>

The runtime that powers [github.com/k2b-dev/cloud](https://github.com/k2b-dev/cloud) — an application platform that runs on infrastructure you operate, where every feature ships as its own Bun container, registers with a gateway through Redis, and inherits a shared session, UI kit, settings store, search, logging, email, websockets, and admin surface.

## Install

```bash
bun add @k2b/cloud
```

The package is published as `.ts` source. It is intended for **Bun** consumers.

## Quick start

```ts
// packages/my-app/src/config.ts
import { defineApp } from "@k2b/cloud";

export const app = defineApp({
  id: "my-app",
  name: "My App",
  icon: "ti ti-rocket",
  description: "What this app does",
  basePath: "/app/my-app",
  baseUrl: "http://app-my-app:3000",
  nav: { href: "/app/my-app", section: "more", requiresAuth: true },
  routes: ["/api/my-app", "/app/my-app", "/admin/my-app", "/public/my-app"],
});

export const { ssr, plugin } = app;
```

```ts
// packages/my-app/src/index.ts
import { app } from "./config";
import { Hono } from "hono";

export default await app.start({
  routes: {
    api: new Hono().get("/", (c) => c.json({ ok: true })),
    pages: new Hono().get("/", ...ssr(() => () => <div>hello</div>)),
  },
});
```

A standard app declares four prefixes (`/api/<id>`, `/app/<id>`, `/admin/<id>`, `/public/<id>`); the gateway routes them to your container by URL prefix from a Redis-backed registry.

## Public building blocks

| Import | Use for |
|---|---|
| `@k2b/cloud` | `defineApp`, common types |
| `@k2b/cloud/server` | server context, auth, route helpers |
| `@k2b/cloud/browser` | typed browser client |
| `@k2b/cloud/services` | settings, logging, notifications, search |
| `@k2b/cloud/contracts` | shared public contracts |
| `@k2b/cloud/ssr` | Cloud SSR helpers and islands |
| `@k2b/cloud/workflows` | durable, inspectable application workflows |
| `@k2b/cloud/ai` | AI and tool-calling contracts |
| `@k2b/cloud/cli` | application CLI commands |
| `@k2b/cloud/config` | documented configuration helpers |
| `@k2b/ui` | Portable UI components and application layouts |
| `@k2b/stdlib/solid` | owner-local queries, mutations, and interaction primitives |
| `@k2b/ssr` | portable SolidJS SSR, islands, and navigation |
| `@k2b/sync` | distributed coordination, jobs, queues, and schedulers |
| `@k2b/cloud/access/ui` | Cloud access and resource-key controls |
| `@k2b/cloud/account/ui` | Cloud account selectors and avatars |
| `@k2b/cloud/ai/ui` | Cloud AI protocol adapters |
| `@k2b/cloud/styles/global.css` | base Tailwind stylesheet |

## Documentation

Full walkthroughs, the per-app anatomy, deployment templates, and a reference app:

- **[github.com/ValentinKolb/cloud-template](https://github.com/ValentinKolb/cloud-template)** — starter repo with a working reference app + the complete app-authoring guide
- **[github.com/k2b-dev/cloud](https://github.com/k2b-dev/cloud)** — the platform monorepo (gateway, core, all platform apps)

## License

GNU Affero General Public License v3.0 or later.

Commercial use, hosting, modification, and redistribution are permitted under
the AGPL. If you modify Cloud and let users interact with it over a network,
you must provide those users access to the corresponding source code under the
same license.

Separate commercial licenses for proprietary, reseller, managed-service,
white-label, or embedded product use are available by contacting the maintainer.

See the repository `LICENSE` file.
