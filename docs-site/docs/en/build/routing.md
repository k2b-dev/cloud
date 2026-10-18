---
title: Routes and service discovery
navTitle: Routes and discovery
section: Build an app
order: 140
description: Publish route prefixes and make an application reachable through the gateway.
tags: [applications, routing, gateway, registry]
updated: 2026-10-09
---

# Routes and service discovery

An application declares its private upstream address and public path prefixes
because the gateway must route without importing or statically configuring the
application. The gateway builds its route table from live declarations.

## Declare only served prefixes

```ts
export const app = defineApp({
  // required metadata
  baseUrl: "http://app-inventory:3000",
  routes: [
    "/api/inventory",
    "/app/inventory",
    "/admin/inventory",
    "/public/inventory",
  ],
});
```

An API-only application needs only its API prefix. Applications with special
public paths declare those exact paths.

See [Route conventions](/en/docs/reference/route-conventions) for the standard
prefixes, reserved paths, and matching rules.

Do not list `/pwa` paths. An application adds pages to the mobile app with
`defineApp({ pwa })`, which declares `/pwa/<id>` for it; see
[Pages in the mobile app](/en/docs/frontend/mobile-app-pages) (preview).

> **Do not serve HTML below `/public`.** Cloud handles `/public/*` before the
> application router and returns a terminal asset response. Use a separate
> prefix such as `/share/<id>` for anonymous pages.

## Mount the same paths in Hono

The gateway forwards the original path and query to the host and port of
`baseUrl`, whatever the path looks like. Only a leading run of slashes becomes
one, as route matching already treats it, so a request for `//app/inventory`
reaches the application as `/app/inventory`. Mount the declared prefixes:

```ts
const router = new Hono()
  .route("/api/inventory", apiRoutes)
  .route("/app/inventory", pageRoutes);
```

Declaring a prefix does not create a Hono route. Mounting a Hono route does not
publish it to the gateway.

## Response compression

The gateway forwards response bodies unchanged, with one exception: it
compresses `text/html`, `application/json`, and `application/*+json`
responses. It chooses Brotli or gzip from the request's `Accept-Encoding` and
streams each upstream chunk as it arrives. Applications still receive the
original `Accept-Encoding`, so they can serve precompressed static files.

These responses stay unchanged:

- responses that already have a `Content-Encoding`;
- responses with `Cache-Control: no-transform`, and answers to requests that
  send it;
- `206` and other responses with `Content-Range`, answers to `HEAD`, and
  `1xx`, `204`, and `304` responses;
- bodies with a `Content-Length` below 1024 bytes;
- SSE (`text/event-stream`), NDJSON (`application/x-ndjson`), and every
  other media type;
- answers to cross-site and same-site browser requests (`Sec-Fetch-Site`
  other than `same-origin` or `none`).

An eligible response gets `Vary: Accept-Encoding, Sec-Fetch-Site`, also when
it stays uncompressed. A compressed response loses `Content-Length` and
`Accept-Ranges`, and a strong `ETag` becomes weak. Compare `If-None-Match`
weakly: `W/"x"` matches `"x"`, a list matches when one tag matches, and `*`
matches any current representation.

Compression can reveal a secret through the response length (BREACH) when the
same response also contains text that an attacker chose. Session cookies are
`SameSite=Lax`, so an attacker can only send such requests as cross-site
navigations, and those stay uncompressed. If your application copies text from
its URL into a same-origin request whose response also contains a credential,
such as a token or a feed URL, set `Cache-Control: no-transform` on that
response.

## Internal service address

`baseUrl` is the address used by the gateway:

```ts
baseUrl: "http://app-inventory:3000",
```

The hostname normally matches the Compose or Kubernetes service name.

Do not use `localhost` when the gateway runs in another container.
`localhost` would refer to the gateway container itself.

## Service registration

`app.start()` writes one registry entry containing:

- application identity and `baseUrl`;
- route prefixes;
- navigation and administration links;
- optional search, widget, setting, legal-link, and OpenAPI metadata.

The application refreshes the entry while it runs. A clean shutdown removes
it. The gateway watches the registry and rebuilds its route table when entries
change.

No static gateway rule is required for each application.

## Diagnose an unreachable route

Check the path in this order:

1. Confirm the application process is running.
2. Confirm `app.start()` completed.
3. Resolve `baseUrl` from the gateway container.
4. Confirm the prefix is listed in `routes`.
5. Confirm the same path is mounted in Hono.
6. Check for a duplicate-prefix or reserved-prefix warning in gateway logs.

Use the target deployment's application and gateway health or log commands for
the first two checks. Repository-specific development commands are maintainer
tools, not part of the standalone application contract.

See [Operations troubleshooting](/en/docs/operations/troubleshooting) for
registry and container failures.

## Protect the destination

The gateway selects an upstream. It does not authenticate or authorize the
request.

Use:

- [Route policies](/en/docs/identity/route-policies) for caller classes;
- [Resource authorization](/en/docs/identity/authorization) for domain access;
- [Public access](/en/docs/identity/public-and-anonymous-access) for anonymous
  routes.
