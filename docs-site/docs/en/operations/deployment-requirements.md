---
title: Deployment requirements
navTitle: Deployment requirements
section: Operations
order: 1125
description: Choose Cloud applications and identify their infrastructure, secrets, feature dependencies, startup order, and verification checks.
tags: [deployment, dependencies, infrastructure, configuration, bootstrap]
updated: 2026-09-07
---

# Deployment requirements

Use this reference before deploying a fresh Cloud installation or adding an
application. Choose the apps **and the features** you intend to use: a ready
container does not prove that its mail, AI, storage, or PDF integration works.

This page covers the gateway and all 22 built-in applications in the current
development Compose configuration. Production Compose includes the gateway and
21 applications; **Pulse is not included**. A standalone application can have
additional requirements declared by its author. Check the documentation and
configuration shipped with the exact release you deploy.

In the supplied Compose files, an app ID such as `mail` maps to service
`app-mail`; the routing service is named `gateway`. The shared library, UI
package, CLI and desktop development tools are not additional server apps in
this service set.

## Prepare the common infrastructure

| Requirement | Used for | Operator responsibility |
| --- | --- | --- |
| Bun application images | One independently running service per app | Build or pull the matching immutable release images; see [Build and deploy](/en/docs/operations/build-and-deploy). |
| Postgres | Identity, encrypted settings, app records, files, audit and workflow state | Supply `DATABASE_URL`, persistent storage, backups, and permissions for the release's migrations. Built-in apps share the database; Core and OAuth require this explicitly. |
| NATS JetStream 2.14.3+ | Registry, coordination, durable jobs, schedules and live events | Supply `NATS_SERVERS` and one `SYNC_NAMESPACE` shared by the deployment. Use persistent storage on three nodes and `max_payload: 16MB` for notebook updates. Production uses mounted credentials and TLS through `NATS_CREDS_FILE` and `NATS_TLS_CA_FILE`. |
| Valkey / Redis-compatible service | Rate limits, caches and short-lived authentication flows | Supply `REDIS_URL`. JWT browser sessions do not use Redis session storage. |
| Private service network | Gateway-to-app traffic, public-key retrieval and Core broker calls | Make each advertised app address reachable. Do not publish individual app, database or coordination ports. Protect cross-host traffic with authenticated TLS or an equivalent protected transport. |
| Public gateway and HTTPS origin | Browser/API entry, callbacks, secure cookies and WebSockets | Configure DNS, ingress/TLS and `app.url` (`APP_URL` can bootstrap it). Preserve streaming and WebSocket upgrades. Only the gateway receives public application traffic. |
| Clock synchronization | JWT expiry and short-lived invocations | Synchronize all hosts; invocation clock-skew tolerance is two seconds. |

The repository's `compose.yml` is **local development infrastructure**, not a
production storage or exposure policy. Its host-published ports, passwords,
floating helper-image tags and named volumes are development defaults.
`compose.prod.yml` supplies application services, not Postgres, Valkey,
Filegate, Gotenberg, or Geo. Operators must supply the selected dependencies and
connect them to the application network. The provided production ingress assumes
an existing Traefik network and TLS configuration.

Back up Postgres together with the independent encryption secrets. Also back up
Filegate's home/group storage when used. Application attachments in Mail,
Notebooks, Grids and Spaces use Postgres; deploying those apps does not itself
require Filegate or S3. Notebook S3 snapshots are an optional export, not a
replacement for a Cloud database backup. See
[Secrets and persistent state](/en/docs/data/secrets-and-persistent-state).

There is no universal CPU, memory, disk or database-connection sizing guarantee.
Size for your app set, data volume, replicas and workload, and verify headroom
with representative traffic before production exposure.

## Assign configuration to the correct service

Inject secrets at runtime, never into image build arguments, browser bundles,
or Git. Cloud settings, including provider credentials, are configured through
administration; do not invent environment names for settings without a declared
environment fallback.

