---
title: Runtime configuration
navTitle: Runtime configuration
section: Operations
order: 1140
description: Configure application containers, platform connections, and environment-specific values.
tags: [configuration, environment, settings]
updated: 2026-11-11
---

# Runtime configuration

Use environment variables for infrastructure. Use Cloud settings for product
configuration.

For the services and optional integrations needed by each app, start with
[Deployment requirements](/en/docs/operations/deployment-requirements).

Cloud validates settings when it reads them. Values stored in Postgres are
encrypted with `APP_SECRET`.

## Anonymous internal Geo autocomplete

Deploy Core and the gateway behind the private application network. Core's
listener must not be exposed directly; the gateway blocks the reserved
`/api/_internal/geo/v1/autocomplete` route on every public host. Set
`CLOUD_CORE_INTERNAL_ORIGIN` to Core's private origin for Core and its calling
apps. Core checks the configured internal host without trusting forwarding headers.
This Host check is not authentication: private network placement and the
gateway path block enforce the boundary. TLS termination may change the scheme
but must preserve the internal host.

After upgrading Core, app servers can use `geoClient.autocomplete(input)`
without a session or enrolled app key. Other capability operations retain
their authentication requirements. All Geo callers share the monthly budget
and provider-plan rate. Review `geo.monthly_budget_credits` and `geo.plan`
(`geo.custom_rps` for Custom) before rollout; the former
`geo.person_daily_credits` setting no longer limits anyone. Stored values are
ignored, so no data migration or secret rotation is required. Daily usage
continues to appear in administration. Anonymous executions have no actor or
access subject. Budget exhaustion returns 429 `GEO_BUDGET_EXHAUSTED` with
`Retry-After` until the next calendar month in `app.timezone`.

## Upgrade settings and short-lived links

Update every application, including independently deployed third-party apps,
to a build using the fixed `@k2b/cloud` package before completing this upgrade.
Older application processes can still write plaintext settings into Valkey.
Stop those processes before starting updated applications: the first startup
for the new cache format removes existing `settings:*` entries and records a
shared completion marker. Later starts skip that scan. Cleanup must succeed
before continuing; losing the marker safely repeats it.
Updated processes bind all cached settings to the full secret ring in encrypted envelopes. Do not
leave older application images running or available for automatic restart.
Every application makes a settings startup attempt, then retries temporary Valkey
failures using the remainder of its five-minute NATS and settings recovery
allowance. If Valkey still fails after that allowance, startup stops. The gateway
keeps HTTP closed while retrying temporary database or Valkey failures within
its existing five-minute settings startup budget.

Pending email sign-in links, administrator-issued account sign-in links,
password-reset links and proxy return links issued before the upgrade become
invalid. Request a fresh link after the rollout. Existing browser sessions and
stored settings are unchanged. Rolling back restores the old cache and link
behavior; links issued by this release do not work on the older release.

If untrusted parties could access Valkey, rotate the secret settings whose
values were stored there. The cleanup removes live cache entries; it does not
remove plaintext from existing Valkey persistence files, replicas that have
not applied the deletions, or backups. Handle those copies under the
installation's incident-response and backup policy before considering the
upgrade complete.

## Registered App-PWA staff push

