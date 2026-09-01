---
title: Runtime configuration
navTitle: Runtime configuration
section: Operations
order: 1140
description: Configure application containers, platform connections, and environment-specific values.
tags: [configuration, environment, settings]
updated: 2026-09-01
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
| `CLOUD_SESSION_ISSUANCE_MODE` | Core session issuance gate: `legacy` or `jwt`; defaults to `legacy` |
| `PORT` | Service port; defaults to `3000` |
| `NODE_ENV` | Enables production or development behavior |
| `ADMIN_LOGIN_TOKEN` | Local emergency administrator login |

`APP_ID` selects the application for Cloud's build and development scripts. It
is not application runtime configuration.

Every application container must use the same `APP_SECRET`.

Only Core receives `CLOUD_IDENTITY_KEY_ENCRYPTION_KEY`. Other applications
verify browser and invocation JWTs with public keys and must never receive this
secret. Generate it with `openssl rand -hex 32` and keep it independent from
`APP_SECRET`.

> Losing or changing `APP_SECRET` makes existing encrypted settings and
> credentials unreadable. Store and rotate it as a deployment secret.

`app.start()` refuses to boot without `APP_SECRET`.

Core refuses to initialize identity issuance if its KEK is missing, malformed,
or cannot decrypt and validate the active private/public key pairs. Existing
applications can continue verifying with public JWKS material and warm caches,
but Core fails closed for new issuance.

Keep `CLOUD_SESSION_ISSUANCE_MODE=legacy` while deploying the dual-read verifier
to every application. Change only Core to `jwt` after the complete application
fleet is compatible. This gate prevents a new Core instance from issuing a JWT
to an older application instance during a rolling rollout.

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
5. `app.url` matches the public origin;
6. required settings validate in the administration UI;
7. the application starts without fallback warnings.

Do not print secrets while diagnosing configuration.