| Configuration | Recipient | When required |
| --- | --- | --- |
| `DATABASE_URL`, `REDIS_URL`, `APP_SECRET` | Built-in application services | Common application baseline. Every app must use the same stable `APP_SECRET` for encrypted settings and credentials. The gateway uses the registry; Compose also gives it the shared environment. |
| `CLOUD_IDENTITY_KEY_ENCRYPTION_KEY` | **Core only** | Core identity issuance; generate an independent 32-byte key as 64 hex characters. `CLOUD_IDENTITY_NEXT_KEY` / `CLOUD_IDENTITY_PREVIOUS_KEY` are temporary rotation inputs, also Core-only. |
| `CLOUD_OAUTH_BROKER_SECRET` | **Core and OAuth only** | Running OAuth. Generate an independent 32-byte secret as 64 hex characters. No admin credential provisioning is needed. Dev Compose provides a development-only default; production requires an explicit value. |
| `CLOUD_CORE_INTERNAL_ORIGIN` | OAuth and background broker callers | Direct private Core origin, not the gateway. Compose supplies it. |
| `CLOUD_APP_CREDENTIAL` | Each background caller separately | Mandate-backed cross-app work, such as Mail incoming automations; scope `identity:invoke`. Compose passes `CLOUD_MAIL_APP_CREDENTIAL` only to Mail under this runtime name. OAuth does not use it. |
| `CLOUD_IDENTITY_JWKS_ORIGIN`, `CLOUD_OAUTH_JWKS_ORIGIN` | JWT-verifying applications | Optional private transport origins for Core and OAuth public keys. If omitted, verification retrieves keys through the public issuer origin. Neither value grants signing authority. |
| `PORT`, `NODE_ENV`, `APP_URL` | Service runtime | Service port, runtime mode and initial public URL. Images normally listen on port 3000; advertised addresses and network configuration must agree. |

See [Runtime configuration](/en/docs/operations/runtime-configuration) for the
complete identity configuration, validation behavior and broker-secret rotation.
See [Identity key operations](/en/docs/operations/identity-key-operations) for
signing-key rotation, KEK recovery and revocation. Keep these secrets independent;
`APP_SECRET` is not a signing key or an OAuth broker credential.

## Select applications and feature dependencies

**Baseline** below means Postgres, Valkey, NATS JetStream, `APP_SECRET`, completed Core schema
setup, and a reachable Core for authentication/authority operations. It is a
deployment prerequisite, not a claim that every app synchronously probes Core
at startup. A feature dependency is required when using that feature, not
necessarily to start its container.

Run the checks with an appropriately authorized test account and disposable
records. They are acceptance steps, not instructions to send production email
or mutate real data without approval.

### Platform and operations

| Service / app ID | Startup requirements | Feature dependencies and configuration | Functional check |
| --- | --- | --- | --- |
| Gateway (`gateway`) | Valkey, NATS JetStream and private reachability to advertised app addresses | Upstream apps provide the routes; ingress must preserve WebSockets and streaming. Optional `GATEWAY_INSTANCE_ID` identifies a replica. No independent signing secret. | Read `/health`, inspect registered routes, then request an actual app route through the public origin. |
| [Core](/en/apps/core) (`core`) | Postgres, Valkey, NATS JetStream, `APP_SECRET`, Core identity KEK; runs shared schema setup and starts identity maintenance | Runs AI workers and shared notifications. Optional SMTP, FreeIPA, AI providers, web push, Gotenberg and weather services are described below. `app.home_path` defaults to `/app/dashboard`: deploy Dashboard or choose an installed home route. | Sign in using the intended account provider; load the profile; verify session and invocation public-key endpoints. |
| [Gateway operations](/en/apps/gateway-ops) (`gateway-ops`) | Baseline; runs its operations lifecycle | Gateway snapshots and registered apps supply health/telemetry; outgoing health webhooks need reachable configured destinations. Optional metrics scraping uses `/metrics`. Settings include `gateway.health_check_schedule` and telemetry retention. | Open `/admin/gateway/apps` and `/admin/observability`; verify current app state and an observed request. |
| [Accounts](/en/apps/accounts) (`accounts`) | Baseline | Local accounts do not require FreeIPA. IPA users/groups require configured FreeIPA access; account emails require shared SMTP. | Read a local account and group; if IPA is enabled, verify directory connectivity and the intended group scope. |
| [OAuth](/en/apps/oauth) (`oauth`) | Baseline; same database as Core; direct Core origin and matching broker secret. Readiness probes Core before OAuth migrations. | Register external clients with exact callbacks and access rules. OAuth needs no workload credential and never receives Core's KEK. | Fetch discovery, then complete a test authorization-code/PKCE flow and refresh a token. Discovery alone is insufficient. |
| [Proxy Auth](/en/apps/proxy-auth) (`proxy-auth`) | Baseline | Configure a proxy-auth client and the external reverse proxy's forward-auth/callback integration. This is not an OAuth-client requirement. | Check denied and permitted access to one test upstream through that reverse proxy. |
| [API Docs](/en/apps/api-docs) (`api-docs`) | Baseline | Registered applications must publish reachable OpenAPI endpoints to appear as usable sources. | Open `/app/api-docs`, select an installed app, and load its specification. |
| [Capabilities](/en/apps/capabilities) (`capabilities`) | Baseline | Core's dispatcher and the selected provider apps. The Capabilities app is a UI, not a prerequisite for other apps to call capabilities. | Open `/app/capabilities` and execute a permitted read-only query against an installed provider. |
| [Dashboard](/en/apps/dashboard) (`dashboard`) | Baseline | Selected widget-provider apps and Core's widget proxy; no fixed requirement to install every provider. | Open `/app/dashboard`; verify a selected provider's widget and its unavailable state when that provider is absent. |
| [Pulse](/en/apps/pulse) (`pulse`) | Baseline; **Dev Compose only** in the supplied service set | Ingestion requires configured sources, source-bound credentials and producers. Its dashboards are separate from gateway observability. Production needs an explicitly deployed Pulse service/image. | Ingest a disposable signal through its source credential and query it from the intended base. |

