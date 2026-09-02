---
title: Runtime configuration
navTitle: Runtime configuration
section: Operations
order: 1140
description: Configure application containers, platform connections, and environment-specific values.
tags: [configuration, environment, settings]
updated: 2026-09-03
---

# Runtime configuration

Use environment variables for infrastructure. Use Cloud settings for product
configuration.

Cloud validates settings when it reads them. Values stored in Postgres are
encrypted with `APP_SECRET`.

## Set infrastructure variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection used by Bun SQL |
| `REDIS_URL` | Valkey connection used by Bun Redis |
| `APP_SECRET` | Encrypts settings and credentials |
| `CLOUD_IDENTITY_KEY_ENCRYPTION_KEY` | Core-only KEK for private platform signing keys; exactly 64 hexadecimal characters |
| `CLOUD_IDENTITY_NEXT_KEY` | Temporary next Core KEK, distributed before promotion |
| `CLOUD_IDENTITY_PREVIOUS_KEY` | Temporary previous Core KEK during a rolling rewrap |
| `CLOUD_IDENTITY_JWKS_ORIGIN` | Optional private transport origin for loading Core's public identity JWKS; does not change the public issuer |
| `CLOUD_OAUTH_JWKS_ORIGIN` | Optional private transport origin for loading OAuth's compatible JWKS; does not change the public issuer |
| `CLOUD_CORE_INTERNAL_ORIGIN` | Private Core origin required for workload/mandate broker calls; interactive capability calls can default to the public Cloud origin |
| `CLOUD_SESSION_ISSUANCE_MODE` | Core session issuance gate: `legacy` or `jwt`; defaults to `legacy` |
| `CLOUD_INVOCATION_ISSUANCE_MODE` | Core internal-dispatch gate: `legacy` or `jwt`; defaults to `legacy` during rolling migration |
| `CLOUD_OAUTH_ISSUANCE_MODE` | OAuth signing gate: `legacy` or `core`; defaults to `legacy` during rolling migration |
| `CLOUD_APP_CREDENTIAL` | Per-application resource-bound workload credential; only apps that call a Core identity broker receive one |
| `CLOUD_MAIL_AUTOMATION_AUTHORITY_MODE` | Mail incoming-automation migration gate: `legacy` or `mandate`; defaults to `legacy` |
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
public `app.url` issuer. The endpoint contains both current Core authority keys
and compatible legacy OAuth keys during migration. Applications cache that
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
service-account credential for each calling app with resource type `cloud.app`,
resource ID equal to the app ID, and only its required identity scope. OAuth
uses `identity:oauth-issue`; a background capability caller uses
`identity:invoke`. Revoking one credential stops only that app's new broker
requests. Never put a workload credential in a browser bundle or target-app
request.

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
Current verifiers deliberately do not fall back to the combined identity JWKS.

Keep `CLOUD_SESSION_ISSUANCE_MODE=legacy` while deploying the dual-read verifier
to every application. Change only Core to `jwt` after the complete application
fleet is compatible. This gate prevents a new Core instance from issuing a JWT
to an older application instance during a rolling rollout.

Use the same order for internal invocation credentials: deploy the dual-read
provider routes first, then change only Core to
`CLOUD_INVOCATION_ISSUANCE_MODE=jwt`. Core then signs a separate nominal
30-second JWT for each target and exact operation; the invocation-only verifier
allows two additional seconds for clock skew. Keep the legacy mode only for the rolling
upgrade; it is not a second long-term authorization model.

Scheduled chat-task occurrences remain queued while this invocation gate is
`legacy`. Delivery resumes after it changes to `jwt`; Core does not substitute
a user's session for background mandate authority.

Synchronize every host's clock, for example with NTP, and monitor drift well
within the invocation verifier's two-second tolerance.

For OAuth, deploy Core-key verification and the closed Core issuance endpoint
before setting `CLOUD_OAUTH_ISSUANCE_MODE=core` on the OAuth app. OAuth first
checks its app-bound workload credential and Core's active OAuth signer through
the closed readiness endpoint. It changes the database-authoritative mode and
scrubs legacy private keys only after that check succeeds. Failure leaves the
legacy state intact; after a successful cutover, updated replicas cannot resume
legacy issuance from a local setting. Keep the legacy OAuth public keys
available for their two-hour verification grace.
Replace every old OAuth binary with a cutover-aware version before changing
the mode: binaries predating the database issuance gate do not honor it.

Before upgrading mandate writers, follow the coordinated schema cutover in
[Deprecations and migrations](/en/docs/reference/deprecations-and-migrations).

For Mail incoming automations, deploy the mandate schema and Core broker first.
Then provision Mail's `identity:invoke` app credential and set
`CLOUD_MAIL_AUTOMATION_AUTHORITY_MODE=mandate`. Existing automation rows with
an encrypted legacy integration credential keep their previous behavior until
Mail migrates them in bounded batches; newly created or interactively updated
Spaces automations use a mandate immediately. Each batch atomically links the
mandate and retires the previous credential. Check that the remaining count is
zero and keep a verification window before removing the legacy read path.

Enable invocation JWT issuance before enabling Mail's mandate mode. Successful
Mail migration removes the old encrypted credential; switching the Mail flag
back to `legacy` does not restore it. Keep compatible Mail and Core versions
available for already-migrated automations.

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
2. Postgres and Valkey names resolve on the private network;
3. every container shares `APP_SECRET`;
4. only Core has the current identity KEK;
5. each broker-calling app has only its own scoped workload credential;
6. `app.url` matches the public origin;
7. required settings validate in the administration UI;
8. the application starts without fallback warnings.

Do not print secrets while diagnosing configuration.