Applications may opt in to staff pushes to registered devices with
`registeredDevices: { push: "staff" }`. The default pairing and takeover
behavior stays unchanged. See [App-PWA sessions](/en/docs/identity/app-pwa-sessions#send-a-visit-without-a-qr)
for authorization, request shapes, and the rule for existing uses.

Application `setup()` adds the `visit_only` boolean column to its reserved
`_cloud_pwa_devices` table, defaulting existing rows to `false`. Run the normal
application startup migration before serving the new protocol. The existing
application database backup contract covers the column; no new infrastructure,
configuration variable, or polling write is needed.

Before enabling the option, update all replicas of that application to this
package version. Older processes do not enforce visit-only access. To roll back,
stop the application and revoke its visit-only carriers before starting older
code; otherwise those rows could resume ordinary device access. Keep the
column in place and leave the persistent browser registrations intact.

## Platform connection startup

The platform now initializes its native SQL and Valkey clients before loading
application code. Deployments with explicit database and Valkey URLs keep their
connection targets. Core and Gateway continue to
read infrastructure values from their environment. The new clients use a
startup snapshot; existing Postgres application names are preserved.

Connection values and mounted NATS credentials and CA contents are captured at
startup; restart the process after changing them. Database and Valkey URLs
need explicit values, with `VALKEY_URL` accepted as the alias for `REDIS_URL`.
This also applies to development-preload processes that previously only loaded
configuration. Set both URLs before running the preload. Postgres URL aliases
(`DATABASEURL`, `TLS_DATABASE_URL`, `POSTGRES_URL`, `PGURL`, `PG_URL`, and
`TLS_POSTGRES_DATABASE_URL`) remain accepted. Implicit localhost and `PG*`-only
configuration now need an explicit URL. See
[Platform start and connections](/en/docs/build/platform-start) for the author API.

## SQL pool size

Set `CLOUD_DATABASE_POOL_MAX` in each application process or container before
startup to limit its global Cloud SQL pool. The default remains 10; accepted
values are integers from 1 to 2147483647 (Bun's signed 32-bit pool range).
Choose a small value within the database's connection budget, counting every
replica, worker, smoke-test process and separately owned pool. This is a
per-process ceiling, not an installation-wide limit or a number of connections
opened immediately. Connections open on use; work beyond the pool limit waits
for a connection to become available. Restart the process to apply a change.
The setting also applies when Core delivers the database URL through app-key
bootstrap; it remains local process configuration.

When upgrading, move client options out of `DATABASE_URL` query parameters.
Cloud now rejects keys such as `max` and `connect_timeout` before connecting,
instead of letting Bun forward them to Postgres. For a global pool, set
`CLOUD_DATABASE_POOL_MAX`; for separate pools, pass native `createSql` options.
TLS and server startup parameters remain supported. The URL is not rewritten,
and installations without client query parameters retain their current default.
No database migration is required. If rolling back, retain a connection budget
for the previous 10-connection global pool: older builds ignore the new variable.

The variable does not configure application-owned `createSql()` pools or Bun's
own global `sql` client. A process using both Bun and Cloud globals can still
open two independent pools. Replace Bun-global imports with the Cloud handle,
or configure any intentionally separate native pool independently. See
[Platform start and connections](/en/docs/build/platform-start) for the API and
[Configuration reference](/en/docs/operations/configuration) for the registry.

## Bootstrap application connections from Core

Every serving application except Core and Gateway must authenticate at startup with `CLOUD_APP_KEY` or
`CLOUD_APP_KEY_FILE` and the direct Core listener origin in
`CLOUD_CORE_INTERNAL_ORIGIN`. The origin must use HTTP or HTTPS, with no path,
query, fragment or embedded credentials. The public gateway blocks this
internal route.

In this release, follow [Upgrade applications to app keys](/en/docs/operations/app-key-upgrade)
before removing app infrastructure values. Use the Compose template from that
release; Core and Gateway retain their infrastructure environment. A
third-party app with old Bun-global clients needs an explicit environment
exception until its author migrates it.

A present key must have the `cloud-app-key-v1` format and match the app ID
embedded by the build or selected by the development preload. Invalid,
revoked, unknown, wrong-app or wrong-installation credentials stop startup;
Cloud never silently falls back to environment mode. HTTP 403 with
`connections_not_permitted` means the key is not allowed to receive
infrastructure connections; startup stops without retry. Key management has
no API or UI for changing that internal permission yet. Core and Gateway use
infrastructure environment values and refuse an app key.

Each explicitly supplied connection value wins independently, including a
supported alias, mounted secret, or explicit `false`. Core supplies the rest;
environment defaults do not override Core values. This per-value rule also
supports third-party applications that still import `sql` or `redis` globals
from `bun`: keep their explicit `DATABASE_URL` and `REDIS_URL` (and any other
needed infrastructure values) until the application author migrates to Cloud
clients. The app key remains mandatory for their HTTP server. Bootstrap values
stay in memory and are never written to `process.env`, so Bun globals cannot
read connections delivered only by Core.

The generated server entry, `startPlatform()` and development preload fail
immediately without a key, naming `CLOUD_APP_KEY_FILE` and the operator guide.
`APP_DIR` selects paths and does not exempt a standalone HTTP application.
Desktop's separate single-process SQLite runtime does not use this server startup.

One-off scripts, test preloads, migrations and data commands may still call
`initializePlatform({ appId, source: "env" })` from `@k2b/cloud/start` without a
key. This initializes explicitly configured connections for a process that does
not serve HTTP or make signed calls. Core and Gateway also use environment
initialization. Forced environment mode refuses an app key. If a keyless
process calls `sendAppRequest`, it fails before transport with one error naming
`CLOUD_APP_KEY_FILE`; a caller-supplied Authorization header cannot replace it.

Until Core answers, the app opens no HTTP listener and is not ready. Network,
TLS/CA, HTTP 429 and HTTP 503 failures retry for at most five minutes, with a
ten-second deadline per attempt and bounded `Retry-After` waits. Other HTTP or
protocol errors stop startup immediately. Failed attempts log only app ID,
attempt and error class. After exhaustion the process exits; the operator's
restart policy decides when to try again.

## Read secrets from mounted files

Set `NAME_FILE` to a file path in the owning process or container, for example
`APP_SECRET_FILE=/run/secrets/app-secret`. Mount the file so that the process can
read it, and unset `NAME` and its aliases: providing both sources with non-empty
values stops startup. Empty or whitespace-only environment values are unset.
Cloud removes exactly one trailing LF or CRLF from the file and preserves all
other whitespace. An empty result follows the same
unset/default rule as an empty environment value. A missing or unreadable file
stops startup with the variable name and path, without printing its contents.
Inject the variable into the container itself; the repository's Compose input
files do not automatically forward `*_FILE` variables. Keep the secret exactly
the same when moving it to a file: extra spaces or a second newline change its
value. Cloud reads the file once per entry and path; replace the file and restart
the process to apply a changed secret.

File alternatives are supported for:

- `APP_SECRET`, `APP_SECRET_NEXT`, `APP_SECRET_PREVIOUS` and `ADMIN_LOGIN_TOKEN`;
- `CLOUD_IDENTITY_KEY_ENCRYPTION_KEY`, `CLOUD_IDENTITY_NEXT_KEY` and
  `CLOUD_IDENTITY_PREVIOUS_KEY`;
- `CLOUD_APP_KEY`;
- Cloud Login's `CLOUD_LOGIN_VAPID_PRIVATE_KEY`.

### Declare an application secret

Application registries use the same mechanism through `@k2b/cloud/config`:

```ts
import { defineEnv, envSource, envString } from "@k2b/cloud/config";

const appEnv = defineEnv({
  PROVIDER_TOKEN: {
    schema: envString,
    scope: "secret",
    secretFile: true,
    doc: "Provider credential for this application.",
  },
});

const token = appEnv.PROVIDER_TOKEN;
const source = envSource(appEnv, "PROVIDER_TOKEN");
```

`secretFile: true` enables the canonical `PROVIDER_TOKEN_FILE` variable and
validates a configured file when the registry is created. Values remain lazy
on subsequent access, with file contents cached per entry and path.
`envSource(registry, name)` returns `"env"`, `"alias"`,
`"file"`, `"default"` or `"unset"` for the effective raw value, without evaluating
a default factory. Empty environment values and empty file results return
`"default"` when a default exists, otherwise `"unset"`. Explicit `false` and `0`
values retain their source. Source detection resolves configured files with
the same cache and throws for unreadable files or conflicting sources; it does not validate the value's
schema. Read the registry property to obtain the validated value.

## Enroll application public keys

Core now accepts locally generated Ed25519 public keys through administrator
APIs and `cld admin apps keys`. The installation ID lives in Core’s database.
Enrollment alone does not change application startup. Supplying a key enables
the startup protocol above; keep existing infrastructure environment values
only for third-party apps that have not migrated their imports. Built-in apps use the platform handles. See [App keys](/en/docs/operations/app-keys) for creation,
resumable CLI output, rotation, and revocation.

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
| `APP_SECRET` | Current root for encrypted settings, credentials and purpose signatures |
| `APP_SECRET_NEXT` | Optional next root, 64 hex characters; distribute before cutover |
| `APP_SECRET_PREVIOUS` | Optional previous root for reads and automatic rewrap; mutually exclusive with NEXT |
| `CLOUD_IDENTITY_KEY_ENCRYPTION_KEY` | Core-only KEK for private platform signing keys; exactly 64 hexadecimal characters |
| `CLOUD_IDENTITY_NEXT_KEY` | Temporary next Core KEK, distributed before promotion |
| `CLOUD_IDENTITY_PREVIOUS_KEY` | Temporary previous Core KEK during a rolling rewrap |
| `CLOUD_CORE_INTERNAL_ORIGIN` | Private Core origin required for OAuth issuance and workload/mandate broker calls; interactive capability calls can default to the public Cloud origin |
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

Core, the gateway and application containers use the same installation
`APP_SECRET` and shared infrastructure credentials. The gateway receives
`DATABASE_URL` for logging and storage configuration, `APP_SECRET` to decrypt
that configuration, `REDIS_URL` for public-storage request budgets, and NATS
access for discovery and telemetry. It serves `/public/storage` itself.

Treat a gateway compromise as an installation compromise, just as for Core:
its shared database role and encryption secret allow access beyond the
settings its normal delivery path reads. Protect its environment and host as
installation-wide credentials. It does not receive Core's identity KEKs or
any application private key.

`APP_SECRET` remains the data/settings encryption input; it never signs or verifies a
session, invocation, or OAuth token.

Only Core receives `CLOUD_IDENTITY_KEY_ENCRYPTION_KEY`. Other applications
verify browser and invocation JWTs with public keys and must never receive this
secret. Generate it with `openssl rand -hex 32` and keep it independent from
`APP_SECRET`.

Set `CLOUD_CORE_INTERNAL_ORIGIN` to Core's private service origin, for example
`http://app-core:3000`. Session and invocation JWKS use that origin while
tokens retain the public `app.url` issuer. Without a private Core origin,
verification can use the public issuer origin.

OAuth verification uses Core's internal `/api/_internal/identity/v1/oauth/jwks`
endpoint through `CLOUD_CORE_INTERNAL_ORIGIN`. The public OAuth
`/.well-known/jwks.json` endpoint and public issuer stay unchanged. Applications
cache public keys locally for at most five minutes.

Private HTTP origins assume a network that prevents traffic interception and
modification, such as a trusted single-host container bridge. Public keys are
not secret, but substituted JWKS keys can defeat authentication. Expose only
the gateway publicly. Across hosts or untrusted networks, use authenticated
HTTPS or an equivalently protected transport for both JWKS and broker traffic.
An internal DNS name alone does not provide that protection.

Core and OAuth currently require the same PostgreSQL database for identity
state and one-shot grant claims. Separate databases are not supported.

Set `CLOUD_CORE_INTERNAL_ORIGIN` to the private Core service origin when
applications send signed requests or use mandates. The gateway rejects paths
containing an `_internal` segment for HTTP and WebSocket requests; background
helpers fail closed when their private origin is missing. Interactive helpers
can still use the public capability route. The helper sends the caller
credential only to Core, where it is resolved once and exchanged for a
target-bound invocation. The target application never receives the source
cookie, OAuth token, or API key.

### Signed background and OAuth requests

The platform signs the final method, target path
and exact body bytes immediately before every send to Core. Each transmission,
including an explicitly safe retry, has a fresh 30-second proof and nonce.
Core reads the active app key directly, so revocation or account disabling
rejects the next request on every replica. A configured invalid or rejected key
never falls back to a bearer credential.

All app keys carry `identity:invoke`. OAuth issuance also requires the
operator-owned `oauth_issue_allowed` credential grant, checked directly on
every request regardless of app ID. Every new issuer key, including rotations,
needs explicit `--grant oauth:issue` (or API `grants: ["oauth:issue"]`). Setup
and development tooling must pass it for the built-in OAuth app's first
enrollment. A migration introducing the grant starts every key without issuance
permission; repeated migrations preserve stored operator grants. Grants are
never inherited. Issuance serves clients and grants in
Cloud's OAuth registry; separate third-party identity-provider registries are
not supported.
See [App keys](/en/docs/operations/app-keys#background-and-oauth-authority) for
grant storage and administration. Mandates and OAuth grant checks stay unchanged.
`connections_allowed=false` prevents startup connection delivery but still
permits signed requests from a runner that does not need those connections.

Transport replay protection and domain idempotency are separate. Keep the same
domain idempotency key when safely retrying an effect, and generate a new proof.
A lost response from a non-idempotent Action still requires reconciliation.
Mail supplies its mandate and run context to the platform; Chat's app-only
resource checks need no workload-credential env value.

### Shared infrastructure trust limit

App keys identify applications within one installation. Apps still share the
Postgres role, NATS access and `APP_SECRET`; they are trusted like programs
running as one Unix user. Use a separate installation when that trust is not
appropriate. `SYNC_NAMESPACE` separates resource names, not access. Core alone
holds identity signing keys and their encryption material.

Administrators can disable the app's account through
`PATCH /api/admin/identity/apps/<app>` with `{"status":"disabled"}` and restore
it with `{"status":"active"}`. **Administration → Apps → Keys** offers
**Turn on again** for a disabled account. Restoring an account never restores a
revoked key.

> Keep encryption roots with the backups that need them. Rotate with
> [APP_SECRET rotation](/en/docs/operations/app-secret-rotation): distribute NEXT,
> roll, switch to current/PREVIOUS, roll, wait for strict status and token expiry,
> then remove PREVIOUS and roll again. Core and Gateway read the environment ring;
> other apps inherit the complete ring from Core. A locally pinned current uses
> only its local NEXT/PREVIOUS; local rotation values without current fail startup.

`app.start()` refuses to boot without `APP_SECRET`.

Use a randomly generated 64-hex-character `APP_SECRET` (32 random bytes). If an
installation still uses a legacy passphrase or another human-chosen value, follow
[APP_SECRET rotation](/en/docs/operations/app-secret-rotation) to move it to this
random format. `APP_SECRET_NEXT` already requires that format.

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

OAuth always uses Core issuance and its enrolled app key. Readiness, token
batches and device approvals use signed requests. Each issuer key requires the
explicit `oauth:issue` grant. Start Core before OAuth; a missing key, refused
grant or unavailable Core signer fails OAuth startup. Core can run without OAuth.
Rotate by enrolling a second key with the grant, rolling every OAuth replica,
checking issuance and status, then revoking the old key.

Before upgrading mandate writers, follow the coordinated schema cutover in
[Deprecations and migrations](/en/docs/reference/deprecations-and-migrations).

Mail incoming automations use mandates and signed `identity:invoke` app requests. Keep Core's broker available. For upgrades that change
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
3. application containers and the gateway share the same `APP_SECRET`;
4. only Core has the current identity KEK;
5. every ordinary app has its own enrolled key; OAuth issuer keys have the
   explicit `oauth:issue` grant;
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

## Move network and AI values into settings

The following variables are deprecated bootstrap sources for administrator
settings. A stored row wins; an invalid environment value is ignored with a
warning. For trusted proxies, an invalid bootstrap value with no stored row
stops gateway startup. Run `cld admin settings status --env` after the upgrade, resolve any
reported problems, then remove the legacy environment entries. Follow the
[operator migration procedure](/en/docs/operations/deprecations-and-migrations).

| Environment variable | Administrator setting |
| --- | --- |
| `OUTGOING_MAIL_ALLOWED_TARGETS` | `outgoing_mail.allowed_targets` |
| `GATEWAY_TRUSTED_PROXIES` | `gateway.trusted_proxies` |
| `GATEWAY_OPS_WEBHOOK_ALLOWED_TARGETS` | `gateway.webhook_allowed_targets` |
| `ASSISTANT_RSQL_ALLOWED_TARGETS` | `assistant.rsql_allowed_targets` |
| `NOTEBOOKS_SNAPSHOT_ALLOWED_TARGETS` | `notebooks.snapshot_allowed_targets` |
| `WORKFLOW_AI_BUDGET` | `ai.workflow_budget` |
| `WORKFLOW_AI_ATTEMPT_TIMEOUT_MS` | `ai.workflow_attempt_timeout_ms` |
| `WORKFLOW_AI_QUEUE_TIMEOUT_MS` | `ai.workflow_queue_timeout_ms` |
| `MAIL_WORKFLOW_AI_BODY_MAX_CHARS` | `mail.workflow_ai_body_max_chars` |
| `GOTENBERG_URL` | `gotenberg.url` (bootstrap only) |

Remove `GATEWAY_INSTANCE_ID` to use a random per-process identity. An explicit
legacy value is still honored for this release and logs a startup warning.

## Live dictation

In **Administration → AI → Models**, add a `vllm-realtime` provider with its
HTTP(S) base URL including `/v1` and an optional API key. Add a model with
`kind: "live-transcription"` and assign its standard variant to `liveAudio`.
Only live transcription models can fill that slot. Grant the model to the
people who may dictate and enable AI. Emptying the slot turns live dictation
off without changing the existing audio recording path.

In **Administration → AI → General**, set these registered admin values;
there are no environment variables for them:

| Value | Setting key | Default | Valid range |
| --- | --- | --- | --- |
| `liveDictationConcurrency` | `ai.live_dictation_concurrency` | 4 | Integer, 1–1024 |
| `liveDictationMinutesPerDay` | `ai.live_dictation_minutes_per_day` | 60 | Integer, 1–1440 (24 hours) |

Concurrency is shared across Core replicas. Each session opens one model
connection and may queue at most 64,000 PCM bytes in Cloud. The concurrency
ceiling bounds these application PCM queues to about 64 MiB; model capacity
will usually require a much lower value. Run a short load test against the
actual model endpoint before increasing concurrency. Observe latency and
`overloaded`/`provider_failed` outcomes, including the two-second provider
backpressure boundary. No automatic reconnect hides overload.

Valkey holds a token-owned person lease (15 seconds, renewed every five
seconds), a shared semaphore, and per-person daily seconds. Local midnight
uses `app.timezone`, including daylight-saving changes. A lost lease aborts
the model; a late release cannot remove a newer lease. The daily dictation
allowance is independent of chat budgets. Usage reports show audio minutes
per person and app, without audio or transcript content.

Core serves `/api/ai/dictation/status` and `/api/ai/dictation/live` through its
registered `/api/ai` prefix; the gateway's registry-based WebSocket proxy
forwards the socket. See [Live dictation](/en/docs/ai/live-dictation) for the
protocol, cancellation contract, privacy, and recovery behavior. Verify real
microphones on Safari/iOS before enabling the feature broadly.

### Discover platform retention settings

Use `cld admin settings show logs.trace_retention_days --json` without `--app`
to inspect the platform setting's presence and readability. The platform catalog
also includes `logs.retention_days`; list, show and set use that same catalog.
Neither list nor show prints stored or default values. `--app core` restricts
the catalog to Core settings; other application IDs select their owning API.