### Work applications

| App ID | Startup requirements | Feature dependencies and configuration | Functional check |
| --- | --- | --- | --- |
| [Contacts](/en/apps/contacts) (`contacts`) | Baseline | No additional external service for contact books and records. Cross-app use requires whichever consumer/provider is selected. | Create and read a disposable contact in a test book; verify another account's access boundary. |
| [FAQ](/en/apps/faq) (`faq`) | Baseline | No additional external service for authored FAQ content. | Publish a test entry and verify its intended visibility on `/faq`. |
| [Files](/en/apps/files) (`files`) | Baseline; the process can start without a working Filegate | Actual file operations require Filegate, persistent allowed home/group roots and IPA identity/group data. Configure `files.filegate_url`, `files.filegate_token`, `files.base_homes`, `files.base_groups` and the directory/file modes. `FILEGATE_URL` / `FILEGATE_TOKEN` can bootstrap the connection settings. | As an IPA user, list an authorized base and upload/download a disposable file; verify forbidden bases stay inaccessible. |
| [Grids](/en/apps/grids) (`grids`) | Baseline | Files are stored in Postgres (`grids.max_file_size_mb` controls upload size). Document PDF rendering requires Gotenberg. Workflow email uses shared SMTP, not the Mail app. Other workflow integrations require their selected providers. | Create a test base/table/record; upload a small file. If documents are enabled, render a test PDF. |
| [Mail](/en/apps/mail) (`mail`) | Baseline; an unconnected mailbox is not proof of provider readiness | Mailbox synchronization and delivery require configured IMAP/SMTP endpoints, TLS, credentials and network-policy approval. Google/Microsoft connection OAuth uses Mail's provider settings, not the Cloud OAuth app. Incoming automations need Mail's workload credential and mandates; AI steps need AI configuration, Spaces actions need Spaces. | Verify a test mailbox connection and synchronization; send only to an approved test recipient. Exercise one permitted automation if enabled. |
| [Notebooks](/en/apps/notebooks) (`notebooks`) | Baseline | Live collaboration requires WebSockets. Notes and attachments use Postgres. PDF export requires Gotenberg. S3 snapshots need per-notebook endpoint, region, bucket and credentials; they are optional. `notebooks.reindex_cron` and `notebooks.snapshot_cron` schedule maintenance. | Edit a test note from two sessions; reload it and download an attachment. If snapshots are enabled, run and inspect one snapshot. |
| [Spaces](/en/apps/spaces) (`spaces`) | Baseline | Live updates require WebSockets. Attachments use Postgres. Mail-backed invitations require Mail and an authorized sender/mailbox. Calendar weather uses the shared weather service; the Weather app UI is not required for that in-process feature. | Create a disposable item/event, verify live updates and reload; test invitations only if configured. |
| [Venues](/en/apps/venue) (`venue`) | Baseline | No additional external service for venue records, hours, shifts and feedback. | Create a test venue and verify its public status page and intended staff-only access. |

