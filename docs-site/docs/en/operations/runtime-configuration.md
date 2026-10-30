---
title: Runtime configuration
navTitle: Runtime configuration
section: Operations
order: 1140
description: Configure application containers, platform connections, and environment-specific values.
tags: [configuration, environment, settings]
updated: 2026-10-23
---

# Runtime configuration

Use environment variables for infrastructure. Use Cloud settings for product
configuration.

For the services and optional integrations needed by each app, start with
[Deployment requirements](/en/docs/operations/deployment-requirements).

Cloud validates settings when it reads them. Values stored in Postgres are
encrypted with `APP_SECRET`.

## Replace the legacy Weather geo configuration

Upgrade Core and configure its secret `geo.api_key` and credit budgets before
using Weather city search. Remove the old geo container and deployment values.

| Removed | Replacement |
| --- | --- |
| `geoService` (including `geo`, `services.geo` and legacy server types) | `geoClient` from `@k2b/cloud/server`, or Core address capabilities, with current request credentials. |
| `weather.geo_url` | Core owns the Geoapify EU endpoint; configure `geo.api_key` in Core instead of a Weather geo URL. |
| `GEO_ALLOWED_TARGETS` | No replacement allowlist is needed: the Core geo service uses the fixed Geoapify EU endpoint. Remove the variable. |
| `weather.city.search` | Core `address.autocomplete` with `type: "city"` and `countryCode: "DE"`; pass the selected coordinates to Weather. |

Agents and the Weather UI use the same Core capability path. Interactive
credentials go only to Core, which applies the caller's geo budget; applications
do not forward invocation tokens or bypass dispatch with an in-process call.
The city HTTP endpoints require authentication. Coordinate forecasts remain
anonymous, and the public display uses weather-station names without paid
reverse geocoding.

