---
title: Public site of an app
navTitle: Public site
section: Build an app
order: 145
description: Serve an app-owned website on assigned domains, with its own HTML, sessions and SSR islands.
tags: [applications, public, domains, routing, ssr, seo]
updated: 2026-10-31
---

# Public site of an app

Declare `public: true` to serve a separate website through `app.public`, a
normal Hono router. An administrator assigns domains to the app. Every
assigned domain reaches only that app's public router, including paths such
as `/api/...`; it never enters another app or the Cloud interface.

One app has one public router and can have several domains. The app owns its
HTML, routes, sessions and business rules. It does not need another Cloud
account or service account for each visitor.

## Declare the site

Keep the normal required app fields. Add `public: true`, then register public
routes independently of the routes served on the Cloud host:

```ts
import { defineApp } from "@k2b/cloud";
import { links } from "@k2b/cloud/services";
import { appKey } from "@k2b/cloud/server";
import { setSignedCookie } from "hono/cookie";

export const app = defineApp({
  id: "website", name: "Website", icon: "ti ti-world", description: "Our website",
  baseUrl: "http://website:3000", routes: ["/app/website"], public: true,
});
app.public.get("/", (c) => c.html(homeHtml()));
app.public.get("/sitemap.xml", (c) => c.body(sitemapXml(), 200, { "Content-Type": "application/xml" }));
app.public.get("/old-page", (c) => c.redirect("/new-page", 301));
app.public.post("/sign-in", async (c) => {
  const token = String((await c.req.parseBody()).token ?? "");
  const r = await links.redeem(token, { purpose: "login" });
  if (!r.ok) return c.html(invalidLinkHtml(), 400);
  await setSignedCookie(c, "__Host-site-session", r.data.subject, appKey("site-session"), {
    httpOnly: true, secure: true, sameSite: "Lax", path: "/",
  });
  return c.redirect("/portal", 303);
});
```

`homeHtml`, `sitemapXml` and `invalidLinkHtml` are app-owned renderers.
[One-time links](/en/docs/identity/one-time-links) explains the link contract,
its `{ ok, data: { subject, createdAt } }` success result, and session ownership.
The synchronous `appKey(name)` supplies the signing secret; the app decides
how a subject may act. A link subject is not a Cloud principal.

`app.public` exists on the app definition. Starting an app with public routes
but without `public: true` fails with a clear declaration error. The flag is
advertised in the app registry; without it the gateway serves no public site.
Do not declare or mount `/_cloud/public` or paths below it yourself. The
platform reserves that prefix for internal dispatch; the gateway also owns
`/_cloud/domain-check/*` on app domains.

Hono's `hono/bun` WebSocket upgrades also work on `app.public`. Keep the
entry point's usual `websocket` handler alongside its `fetch` export.

## Read the public URL

Inside public handlers, `c.req.path` is the original path and `c.req.url` is
its public absolute URL. The internal `/_cloud/public` prefix is removed.
The platform reconstructs the URL from the gateway's trusted
`X-Cloud-Public-Host` authority: a normalized host, with the client's numeric
port when one was present. Missing or invalid authorities receive 404 before
the public router runs.

```ts
app.public.get("/", (c) =>
  new URL(c.req.url).hostname.startsWith("portal.")
    ? portalPage(c)
    : homePage(c));
```

The scheme is HTTPS. In development, a `*.localhost` host uses HTTP; for
example, `http://website.localhost:3100/products?q=chair`. Ports survive URL
reconstruction, subject to standard URL normalization of default ports.
An assigned development host such as `preview.example.com` still uses HTTPS.

## Render HTML and islands

Use `app.publicSsr(template)` for the site's own document template. It returns
`{ html }` and mounts the island assets and development reload endpoints at
`/_ssr` on `app.public`. Call it before registering catch-all page routes.
Keep exporting and using the app's existing `plugin`; there is one island
build for the whole app, in development and production.

```tsx
// src/public-site.tsx
import { appAssetPath } from "@k2b/cloud/server";
import { app } from "./config";
import ProductFinder from "./ProductFinder.island";

const site = app.publicSsr<{ title: string }>(({ body, scripts, title }) =>
  `<!doctype html><html lang="en"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${Bun.escapeHTML(title)}</title><link rel="stylesheet" href="/site.css">
  </head><body>${body}${scripts}</body></html>`);

app.public.get("/site.css", () => new Response(Bun.file(appAssetPath("site.css")), {
  headers: { "Content-Type": "text/css; charset=utf-8" },
}));
app.public.get("/", () => site.html(
  () => <main><h1>Our products</h1><ProductFinder /></main>,
  { title: "Our products" },
));
```