### Directory and utility applications

| App ID | Startup requirements | Feature dependencies and configuration | Functional check |
| --- | --- | --- | --- |
| [Hosts](/en/apps/ipa-hosts) (`ipa-hosts`) | Baseline; starts the host-sync scheduler | Useful host data and mutations require FreeIPA and host/hostgroup privileges. With FreeIPA disabled, synchronization skips; enabling incomplete configuration causes sync failure. | Run a controlled sync and inspect mirrored hosts and its completion status. |
| [Assistant](/en/apps/assistant) (`assistant`) | Baseline; can serve its UI with AI disabled | Core owns AI execution. Configure AI profiles and access, then optional Firecrawl/PDF tools. Cross-app tools require their provider apps and current user permissions; the Assistant container does not need the OAuth broker secret. | Send a short test prompt, observe streamed output and durable history; test one permitted read-only tool. |
| [Tools](/en/apps/tools) (`tools`) | Baseline | Browser utilities need no extra backend. Markdown-to-PDF needs Gotenberg. Document extraction uses the native dependency bundled in the app image, not a separate Gotenberg conversion service. Speed tests need sufficient proxy/body/streaming limits; webhook delivery needs approved egress. | Open `/tools`; check a browser utility and, if enabled, convert a small document or Markdown PDF. |
| [Quotes](/en/apps/quotes) (`quotes`) | Baseline | Fresh quotes require outbound HTTPS to `zenquotes.io`; no provider-key setting. This app has API/widget routes, not an `/app/quotes` page. | Read `/api/quotes` or its Dashboard widget and verify quote data. |
| [Weather](/en/apps/weather) (`weather`) | Baseline; Core owns the weather schema migration | Forecasts need outbound HTTPS to `api.brightsky.dev`. City search additionally needs `weather.geo_url`; optional `weather.default_lat` / `weather.default_lon` select a default location. | Search a German city and load its forecast; verify forecast and city-search dependencies separately. |

## Configure optional services before testing their features

These are shared service settings, not additional mandatory containers for
every app. A feature executes in its owning service: for example, AI provider
egress is needed from Core, while Mail needs access to its mailbox providers.

| Feature | Configuration and dependency | What to verify |
| --- | --- | --- |
| Platform email | `mail.noreply.smtp_host`, `mail.noreply.smtp_port`, `mail.noreply.from`, `mail.noreply.user`, `mail.noreply.password`; reachable SMTP server | Use the saved-settings email test. Magic links, password-reset emails and email notifications need this independently of installing Mail. |
| FreeIPA | `freeipa.enable`, connection, service credentials, trusted CA and group rules. Bootstrap inputs: `FREEIPA_URL`, `FREEIPA_SVC_USER`, `FREEIPA_SVC_PASSWORD`, `GROUPS_ADMIN`, `GROUPS_BASE_SYNC`, `GROUPS_BASE_IPA_REALM`, `GROUPS_EXCLUDED`. | Follow [FreeIPA setup](/en/docs/operations/freeipa), test TLS/login, and preview sync scope before directory changes. |
| AI | `ai.enabled`, `ai.model_profiles_json`, selected model IDs, profile credentials/endpoint and applicable model access grants | Follow [Models and providers](/en/docs/ai/models-and-providers). An installed Assistant is not an enabled or authorized model. Private models need reachable inference endpoints; hosted models need provider credentials. |
| AI web tools | `ai.firecrawl_api_key` and provider egress | Test the selected web tool; this is not required for basic chat. |
| HTML/Markdown PDF | `gotenberg.url`, optional `gotenberg.username` / `gotenberg.password`, and configured limits/timeouts | Follow [PDF and templates](/en/docs/platform/pdf-and-templates). In Dev the service origin is `http://gotenberg:3000`; starting its container does not populate the Cloud setting. |
| Browser push | `notifications.web_push_public_key`, `notifications.web_push_private_key`, browser subscription/permission and outbound push-service access | Test delivery to an opted-in browser. In-app notification storage does not depend on browser push. |
| Mail provider OAuth | `mail.oauth.google_client_id` / `mail.oauth.google_client_secret`, or `mail.oauth.microsoft_client_id` / `mail.oauth.microsoft_client_secret`, provider registration and callback | Configure Mail administration and the provider's matching callback at the public origin plus /api/mail/oauth/callback. The corresponding `MAIL_OAUTH_GOOGLE_*` / `MAIL_OAUTH_MICROSOFT_*` variables are optional bootstrap/fallback inputs read by Mail. |
| City search | `weather.geo_url` pointing to the supported Geo API | Dev supplies a Geo container (`http://geo:4000` internally), but the setting must still be configured. Forecast access is a separate dependency. |

