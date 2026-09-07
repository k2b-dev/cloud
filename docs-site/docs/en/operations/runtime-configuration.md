---
title: Runtime configuration
navTitle: Runtime configuration
section: Operations
order: 1140
description: Configure application containers, platform connections, and environment-specific values.
tags: [configuration, environment, settings]
updated: 2026-09-07
---

# Runtime configuration

Use environment variables for infrastructure. Use Cloud settings for product
configuration.

For the services and optional integrations needed by each app, start with
[Deployment requirements](/en/docs/operations/deployment-requirements).

Cloud validates settings when it reads them. Values stored in Postgres are
encrypted with `APP_SECRET`.

## Set infrastructure variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection used by Bun SQL |
| `REDIS_URL` | Valkey connection used by Bun Redis for caches and rate limits |
| `NATS_SERVERS` | Comma-separated NATS JetStream bootstrap URLs |
| `SYNC_NAMESPACE` | Deployment namespace shared by all application processes |
| `NATS_CREDS_FILE` | Optional mounted NATS credentials file |
| `NATS_TLS_CA_FILE` | Optional trusted CA file for NATS TLS |
| `NATS_IGNORE_CLUSTER_UPDATES` | Keep reachable seed addresses when advertised Docker hostnames are inaccessible |
| `APP_SECRET` | Encrypts settings and credentials |
| `CLOUD_IDENTITY_KEY_ENCRYPTION_KEY` | Core-only KEK for private platform signing keys; exactly 64 hexadecimal characters |
| `CLOUD_IDENTITY_NEXT_KEY` | Temporary next Core KEK, distributed before promotion |
| `CLOUD_IDENTITY_PREVIOUS_KEY` | Temporary previous Core KEK during a rolling rewrap |
| `CLOUD_OAUTH_BROKER_SECRET` | Shared only by Core and OAuth to authenticate OAuth issuance; exactly 64 hexadecimal characters; required when running OAuth |
| `CLOUD_IDENTITY_JWKS_ORIGIN` | Optional private transport origin for loading Core's public identity JWKS; does not change the public issuer |
| `CLOUD_OAUTH_JWKS_ORIGIN` | Optional private transport origin for loading OAuth's public JWKS; does not change the public issuer |
| `CLOUD_CORE_INTERNAL_ORIGIN` | Private Core origin required for OAuth issuance and workload/mandate broker calls; interactive capability calls can default to the public Cloud origin |
| `CLOUD_APP_CREDENTIAL` | Per-application resource-bound workload credential for background broker callers; not used by OAuth |
| `PORT` | Service port; defaults to `3000` |
| `NODE_ENV` | Enables production or development behavior |
| `ADMIN_LOGIN_TOKEN` | Local emergency administrator login |

`APP_ID` selects the application for Cloud's build and development scripts. It
is not application runtime configuration.

Every application container must use the same `APP_SECRET`.
It remains the data/settings encryption input; it never signs or verifies a
session, invocation, or OAuth token.

Only Core receives `CLOUD_IDENTITY_KEY_ENCRYPTION_KEY`. Other applications
verify browser and invocation JWTs with public keys and must never receive this
secret. Generate it with `openssl rand -hex 32` and keep it independent from
`APP_SECRET`.

Set `CLOUD_IDENTITY_JWKS_ORIGIN` to Core's private service origin when the
deployment network provides one, for example `http://app-core:3000`. Tokens
still use the public `app.url` origin as `iss`; this variable changes only the
network path used to fetch the purpose-specific session and invocation public
keys. Without it, applications load those JWKS endpoints from the public issuer
origin.

Set `CLOUD_OAUTH_JWKS_ORIGIN` to the OAuth application's private service
origin, for example `http://app-oauth:3000`. Access-token verification then
loads `/.well-known/jwks.json` without public ingress while still requiring the
public `app.url` issuer. The endpoint publishes only Core's OAuth-purpose public
keys; legacy OAuth signing keys are no longer served. Applications cache that
public set locally for at most five minutes; the warm verification path uses no
signing-key database query.

Private HTTP origins assume a network that prevents traffic interception and
modification, such as a trusted single-host container bridge. Public keys are
not secret, but substituted JWKS keys can defeat authentication. Expose only
the gateway publicly. Across hosts or untrusted networks, use authenticated
HTTPS or an equivalently protected transport for both JWKS and broker traffic.
An internal DNS name alone does not provide that protection.

Core and OAuth currently require the same PostgreSQL database for identity
state and one-shot grant claims. Separate databases are not supported.

Set `CLOUD_CORE_INTERNAL_ORIGIN` to the private Core service origin when
applications use workload credentials or mandates. The gateway rejects paths
containing an `_internal` segment for HTTP and WebSocket requests; background
helpers fail closed when their private origin is missing. Interactive helpers
can still use the public capability route. The helper sends the caller
credential only to Core, where it is resolved once and exchanged for a
target-bound invocation. The target application never receives the source
cookie, OAuth token, or API key.

`CLOUD_APP_CREDENTIAL` is not shared. Provision a separate resource-bound
service-account credential for each background calling app with resource type
`cloud.app`, resource ID equal to the app ID, and scope `identity:invoke`.
OAuth uses its separate deployment broker secret, not a workload credential.
Revoking one workload credential stops only that app's new broker
requests. Never put a workload credential in a browser bundle or target-app
request.