Saved coordinates remain valid. Follow the
[Weather migration instructions](/en/docs/reference/deprecations-and-migrations#weather-city-search-uses-core-geo)
for schema order and server caller changes.

## Outbound request budgets

Assistant file downloads use a 20-second total budget; Mail remote images and
one-click unsubscribe use 10 seconds; Mail provider discovery uses 5 seconds;
Web Push delivery uses 15 seconds by default. Each budget includes DNS,
connection attempts, redirects, headers and body reads. A slow stream cannot
extend it. Leaving a Mail request cancels its outbound work. Discovery keeps
candidates already found when its budget expires; manual setup remains
available. Unused redirect and rejected response bodies are closed immediately.
These deadlines preserve the existing destination policies and require no new
environment variables. Applications using the shared HTTP transports supply
[their own deadline signal](/en/docs/data/secrets-and-persistent-state#call-a-public-https-address).

## Set infrastructure variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection used by Bun SQL |
| `REDIS_URL` | Valkey connection used by Bun Redis for caches and rate limits |
| `NATS_SERVERS` | Comma-separated NATS JetStream bootstrap URLs |
| `SYNC_NAMESPACE` | Deployment namespace shared by all application processes |
| `SYNC_REPLICAS` | JetStream replica count: 1, 3, or 5; default 3. Dev Compose sets 1. Keep consistent across processes; migrate existing resources before changing it. |
| `NATS_CREDS_FILE` | Optional mounted NATS credentials file |
| `NATS_TLS_CA_FILE` | Optional trusted CA file for NATS TLS |
| `NATS_IGNORE_CLUSTER_UPDATES` | Keep reachable seed addresses when advertised Docker hostnames are inaccessible |
| `NATS_ADMIN_SERVERS` | Deprecated; Gateway Ops imports URLs into `gateway.nats_admin_servers` at startup |
| `NATS_ADMIN_CREDS_FILE` | Deprecated; Gateway Ops imports .creds **contents** into the secret `gateway.nats_admin_access` |
| `NATS_ADMIN_NKEY_SEED_FILE` | Deprecated; imports user seed **contents** and selects `nkey`; mutually exclusive with `NATS_ADMIN_CREDS_FILE` |
| `NATS_ADMIN_TLS_CA_FILE` | Deprecated; Gateway Ops imports CA PEM **contents** into `gateway.nats_admin_tls_ca` |
| `APP_SECRET` | Encrypts settings and credentials |
| `CLOUD_IDENTITY_KEY_ENCRYPTION_KEY` | Core-only KEK for private platform signing keys; exactly 64 hexadecimal characters |
| `CLOUD_IDENTITY_NEXT_KEY` | Temporary next Core KEK, distributed before promotion |
| `CLOUD_IDENTITY_PREVIOUS_KEY` | Temporary previous Core KEK during a rolling rewrap |
| `CLOUD_OAUTH_BROKER_SECRET` | Shared only by Core and OAuth to authenticate OAuth issuance; exactly 64 hexadecimal characters; required when running OAuth |
| `CLOUD_IDENTITY_JWKS_ORIGIN` | Optional private transport origin for loading Core's public identity JWKS; does not change the public issuer |
| `CLOUD_OAUTH_JWKS_ORIGIN` | Optional private transport origin for loading OAuth's public JWKS; does not change the public issuer |
| `CLOUD_CORE_INTERNAL_ORIGIN` | Private Core origin required for OAuth issuance and workload/mandate broker calls; interactive capability calls can default to the public Cloud origin |
| `CLOUD_APP_CREDENTIAL` | Optional host-run app override for the automatically delivered workload credential; not used by OAuth |
| `NODE_ENV` | Set to `production` by built-in images; development tooling supplies its own mode |
| `ADMIN_LOGIN_TOKEN` | Core-only temporary first-access or recovery token; no production default |

Configure new installations through **Administration → Observability → NATS → Diagnostics access**.
The NATS diagnostics settings belong to Gateway Ops and apply to its next
diagnostics connection. Existing settings are never overwritten by environment
imports. Cluster diagnostics remain off when the server list is empty. See
[NATS diagnostics access](/en/docs/operations/nats-operations#give-gateway-ops-access-to-diagnostics)
for formats, failed imports, and removal of the deprecated inputs.

`APP_ID` selects the application for Cloud's build and development scripts. It
is not application runtime configuration. Runtime identity comes from the app declaration.
Built-in services listen on port 3000 and ignore `PORT`; application authors can
select an explicit port with `app.start({ port })` for standalone deployments.

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
keys. Applications cache that
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

Core automatically issues an app-bound `identity:invoke` workload credential to
every registered app instance, including third-party apps. No admin creation or
per-app Compose input is needed. Mail incoming automations use this credential.
The runtime obtains the raw token through non-retained NATS request/reply and
keeps it in process memory; Postgres stores its hash. Tokens expire after one
hour and rotate after 30 minutes, with the preceding token valid until its
expiry so in-flight calls can finish. Core retains at most two runtime token
rows per instance; retired rows are removed and lifecycle events remain in
the audit log. Admin revocation remains effective through the app's disabled
workload service account.

The runtime checks with Core every minute and retries failed refreshes after five
seconds. A transient refresh failure keeps a still-valid token available.
Dependent calls fail closed when no valid token remains; logs report that
state and report recovery once. Public HTTP readiness contains no credential
status or reason, so an issuance outage does not remove unrelated app routes.
Operators inspect credential metadata and the workload account state under
**Administration → App credentials**, and application logs for refresh failures.
Before starting lifecycle workers, the runtime registers its instance and
requests a credential with a five-second timeout. If none is available, startup
continues with dependent background calls unavailable. Routes are advertised
only after lifecycle startup and declared resources are ready.

Credentials named `Runtime <instance>` appear in **Administration → App credentials**
and `cld admin app-credentials list <app>`. Revoking either overlapping runtime
token disables the app's workload service account: calls and automatic issuance
stop for every instance, including after a restart or concurrent rotation.
In the same table, choose **Enable app workload access** to allow issuance again,
or run `cld admin app-credentials enable <app> --yes`. Restarting alone does not
restore access. The admin API also supports
`PATCH /api/admin/identity/workloads/<app>` with `{"status":"active"}` or
`{"status":"disabled"}`; `cld admin app-credentials disable <app> --yes` applies
the same lasting off switch. Re-enabling never restores a revoked token; live
instances obtain a replacement on refresh.

When Core rejects a cached workload token before dispatch, the shared capability
client refreshes it and retries the broker call once. If credential authorization
still fails, it returns retryable unavailability (HTTP 503). A target or subject
authorization failure keeps its original status and is not retried this way.

A graceful stop requests revocation after its workers drain. If delivery fails
or the process crashes, Core revokes an unregistered instance only after more
than one registry TTL (three minutes) without a credential refresh, checked on
the one-minute reconciliation interval. A brief registry reset therefore does
not revoke a recently refreshed token. Automatically removed instances can
recover when membership returns. Other replicas retain their own credentials.
When the last Core replica stops, its own token expires or is removed when
Core resumes; its shutdown log reports an unconfirmed release.

For host-run apps, `CLOUD_APP_CREDENTIAL` remains an explicit override and wins
over automatic delivery. Create a resource-bound credential with binding
`{ appId, resourceType: "cloud.app", resourceId: appId }` and scope
`identity:invoke` through the admin UI or CLI, and inject it only into its
owning app. Overrides retain operator-managed expiry and rotation. Set
`CLOUD_CORE_INTERNAL_ORIGIN` to Core's direct listener, not the gateway.
OAuth uses its separate deployment broker secret. Never put a workload
credential in a browser bundle or a target-app request, and never load Core's
KEKs into other apps.

### Shared infrastructure trust limit

Workload credentials separate apps by contract and protect against mistakes
and confused-deputy bugs. They do not isolate a compromised app while apps
share a Postgres user, NATS access, and `APP_SECRET`. Real separation requires
per-app database roles and NATS accounts. Any client in the same NATS account
can request workload tokens for this installation's registered instances.
Use one NATS account per installation. `SYNC_NAMESPACE` separates resource and
subject names; it does not restrict access. The workload delivery channel carries
only newly issued app-bound workload credentials, never Core identity signing
keys, key-encryption material, OAuth secrets, or person sessions.

> Keep `APP_SECRET` stable and back it up. Cloud has no built-in key rotation;
> changing it makes encrypted values unreadable. Settings then fall back to
> their environment value or default; Cloud keeps the stored rows unchanged. See
> [Keep the encryption key stable](/en/docs/data/secrets-and-persistent-state#keep-the-encryption-key-stable).

`app.start()` refuses to boot without `APP_SECRET`.

Core refuses to initialize identity issuance if its KEK is missing, malformed,
or cannot decrypt and validate the active private/public key pairs. Existing
applications can continue verifying with public JWKS material and warm caches,
but Core fails closed for new issuance.

Start Core before its consumers. Every replica behind the configured Core
origin must serve the session and invocation JWKS endpoints. Verify cold JWKS
reads as well as cached requests.

Browser sessions and internal invocations use signed JWTs. An invocation is
valid for one target and operation for 30 seconds, with two seconds of clock
tolerance. Scheduled work uses mandates, never a stored browser session.

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

Before upgrading mandate writers, follow the coordinated schema cutover in
[Deprecations and migrations](/en/docs/reference/deprecations-and-migrations).

Mail incoming automations use mandates and the runtime's automatic
`identity:invoke` credential. Keep Core's broker available. For upgrades that change
stored credentials, follow [Deprecations and migrations](/en/docs/reference/deprecations-and-migrations).

For first access, temporarily provide `ADMIN_LOGIN_TOKEN` only to Core and open
`/auth/login?method=admin`. Set up and verify normal administrator sign-in,
then remove the token and recreate Core. See the
[fresh installation sequence](/en/docs/operations/deployment-requirements#bring-up-a-fresh-installation).

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
- AI providers;
- PDF rendering.

`GOTENBERG_URL` can bootstrap the PDF rendering setting `gotenberg.url`; the
development stack sets it to its Gotenberg container. FreeIPA and Files use
administration settings only. Mailbox credentials belong
to user-created IMAP/SMTP connections, not global provider settings. Grids query
limits are configured in Grids administration and require restarting every Grids replica.

Liquid templates now stop during rendering when they exceed their time or
output budget. The shared defaults are 1,000 ms and 300,000 UTF-8 bytes;
application-specific output caps still apply. A template preview or send can
fail with `render_timeout`, `render_too_large`, or `render_memory_limit`.
Grids HTML cells share 2 seconds of template rendering per read or export;
Mail signature segments share 1 second per composed body.
Simplify an affected template or reduce its data. These budgets are application
API options, not deployment settings; see
[PDF and templates](/en/docs/platform/pdf-and-templates#render-a-liquid-template).

## Control CLI plugin access

Applications serve their `cld` command modules as plugins. Every plugin
request needs a signed-in session, an OAuth token, or an API key; signed-out
requests get neither the plugin list nor any plugin file.

The setting `cli.plugins.access` decides who else is excluded. It applies to
the list and to every download:

| Value | Who gets plugins |
| --- | --- |
| `full_users` (default) | Full accounts and service accounts. Guests get `403`. |
| `all_users` | Every signed-in account, guests included. |

Change it under **Administration › Settings › Command line**. The setting only
protects the plugin code; the server still authorizes every command a plugin
sends. Users install the plugins with `cld plugins install <name>` or accept the
offer after `cld login`; `cld` verifies every file against the served manifest. See [Application CLI modules](/en/docs/platform/cli-modules#serve-a-module-from-the-application).

## Offer the OpenAI-compatible API

In AI settings, enable `ai.openai_api_enabled` (**OpenAI-compatible API**) to
let people create models-only personal API keys and administrators create
models-only keys for standalone accounts and agents to use their granted Assistant
chat models from external clients. It is off by default. Every request checks
the switch, so turning it off stops new requests with existing keys too;
provider calls already running continue.

`ai.openai_api_max_concurrent_requests` defaults to **4** simultaneous requests
per account across all instances (integer, 1–64). Typical clients need one or two;
four leaves room for a second client without one script crowding out others.
Raise it when provider capacity supports more simultaneous requests.

Models without reference prices have **no usage limit** here, as in Assistant.
Chat budgets do not protect them; only the IP rate limit and per-account
concurrency limit apply. Review model prices before enabling this surface.
See the [client reference](/en/docs/ai/openai-compatible-api) for authentication,
supported fields and errors.

### Machine model clients

Administrators create machine keys in **Accounts → Service accounts** after
enabling the API. Grant each account access to its models in AI settings and
configure its chat allowance in Usage rules. Existing broad grants remain
intentional grants; creating a key adds no model access. See
[Connect a machine account](/en/docs/ai/openai-compatible-api#connect-a-machine-account).

`ai.openai_api_max_concurrent_requests` applies per account across keys and
instances. User and service-account identities have separate concurrency keys.
During a rolling upgrade, old and new instances use different slot keys for
personal clients; the configured concurrency limit is fully shared after all
Core instances run the new version. Older instances reject machine model keys.

The additive inference-ledger migration records a nullable credential ID.
Existing calls retain their accounting and need no backfill. Key revocation,
account disable, or removing a model grant blocks the next request. A call
already dispatched continues until completion or client cancellation.

## Validate a deployment

Check configuration in this order:

1. the container received the expected variables;
2. Postgres, Valkey and NATS names resolve on the private network;
3. application containers share `APP_SECRET`; the gateway does not receive it;
4. only Core has the current identity KEK;
5. only Core and OAuth share the OAuth broker secret, and background callers
   have only their own scoped workload credentials;
6. `app.url` matches the public origin;
7. required settings validate in the administration UI;
8. the application starts without fallback warnings.

Do not print secrets while diagnosing configuration.

## Mail inbox preferences and daily counts

Mail stores inbox views per person and mailbox, separately for phones and large screens. There is no administrator default. The next Mail start adds two nullable view columns to the existing personal mailbox preferences table; it creates no additional history or environment setting. Mailbox deletion removes the view, and access revocation removes it when no readable grant remains. Pins and hidden mailbox choices retain their existing behavior.

Mail's daily completion counts use Core's `app.timezone`, falling back to `Europe/Berlin`, as reminders do. They read the existing activity history for one mailbox and one local calendar day. Each visible conversation counts once; its latest completion that day determines whether it was completed by automation. Reopened conversations remain in that day's count.

## App-PWA address queries

Applications can opt into `coreQueries: ["address.autocomplete"]` when creating
their App-PWA. Upgrade Core first and use the `@k2b/cloud` runtime shipped with
that Core release before enabling this declaration. The adapter uses Core's
Geo ledger schema, cache protocol, admission scripts, and cost model; keep them
on the same runtime version. Existing devices need no re-pairing or table migration.

The platform adapter runs the shared Geo service in the owning application's
process. That process needs the installation's existing `APP_SECRET` for encrypted
settings, normal Cloud database access, Valkey, and outbound access to Geoapify's EU endpoint, as Core does. No new credentials,
mandates, environment variables, or gateway routes are required. The Geoapify key
stays inside Cloud's server processes and is never sent to the device.

The owner's daily and Cloud monthly Geo budgets apply. The existing
`security.rate_limit_per_second`, capped by the Geo plan's requests per second,
also bounds each device and visit; a Valkey outage refuses the query. Usage
appears in the Geo ledger and `app_pwa.core.query` audit entries, rather than
Core's capability execution log. See [App-PWA sessions](/en/docs/identity/app-pwa-sessions#offer-address-suggestions)
for the request and error contracts.