For S3 snapshots, enter credentials in the individual notebook's snapshot
configuration, not invented global S3 environment keys. For Filegate, its
server-side `FILE_PROXY_TOKEN` must match Cloud's Files token, and its
`ALLOWED_BASE_PATHS` and mounted storage must cover the configured roots.

## Bring up a fresh installation

1. Select apps and optional features from the tables. Choose an administrator
   access path before public exposure. Do not assume that a fresh production
   database automatically contains an administrator: use the intended FreeIPA
   administrator mapping or an explicitly approved local-account bootstrap.
   The repository supplies a local Dev emergency login, not an automated
   production administrator-provisioning workflow. Do not carry `dev-admin` or
   an enabled `ADMIN_LOGIN_TOKEN` into production.
2. Generate and store the independent deployment secrets. Set the public
   origin, private service addresses, database, Valkey and NATS connections. Give
   Core and OAuth the same broker secret if OAuth is selected; only Core gets
   the identity KEK.
3. Start and check persistent infrastructure. Start Core and wait for schema
   setup, identity initialization and readiness before starting dependent
   apps. Start the gateway with private app reachability and keep public
   access restricted during setup.
4. Start the selected apps. OAuth checks Core at startup and requires **no
   credential-creation request**. For mandate-backed background integrations,
   provision the owning app's `identity:invoke` credential using
   [Background mandates](/en/docs/identity/background-mandates), inject it only
   into that app, and recreate that app's container to apply environment changes.
5. Configure optional providers and app settings through administration.
   Use the service's internal address, not `localhost` from another container.
   Environment bootstrap values do not replace already saved settings.
6. Verify the selected rows' functional checks before exposing normal traffic.
   Confirm health, authorization, durable writes, and any required background
   operation separately.

## Verify readiness and upgrades

Check `/_cloud/ready` on each service's **private** origin, then check gateway
registration and request an owned route through the public origin. The gateway's
own readiness response is not aggregate readiness for all applications.
Inspect `/admin/gateway/apps` and `/admin/observability` when Gateway operations
is installed. Missing optional providers may leave the process ready while
individual features remain unavailable.

For existing installations, review
[Deprecations and migrations](/en/docs/reference/deprecations-and-migrations)
before changing replicas. Use the coordinated identity cutover where required;
do not infer rolling-upgrade safety from a healthy old container. Mail's current
unreleased-alpha schema targets fresh installations, not automatic migration of
old alpha automation credentials.

Use [Build and deploy](/en/docs/operations/build-and-deploy) for immutable image
sets and preflight, [Scaling and shutdown](/en/docs/operations/scaling-and-shutdown)
for lifecycle behavior, and [Troubleshooting](/en/docs/operations/troubleshooting)
for failed routes or dependencies. Plan rollback against both schema and key
compatibility; replacing an image does not restore migrated data.

## Upgrade from Sync v5

The Redis-backed Sync v5 runtime cannot read or write Sync v6 state. Finish or
explicitly reconcile accepted work before switching all applications together.
Notebook updates must be fully snapshotted into Postgres before the cursor
schema changes. Follow the repository's Sync v6 migration runbook; backing up
Redis alone does not prove that a notebook snapshot includes its last update.

Use the Sync view in Gateway Ops to inspect each application's resources,
schedules and dead letters. Requeue and manual schedule runs are administrator
actions routed through Core with target-bound invocation credentials.