For background callers running directly on the host, set `CLOUD_APP_CREDENTIAL` and
`CLOUD_CORE_INTERNAL_ORIGIN` in each calling app's environment. Point the origin
at Core's direct listener, not the gateway. Do not load a shared environment
file containing Core's KEKs into every application.

The repository's development and production Compose files accept
`CLOUD_MAIL_APP_CREDENTIAL` as an input. They pass it only to Mail as
`CLOUD_APP_CREDENTIAL` and supply the private service origins. The input name
is not a runtime variable read by Mail.

> Losing or changing `APP_SECRET` makes existing encrypted settings and
> credentials unreadable. Store and rotate it as a deployment secret.

`app.start()` refuses to boot without `APP_SECRET`.

Core refuses to initialize identity issuance if its KEK is missing, malformed,
or cannot decrypt and validate the active private/public key pairs. Existing
applications can continue verifying with public JWKS material and warm caches,
but Core fails closed for new issuance.

Deploy the purpose-specific session and invocation JWKS endpoints on Core
before upgrading their consumers. Every replica behind the configured JWKS
origin must serve both endpoints; a mixed pool with older Core replicas is not
ready. Stage or drain old replicas before routing upgraded consumers, including
Core itself, to that origin. Verify cold JWKS reads, not just warm-cache health.
For rollback, restore compatible consumers before removing these endpoints.
The combined identity JWKS endpoint has been removed; no fallback remains.

Browser sessions and internal invocations are JWT-only. Deploy Core and every
application together after draining old replicas; see the
[coordinated hard cut](/en/docs/reference/deprecations-and-migrations).
Old browser sessions are invalidated once. No session or invocation mode
switch remains. Core signs a nominal 30-second token for each target and exact
operation; invocation verification allows two additional seconds for clock skew.
Scheduled work uses mandates, never a stored browser session.

Synchronize every host's clock, for example with NTP, and monitor drift well
within the invocation verifier's two-second tolerance.

OAuth always uses Core issuance. Generate `CLOUD_OAUTH_BROKER_SECRET` once with
`openssl rand -hex 32` and inject the same value exclusively into Core and OAuth.
Do not reuse `APP_SECRET` or Core's KEK. This secret authenticates only OAuth's
closed broker endpoints; Core still checks the current grant, client and
principal before signing. No admin login or credential provisioning is needed.

Development Compose supplies a public, development-only default. Production
Compose requires an explicit value. Start Core before OAuth. OAuth checks the
secret and Core signer at startup, before migrations, and fails closed if either
is unavailable. Missing or malformed Core configuration disables the OAuth
broker but does not prevent running Core without OAuth.

To rotate the broker secret, pause OAuth traffic, replace the value on all Core
and OAuth replicas, recreate those containers, and verify OAuth readiness before
resuming traffic. There is no previous-secret overlap; mismatched replicas reject
issuance. Rotation alone does not invalidate existing JWTs or refresh grants.

There is no mode switch or local signing fallback. Drain all old OAuth replicas
before migration: it drops their signing keys and issuance-state table. Client
IDs, secrets and refresh grants are retained. Old OAuth JWTs are rejected by
the upgraded Cloud; external verifiers may still hold cached old public keys.

Before upgrading mandate writers, follow the coordinated schema cutover in
[Deprecations and migrations](/en/docs/reference/deprecations-and-migrations).

Mail incoming automations use mandates exclusively. Provision Mail's
`identity:invoke` app credential and keep Core's broker available. There is no
legacy-token mode or authority backfill. Mail is unreleased alpha: this schema
targets fresh installations, not conversion of old automation credentials.
Existing alpha test installations must be recreated separately if needed;
starting Mail does not reset their data.

Do not enable `ADMIN_LOGIN_TOKEN` in production.

## Use settings for application values

Declare settings with `defineApp({ settings })`.

The runtime reads them from the shared store, validates them, and decrypts
secrets. A write invalidates the shared cache so other containers see the new
value on their next read.

Use environment fallbacks only for first deployment or infrastructure-managed
values. The setting remains the canonical product configuration.

See [Settings](/en/docs/platform/settings) for declaration and request access.

## Set the public URL

Set `app.url` to the public base URL.

It is used for email links, OAuth redirects, WebAuthn, and other absolute URLs.
Use HTTPS outside localhost.

`APP_URL` can bootstrap this setting.

## Configure optional services

Applications may declare settings for services such as:

- FreeIPA;
- Filegate;
- mail providers;
- OAuth providers;
- AI providers;
- PDF rendering.

Read the page for that service before setting environment fallbacks.

## Validate a deployment

Check configuration in this order:

1. the container received the expected variables;
2. Postgres, Valkey and NATS names resolve on the private network;
3. every container shares `APP_SECRET`;
4. only Core has the current identity KEK;
5. only Core and OAuth share the OAuth broker secret, and background callers
   have only their own scoped workload credentials;
6. `app.url` matches the public origin;
7. required settings validate in the administration UI;
8. the application starts without fallback warnings.

Do not print secrets while diagnosing configuration.
