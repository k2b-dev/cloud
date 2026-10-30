---
title: App domains
navTitle: App domains
section: Operations
order: 1127
description: Assign domains to an application's public site, configure TLS ingress, and diagnose domain checks.
tags: [domains, gateway, deployment, ingress, tls]
updated: 2026-10-31
---

# App domains

An assigned domain opens one application's public site. The application must
declare `public: true` and serve its site through `app.public`. Every path on
that domain belongs to that application, including `/api`, `/public/storage`,
`/health`, and WebSocket connections. The site becomes unavailable when its
application or Cloud goes down.

**Upgrade notice: unknown hosts now receive HTTP 421.** A second DNS name,
reverse-proxy alias, IP address, or monitoring hostname no longer opens Cloud
unless it is a configured Cloud/internal gateway host or an assigned app
domain. Point Cloud clients at the host in `app.url`; assign a second site
hostname to its application. `X-Forwarded-Host` does not select a host.
Unassigned hosts retain `/health` and `/_cloud/ready` for container probes.

## Deploy in order

1. Upgrade Core first so it creates the durable domain-assignment table.
2. Upgrade the gateway and configure the private ingress provider below.
3. Deploy applications that declare a public site, then assign their domains.

Before Core's migration, the gateway sees no domain assignments. Domain
assignments remain stored when an application stops. TLS discovery continues
to include them, and requests return `503` with `Retry-After` until the app
registers again. A running app without `public: true` receives no site traffic;
its assigned hosts return `421`.

## Assign a domain

Use a Cloud administrator profile for the target installation:

```sh
cld --profile operator admin apps domains ls webseite
cld --profile operator admin apps domains add webseite www.example.org
cld --profile operator admin apps domains add webseite example.org --redirect-to www.example.org
```