Import this module from the app's server entry point before `app.start()`.
Keep `ProductFinder.island.tsx` under the app's `src` directory so the existing
plugin discovers it. Keep the render function synchronous; load data before
calling `html()`. The template must include `scripts` so islands can mount.

This example keeps plain site CSS at `src/assets/site.css`.
`appAssetPath("site.css")` reads that file in development and its copied
`dist/assets/site.css` in production. For compiled CSS, an app-owned
[`scripts/build-extras.ts`](/en/docs/operations/build-and-deploy) can write
`DIST_DIR/assets/site.css`; serve it with the same route. Generate the source
asset for development too. Choose hashed URLs and immutable caching when
shipping versioned files.

Cloud's HTML shell, stylesheets and navigation are not injected. The public
renderer uses the same discovered islands and build manifest as the normal
app, with public asset URLs starting at `/_ssr`. Production island URLs carry
the build version and immutable caching. Ship the complete `_ssr` directory
beside the server bundle as usual. There is no second plugin or build.

## Use client IPs and rate limits

`clientIp(c)` and `rateLimit` from `@k2b/cloud/server` work without the Cloud
middleware stack. The gateway resolves the client address according to
`gateway.trusted_proxies` and replaces incoming forwarded-address headers.

```ts
import { clientIp, rateLimit } from "@k2b/cloud/server";

app.public.post("/contact", rateLimit({ keyBy: "ip", limitPerSecond: 2 }), async (c) => {
  await acceptContactMessage(await c.req.parseBody(), clientIp(c));
  return c.json({ received: true }, 201);
});
```

Set `keyBy: "ip"` for visitor budgets. The middleware uses Cloud's shared
Valkey limiter, returns 429 with `Retry-After` when exhausted, and needs no
Cloud session or request context. An explicit `limitPerSecond` defines the
route budget; omitted limits use the installation setting.

## Keep the normal app lifecycle

`public: true` adds the public router and registry declaration. The app keeps
its normal `app.start()`, lifecycle setup/start/stop, settings, scheduler,
Sync jobs and queues, and `mail.send()` contract. Existing platform permissions
and resource authorization still apply to those services. The website runs
in the same app process and calls its own services directly.

A public request gets no Cloud authentication stack, app access rule,
`noTransform`, Cloud request logger context, or Cloud credential cookies.
Credential cookies are removed before handlers run; app-owned cookies remain available.
Use the app's own visitor session and authorization in public handlers.

## Assign and check domains

An administrator uses the Core API or `cld`:

```sh
cld --profile operator admin apps domains add website example.com
cld --profile operator admin apps domains add website www.example.com --redirect-to example.com
cld --profile operator admin apps domains ls website
cld --profile operator admin apps domains check website example.com
cld --profile operator admin apps domains set website www.example.com --no-redirect
cld --profile operator admin apps domains rm website www.example.com --yes
```

New assignments require a known app ID in the durable application package
registry. A stopped app can receive a domain; a typo fails with
`APP_DOMAIN_UNKNOWN_APP`. `active` means the app currently has a live registry
entry with `public: true`. Assignments survive app downtime. A new domain is
checked in the background, so DNS and TLS do not delay the creation response.
Gateway routing refreshes within five seconds.

Hosts normalize to lowercase ASCII/IDNA without a trailing dot. Do not supply
a scheme, path, port, IP address or wildcard. The Cloud host cannot be
assigned. One domain belongs to one app. A redirect target must be another
domain of the same app with no redirect of its own. Remove incoming redirects
before redirecting or removing their target; the error names the referring
domains. These rules hold under concurrent changes.

Checks run from Core: DNS addresses, then a valid TLS certificate on port 443
with SNI, then a nonce response from the Cloud gateway. Each network stage has
a five-second timeout and a failure leaves later stages unchecked (`null`).
Checks run at most once per 60 seconds per domain, including concurrent Core
replicas. The last result remains stored. A first check in progress can return
`status: null`; list the domains again shortly. Domain assignment itself does
not wait for a successful check.

An assigned host is an administrator-controlled outbound target for that
check, restricted to port 443; addresses are resolved and pinned through the
platform network guard. Core must be able to reach the public ingress. A
router without hairpin NAT can make reachability fail for visitors on Core's
network even while the website works from outside. Fix that routing or split
DNS and check again; do not disable certificate validation.