Point the domain's DNS A/AAAA records at your ingress. Configure ingress to
preserve the request's `Host`, `Origin`, `Sec-Fetch-Site`, and `Sec-Fetch-Dest`,
forward WebSockets, and stream responses without buffering. Configure trusted
proxy addresses through `gateway.trusted_proxies` as described in
[Pass client addresses through the reverse proxy](/en/docs/operations/deployment-requirements#pass-client-addresses-through-the-reverse-proxy).

An alias sends `301` for GET/HEAD and `308` for other methods, preserving the
path and query. The redirect destination is HTTPS. Assign the destination to
the same application; redirect chains are not supported.

Changes are reconciled from durable assignments and the live application
registry within five seconds. Restarting the application or gateway is not
required.

## Configure Traefik

The gateway serves a separate, private listener on port `3001`, controlled by
`GATEWAY_INGRESS_PORT`. Keep this port reachable only by trusted ingress and
administration infrastructure. Do not publish it to the Internet or add a
public Traefik router for it. The supplied production Compose declares the
container port without publishing a host port.

Add the HTTP provider to Traefik's static configuration:

```yaml
providers:
  docker: {}
  http:
    endpoint: http://gateway:3001/_cloud/ingress/traefik
    pollInterval: 5s
```

Traefik must be able to resolve and reach `gateway` on its shared private
network. The provider emits one `Host(...)` router per durable assignment,
including redirect aliases, on `websecure`, with a `cloud` load-balancer
service pointing at `http://gateway:3000`. This matches the supplied Compose
entrypoint and gateway service names.

Configure an ACME certificate resolver named `le` in Traefik, or change the
admin setting to your existing resolver:

```sh
cld --profile operator admin settings set gateway.ingress_cert_resolver --value '"myresolver"'
```

The setting affects app-domain routers within five seconds. Configure your
existing Cloud-host router separately, as in the production Compose labels.
For other ingress names or network addresses, adapt the provider configuration
to your deployment before exposing the domains.

## Configure Caddy instead

Caddy can ask the private gateway listener before issuing a certificate for a
new domain. Keep the Cloud host's existing site block; the catch-all block
below is for app domains:

```caddyfile
{
    on_demand_tls {
        ask http://gateway:3001/_cloud/ingress/allowed
    }
}

https:// {
    tls {
        on_demand
    }
    reverse_proxy gateway:3000
}
```

Caddy supplies `?domain=<host>`. Assigned domains receive `200`; every other
name receives `404`. Admission follows durable assignments, even while an
application is offline. Removing an assignment prevents future admission;
it does not revoke a certificate already issued by your ingress.

## Read domain checks

The administration checks DNS, certificate validity, then reachability:

- **DNS:** A/AAAA records exist. This alone does not prove that DNS points to
  this gateway.
- **Certificate:** the domain completes TLS with a valid certificate.
- **Reachability:** a short-lived nonce sent to
  `GET /_cloud/domain-check/<nonce>` returns unchanged from this gateway.

Only assigned hosts with a live nonce receive the special check response. It
is plain text with `Cache-Control: no-store`. Other requests to that path
belong to the app. Checks are limited to once per minute per domain.

If DNS and TLS succeed but reachability fails, check proxy routing and whether
the gateway can reach its own public ingress. Hairpin NAT, split DNS, or
outbound firewall rules can prevent an internal check even when visitors can
open the site. Verify from an external network as well.

## Default protections and caching

App-domain requests discard Cloud credential cookies before reaching the app.
Site cookies remain. The gateway forwards its trusted client-IP resolution,
so `clientIp(c)` and application `rateLimit()` use the visitor's address.

For methods other than GET, HEAD, and OPTIONS, an `Origin` must match the
site's exact origin, including an explicit port. Requests marked `same-site`
or `cross-site` by `Sec-Fetch-Site` receive `403`. This rule also applies to
every WebSocket handshake. Server webhooks without either header pass.

Requests have separate budgets per domain and client IP, derived from
`security.rate_limit_per_second`. Each domain also has an aggregate budget of
100 times that setting: capacity for 100 clients using their full individual
budget. Exhaustion returns `429` with `Retry-After`. Valkey admission failure
returns a retryable `503`.

A response that sets a cookie receives `Cache-Control: private, no-store`.
Other application cache directives pass through. The gateway supplies
`X-Content-Type-Options: nosniff` and
`Referrer-Policy: strict-origin-when-cross-origin` when the app has not set
those headers. Applications own CSP, framing policy, indexing, canonical URLs,
sitemaps, and robots files. App-domain responses have no Cloud telemetry
headers.

Cookie-less requests can receive Brotli or gzip for text, JavaScript, JSON,
XML, and SVG, including crawler visits and arrivals from another site. Cloud
credential cookies are removed before deciding this; any remaining site cookie
retains the existing conservative compression rule. Applications serving
private content alongside attacker-controlled text should use
`Cache-Control: no-transform`. See [Response compression](/en/docs/build/routing#response-compression).

## Development

With `NODE_ENV=development`, a running app with `public: true` is available at
`http://<appId>.localhost:<gateway-port>` without a database assignment. For
example, `http://webseite.localhost:3100/products` reaches the public router
and retains `webseite.localhost:3100` in the application's public URL. Browsers
normally resolve `*.localhost` to loopback. The public scheme is HTTP for
these automatic localhost domains.

For a development domain behind TLS, assign the domain through the same
administrator CLI and configure Caddy or Traefik to forward it to your local
gateway, for example `127.0.0.1:3100`. An assigned `site.dev.example.org` uses
HTTPS even in development. Preserve its original Host header. The Cloud host
from `app.url` remains valid alongside these site domains, and development
also accepts `localhost`, `127.0.0.1`, and IPv6 loopback for local Cloud tooling.
The internal `gateway` service host continues to support Collabora and other
container callers. See [Serve the stack under another address](/en/docs/operations/monorepo-development#serve-the-stack-under-another-address)
for the Cloud origin setup.