See [App domains](/en/docs/operations/app-domains) for ingress, TLS and gateway
protections.

### Administrator API

All routes require an administrator. OAuth mutations also require `admin`
scope. Responses use `Cache-Control: no-store`; changes are audited.

| Method and path | Input | Success |
| --- | --- | --- |
| `GET /api/admin/apps/:appId/domains` | — | `{ domains: [{ host, redirectTo, createdAt, active, status }] }` |
| `POST /api/admin/apps/:appId/domains` | `{ host, redirectTo? }` | 201, the created domain |
| `PATCH /api/admin/apps/:appId/domains/:host` | `{ redirectTo: string \| null }` | The updated domain |
| `DELETE /api/admin/apps/:appId/domains/:host` | — | `{ deleted: true }` |
| `POST /api/admin/apps/:appId/domains/:host/check` | — | `{ status }` |

A status is `{ checkedAt, dns, certificate, reachable }`; each completed step
is `{ ok, detail }`. Unchecked stages and a missing status are `null`.
Errors use `{ code, message }`: `APP_DOMAIN_INVALID_HOST`,
`APP_DOMAIN_CLOUD_HOST`, `APP_DOMAIN_UNKNOWN_APP`, `APP_DOMAIN_ASSIGNED`,
`APP_DOMAIN_REDIRECT_TARGET`, `APP_DOMAIN_REFERENCED`,
or `APP_DOMAIN_NOT_FOUND`. Invalid app ID syntax uses the standard request
validation error.

CLI `--json` and `--jsonl` preserve these API payloads. The list table shows
host, redirect, active state and DNS/certificate/reachability. `check` shows
each stage and its detail; use it to diagnose a failed row.

## Develop locally

In development, the gateway maps `<appId>.localhost:<gateway port>` to the
public router automatically. For a gateway on port 3100, open
`http://website.localhost:3100/`. No Core domain assignment is needed.
The app must still declare `public: true` and have a live registry entry.

For a development host behind TLS, such as Caddy forwarding
`https://preview.example.com` to the development gateway, assign the host:

```sh
cld --profile development admin apps domains add website preview.example.com
```

Configure the ingress and DNS for that host as described in
[App domains](/en/docs/operations/app-domains). The app sees
`https://preview.example.com/...`; only development `*.localhost` hosts use
HTTP.

## SEO and response behavior

The app controls every HTML byte, title and metadata field. Cloud adds no
shell, JavaScript, forced `noindex` or forced Content Security Policy to the
site. If the app chooses `publicSsr`, its island loader is included by its own
template.

| Guarantee | Owner |
| --- | --- |
| Titles, descriptions, canonical URLs, hreflang, Open Graph and structured data | App; the gateway never rewrites HTML |
| `robots.txt` and `sitemap.xml` are ordinary routes | App |
| 301, 308, 404 and 410 pass through; redirects are not followed | Gateway |
| HEAD, ETag/If-None-Match with 304, Last-Modified, Vary and Cache-Control keep their HTTP semantics | App and gateway |
| Brotli/gzip compression for text responses, including crawlers | Gateway; explicit no-transform and existing content encodings are respected |
| No Cloud routing headers such as X-Gateway-App on app domains | Gateway |
| Immutable caching for versioned static files | App sets the header; gateway preserves it |
| Readable initial content without JavaScript | App SSR |
| Response time and asset weight | App and gateway; measure the deployed page |

### App SEO checklist

- Give each page `lang`, a title, description and absolute canonical URL on the primary domain.
- Add hreflang with `x-default` for translated pages.
- Point `robots.txt` at a sitemap containing only canonical URLs.
- Redirect old addresses with 301; return 410 for removed content.
- Use content hashes in asset names and `Cache-Control: public, max-age=31536000, immutable`.
- Give HTML an ETag or Last-Modified validator.
- Set image width and height, use modern formats, and lazy-load images below the first viewport.
- Put content in the SSR HTML; use islands for interaction.

The [standalone public-site example](https://github.com/k2b-dev/cloud/tree/main/packages/cloud/examples/public-site)
follows every point of this list: two translated pages, `robots.txt`, a
sitemap, a permanent redirect, a `410`, ETags, a hashed logo and one island.
Cloud measures it through the gateway's app-domain path with Lighthouse and
requires SEO 100 and mobile performance 95.
