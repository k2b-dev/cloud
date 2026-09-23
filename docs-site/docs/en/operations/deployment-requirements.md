---
title: Deployment requirements
navTitle: Deployment requirements
section: Operations
order: 1125
description: Choose Cloud applications and identify their infrastructure, secrets, feature dependencies, startup order, and verification checks.
tags: [deployment, dependencies, infrastructure, configuration, bootstrap]
updated: 2026-09-23
---

# Deployment requirements

Use this reference before deploying a fresh Cloud installation or adding an
application. Choose the apps **and the features** you intend to use: a ready
container does not prove that its mail, AI, storage, or PDF integration works.

This page covers the gateway and all 23 built-in applications in the current
development Compose configuration. Production Compose includes the gateway and
23 applications, including **Pulse**. A standalone application can have
additional requirements declared by its author. Check the documentation and
configuration shipped with the exact release you deploy.

In the supplied Compose files, an app ID such as `mail` maps to service
`app-mail`; the routing service is named `gateway`. The shared library, UI
package, CLI and desktop development tools are not additional server apps in
this service set.

## Prepare the common infrastructure

| Requirement | Used for | Operator responsibility |
| --- | --- | --- |
| Bun application images | One independently running service per app | Pull the `vX.Y.Z` release images or pin the digests from the release's `release.json`; `sha-*` tags are main-branch builds for staging. Every image reports its `CLOUD_VERSION` through `/_cloud/ready` and the app registry; see [Build and deploy](/en/docs/operations/build-and-deploy#choose-an-image-tag). |
| PostgreSQL 15 to 17 (17 recommended) | Identity, encrypted settings, app records, files, audit and workflow state | Supply `DATABASE_URL`, persistent storage, backups, and permissions for the release's migrations. Built-in apps share the database; Core and OAuth require this explicitly. Transaction pooling (PgBouncer `pool_mode=transaction`) is supported: Cloud holds no session-level advisory locks; migrations coordinate through transaction-scoped locks and runtime work through NATS leases. The pull request gate tests on 17 and the nightly run on 15. |
| NATS JetStream 2.14.3+ | Registry, coordination, durable jobs, schedules and live events | Supply `NATS_SERVERS` and one `SYNC_NAMESPACE` shared by the deployment. Use persistent storage on three nodes (default `SYNC_REPLICAS=3`) and `max_payload: 16MB` for notebook updates. The JetStream account must fit every stream's configured byte limit times its replicas; see the [Notebook document log](/en/docs/operations/notebooks-document-log) for the Notebook share. Production can use mounted credentials and TLS through `NATS_CREDS_FILE` and `NATS_TLS_CA_FILE`; both are optional in `compose.prod.yml`. The supplied Compose wires one shared credentials path into every application service; per-application NATS credentials or a separate system credential need per-service overrides of that shared environment. |
| Valkey / Redis-compatible service | Rate limits, caches and short-lived authentication flows | Supply `REDIS_URL`. JWT browser sessions do not use Redis session storage. |
| Private service network | Gateway-to-app traffic, public-key retrieval and Core broker calls | Make each advertised app address reachable. Do not publish individual app, database or coordination ports. Protect cross-host traffic with authenticated TLS or an equivalent protected transport. |
| Public gateway and HTTPS origin | Browser/API entry, callbacks, secure cookies and WebSockets | Configure DNS, ingress/TLS and `app.url` (`APP_URL` can bootstrap it). Preserve streaming and WebSocket upgrades. Only the gateway receives public application traffic. |
| Clock synchronization | JWT expiry and short-lived invocations | Synchronize all hosts; invocation clock-skew tolerance is two seconds. |
| Browser for diagrams | Mermaid diagrams in Notebooks and rendered Markdown | Users on Safari need Safari 17.4 or later (iOS and iPadOS 17.4 or later). Mermaid 12 targets ES2024 and is not transpiled for older browsers. |

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

Releases up to 0.8.0 held session advisory locks, which a transaction pooler
leaves behind on its pooled backends and which then reject writes as
`operation_busy`. When upgrading such an installation, release them once by
running `SELECT pg_advisory_unlock_all()` on each affected backend, or restart
the pooler so that its server connections are recreated.

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
| `DATABASE_URL`, `REDIS_URL`, `APP_SECRET` | Built-in application services | Common application baseline. Every app must use the same stable `APP_SECRET` for encrypted settings and credentials. The gateway receives Postgres for logging and NATS for discovery; it does not receive Valkey, `APP_SECRET`, or identity credentials. |
| `CLOUD_IDENTITY_KEY_ENCRYPTION_KEY` | **Core only** | Core identity issuance; generate an independent 32-byte key as 64 hex characters. `CLOUD_IDENTITY_NEXT_KEY` / `CLOUD_IDENTITY_PREVIOUS_KEY` are temporary rotation inputs, also Core-only. |
| `CLOUD_OAUTH_BROKER_SECRET` | **Core and OAuth only** | Running OAuth. Generate an independent 32-byte secret as 64 hex characters. No admin credential provisioning is needed. Dev Compose provides a development-only default; production requires an explicit value. |
| `CLOUD_CORE_INTERNAL_ORIGIN` | OAuth, background broker callers, and managed Assistant code hosts | Direct private Core origin, not the gateway. Compose supplies it. Code hosts use it for turn-bound capability callbacks and binary streams. |
| `CLOUD_APP_CREDENTIAL` | Each background caller separately | Mandate-backed cross-app work, such as Mail incoming automations; scope `identity:invoke`. Compose passes `CLOUD_MAIL_APP_CREDENTIAL` only to Mail under this runtime name. OAuth does not use it. |
| `CLOUD_IDENTITY_JWKS_ORIGIN`, `CLOUD_OAUTH_JWKS_ORIGIN` | JWT-verifying applications | Optional private transport origins for Core and OAuth public keys. If omitted, verification retrieves keys through the public issuer origin. Neither value grants signing authority. |
| `APP_URL` | Application services | Initial public URL; saved `app.url` takes precedence. Built-in images run in production mode on port 3000. |
| `ADMIN_LOGIN_TOKEN` | **Core only** | Temporary first administrator access on a fresh installation; no production default. Remove after configuring and verifying normal administrator sign-in. |

See [Runtime configuration](/en/docs/operations/runtime-configuration) for the
complete identity configuration, validation behavior and broker-secret rotation.
See [Identity key operations](/en/docs/operations/identity-key-operations) for
signing-key rotation, KEK recovery and revocation. Keep these secrets independent;
`APP_SECRET` is not a signing key or an OAuth broker credential.

Managed Assistant code hosts validate `CLOUD_CORE_INTERNAL_ORIGIN` when a host
is created, before launching Chromium. It must be an HTTP(S) origin reachable
from the Assistant service. Each host also uses an authenticated ephemeral
loopback HTTP listener inside that service; allow local networking without
publishing these ports. Binary bodies preserve backpressure across this hop.
Eight simultaneous host requests per process are admitted; excess requests
receive `operation_busy`. Size memory for the existing 50 MiB per-file and
250 MiB per-run code budgets plus Chromium; streaming transport does not remove
the memory occupied by files loaded for analysis.

### Assistant Chromium isolation

Assistant runs headless Chromium in its own container as the unprivileged
`bun` user with `--no-sandbox`. Both Compose configurations set `user: bun`,
drop all Linux capabilities and enable `no-new-privileges`; the container keeps
the runtime-default seccomp profile. Chromium's inner sandbox stays off, so no
custom seccomp profile, unprivileged user namespaces or node preparation is
needed, and the service needs neither privileged mode, root, `SYS_ADMIN`, a
Docker socket nor nested containers. Existing custom Assistant deployments must
adopt these settings before using Code Mode. The equivalent Kubernetes
`securityContext` is `runAsNonRoot: true` with a non-root `runAsUser`,
`capabilities.drop: [ALL]`, `allowPrivilegeEscalation: false` and
`seccompProfile.type: RuntimeDefault`.

Each foreground chat host and scheduled turn has a separate browser process
and ephemeral host credential. This is process isolation within one
capability-free application container, not a separate VM per user; the
residual risk of an unsandboxed renderer inside that container is accepted and
tracked in [#47](https://github.com/k2b-dev/cloud/issues/47), which moves
Chromium into a dedicated sidecar. Keep one Assistant replica for now; lost
hosts are not replayed. Studio previews continue running in the user's browser.

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
| Gateway (`gateway`) | Postgres, NATS JetStream and private reachability to advertised app addresses | Upstream apps provide the routes; ingress must preserve WebSockets and streaming. Optional `GATEWAY_INSTANCE_ID` identifies a replica. No independent signing secret. | Read `/health`, inspect registered routes, then request an actual app route through the public origin. |
| [Core](/en/apps/core) (`core`) | Postgres, Valkey, NATS JetStream, `APP_SECRET`, Core identity KEK; runs shared schema setup and starts identity maintenance | Runs AI workers and shared notifications. Optional SMTP, FreeIPA, AI providers, web push, Gotenberg and weather services are described below. `app.home_path` defaults to `/app/dashboard`: deploy Dashboard or choose an installed home route. | Sign in using the intended account provider; load the profile; verify session and invocation public-key endpoints. |
| [Gateway operations](/en/apps/gateway-ops) (`gateway-ops`) | Baseline; runs its operations lifecycle | Gateway snapshots and registered apps supply health/telemetry; outgoing health webhooks need reachable configured destinations. Optional metrics scraping uses `/metrics`. Settings include `gateway.health_check_schedule` and telemetry retention. | Open `/admin/gateway/apps` and `/admin/observability`; verify current app state and an observed request. |
| [Accounts](/en/apps/accounts) (`accounts`) | Baseline | Local accounts do not require FreeIPA. IPA users/groups require configured FreeIPA access; account emails require shared SMTP. | Read a local account and group; if IPA is enabled, verify directory connectivity and the intended group scope. |
| [OAuth](/en/apps/oauth) (`oauth`) | Baseline; same database as Core; direct Core origin and matching broker secret. Readiness probes Core before OAuth migrations. | Register external clients with exact callbacks and access rules. OAuth needs no workload credential and never receives Core's KEK. | Fetch discovery, then complete a test authorization-code/PKCE flow and refresh a token. Discovery alone is insufficient. |
| [Proxy Auth](/en/apps/proxy-auth) (`proxy-auth`) | Baseline | Configure a proxy-auth client and the external reverse proxy's forward-auth/callback integration. This is not an OAuth-client requirement. | Check denied and permitted access to one test upstream through that reverse proxy. |
| [API Docs](/en/apps/api-docs) (`api-docs`) | Baseline | Registered applications must publish reachable OpenAPI endpoints to appear as usable sources. | Open `/app/api-docs`, select an installed app, and load its specification. |
| [Capabilities](/en/apps/capabilities) (`capabilities`) | Baseline | Core's dispatcher and the selected provider apps. The Capabilities app is a UI, not a prerequisite for other apps to call capabilities. | Open `/app/capabilities` and execute a permitted read-only query against an installed provider. |
| [Dashboard](/en/apps/dashboard) (`dashboard`) | Baseline | Selected widget-provider apps and Core's widget proxy; no fixed requirement to install every provider. | Open `/app/dashboard`; verify a selected provider's widget and its unavailable state when that provider is absent. |
| [Pulse](/en/apps/pulse) (`pulse`) | Baseline; included in development and production Compose | Ingestion requires configured sources, source-bound credentials and producers. Its dashboards are separate from gateway observability. The release workflow publishes the Pulse image. | Ingest a disposable signal through its source credential and query it from the intended base. |

### Work applications

| App ID | Startup requirements | Feature dependencies and configuration | Functional check |
| --- | --- | --- | --- |
| [Contacts](/en/apps/contacts) (`contacts`) | Baseline | No additional external service for contact books and records. Cross-app use requires whichever consumer/provider is selected. | Create and read a disposable contact in a test book; verify another account's access boundary. |
| [FAQ](/en/apps/faq) (`faq`) | Baseline | No additional external service for authored FAQ content. | Publish a test entry and verify its intended visibility on `/faq`. |
| [Files (legacy)](/en/apps/files) (`files`) | Baseline; the process can start without a working Filegate | Actual file operations require Filegate, persistent allowed home/group roots and IPA identity/group data. Configure `files.filegate_url`, `files.filegate_token`, `files.base_homes`, `files.base_groups` and the directory/file modes. Configure these in Files (legacy) administration; Cloud does not read Filegate bootstrap variables. | As an IPA user, list an authorized base and upload/download a disposable file; verify forbidden bases stay inaccessible. |
| [Files](/en/apps/filesv2) (`filesv2`) | Baseline; application-owned storage assignments | Filegate 6.1.0 with independent roots, backend token, a browser-reachable public origin outside Cloud cookie scope, and exact CORS origins. Cloud storage requires local Linux identities; FreeIPA requires valid POSIX identities and root `execution: true` with the explicitly configured Unix-execution daemon privileges. Set `managed: true` only for exclusive Filegate writers; keep it false with external writers. Optional: Collabora Online 26.04 or later with its own browser-reachable address and TLS; Collabora must reach Cloud's public address (or the configured WOPI origin) and Cloud must reach Collabora. Several Collabora instances need sticky routing on `WOPISrc`. | Inspect existing storage in `/admin/filesv2`, browse an authorized directory and download through a lease. Verify external filesystem additions and denied access. With Collabora configured, open one `odt` from two sessions, save, and inspect history according to the root cooldown. Verify conflicts on managed roots; unmanaged roots provide only best-effort conflict checks. Test the real mount and export before production acceptance. |
| [Grids](/en/apps/grids) (`grids`) | Baseline | Files are stored in Postgres (`grids.max_file_size_mb` controls upload size). Document PDF rendering requires Gotenberg. Workflow email uses shared SMTP, not the Mail app. Other workflow integrations require their selected providers. | Create a test base/table/record; upload a small file. If documents are enabled, render a test PDF. |
| [Mail](/en/apps/mail) (`mail`) | Baseline; an unconnected mailbox is not proof of provider readiness | Mailbox synchronization and delivery require configured IMAP/SMTP endpoints, TLS, credentials and network-policy approval. Users connect their own mailboxes through IMAP/SMTP; managed Google/Microsoft browser authorization is not available. Incoming automations need Mail's workload credential and mandates; AI steps need AI configuration, Spaces actions need Spaces. Recipient suggestions and participant contacts need the contact-directory app, Contacts by default (**Administration → Mail → Contact directory** or `cld mail admin contact-directory`). | Verify a test mailbox connection and synchronization; send only to an approved test recipient. Exercise one permitted automation if enabled. |
| [Notebooks](/en/apps/notebooks) (`notebooks`) | Baseline | Live collaboration requires WebSockets. Notes and attachments use Postgres. PDF export requires Gotenberg. S3 snapshots need per-notebook endpoint, region, bucket and credentials; they are optional. `notebooks.reindex_cron` and `notebooks.snapshot_cron` schedule maintenance. | Edit a test note from two sessions; reload it and download an attachment. If snapshots are enabled, run and inspect one snapshot. |
| [Spaces](/en/apps/spaces) (`spaces`) | Baseline | Live updates require WebSockets. Attachments use Postgres. Mail-backed invitations require Mail and an authorized sender/mailbox. Calendar weather uses the shared weather service; the Weather app UI is not required for that in-process feature. | Create a disposable item/event, verify live updates and reload; test invitations only if configured. |
| [Venues](/en/apps/venue) (`venue`) | Baseline | No additional external service for venue records, hours, shifts and feedback. | Create a test venue and verify its public status page and intended staff-only access. |

### Directory and utility applications

| App ID | Startup requirements | Feature dependencies and configuration | Functional check |
| --- | --- | --- | --- |
| [Hosts](/en/apps/ipa-hosts) (`ipa-hosts`) | Baseline; starts the host-sync scheduler | Useful host data and mutations require FreeIPA and host/hostgroup privileges. With FreeIPA disabled, synchronization skips; enabling incomplete configuration causes sync failure. | Run a controlled sync and inspect mirrored hosts and its completion status. |
| [Assistant](/en/apps/assistant) (`assistant`) | Baseline; can serve its UI with AI disabled | Core owns AI execution. Configure AI profiles and access, then optional Firecrawl/PDF tools. Studio PDF generation/embedding needs Gotenberg with Factur-X and request-directory isolation support (development uses 8.36.0); local Finance APIs and PDF text extraction need no Gotenberg. Resource databases additionally need `assistant.rsql_url` and the secret `assistant.rsql_api_token`, configured in Studio administration. Cross-app tools require their provider apps and current user permissions; the Assistant container does not need the OAuth broker secret. | Send a short test prompt, observe streamed output and durable history; test one permitted read-only tool. Run a database-free script. If databases are configured, explicitly connect a test resource and query it. |
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
| FreeIPA | `freeipa.enable`, connection, service credentials, trusted CA and group rules. Configure and explicitly enable the integration in Core administration; environment bootstrap is not supported. | Follow [FreeIPA setup](/en/docs/operations/freeipa), test TLS/login, and preview sync scope before directory changes. |
| AI | `ai.enabled`, `ai.model_profiles_json`, selected model IDs, profile credentials/endpoint and applicable model access grants | Follow [Models and providers](/en/docs/ai/models-and-providers). An installed Assistant is not an enabled or authorized model. Private models need reachable inference endpoints; hosted models need provider credentials. |
| AI web tools | `ai.firecrawl_api_key` and provider egress | Test the selected web tool; this is not required for basic chat. |
| HTML/Markdown PDF | `gotenberg.url`, optional `gotenberg.username` / `gotenberg.password`, and configured limits/timeouts | Follow [PDF and templates](/en/docs/platform/pdf-and-templates). In Dev the service origin is `http://gotenberg:3000`; starting its container does not populate the Cloud setting. |
| Browser push | `notifications.web_push_public_key`, `notifications.web_push_private_key`, browser subscription/permission and outbound push-service access | Test native notification delivery to an opted-in browser with Cloud visible and with no open Cloud tab. Notification history does not depend on browser push. |
| City search | `weather.geo_url` pointing to the supported Geo API | Dev supplies a Geo container (`http://geo:4000` internally), but the setting must still be configured. Forecast access is a separate dependency. |

For S3 snapshots, enter credentials in the individual notebook's snapshot
configuration, not invented global S3 environment keys. For Files (legacy) and its Filegate v2 daemon, the
server-side `FILE_PROXY_TOKEN` must match Cloud's Files (legacy) token, and its
`ALLOWED_BASE_PATHS` and mounted storage must cover the configured roots.
Files (`filesv2`) uses the separate Filegate v6 root and lease API; see
[Files](/en/apps/filesv2). The local development daemon is v6 and cannot serve
Files (legacy).

## Bring up a fresh installation

1. Select apps and optional features. Generate a private temporary
   `ADMIN_LOGIN_TOKEN` and supply it only to Core. Production has no default
   token and a fresh database has no normal administrator account.
2. Generate and store the independent deployment secrets. Set the public
   origin, private service addresses, database, Valkey and NATS connections. Give
   Core and OAuth the same broker secret if OAuth is selected; only Core gets
   the identity KEK.
3. Start and check persistent infrastructure. Start Core and wait for schema
   setup, identity initialization and readiness before starting dependent
   apps. Start the gateway with private app reachability and keep public
   access restricted during setup.
4. Start the selected apps. OAuth checks Core at startup and requires **no
   credential-creation request**. The development and production Compose files
   wait for Core's readiness healthcheck before starting OAuth.
   For mandate-backed background integrations,
   provision the owning app's `identity:invoke` credential using
   [Background mandates](/en/docs/identity/background-mandates), inject it only
   into that app, and recreate that app's container to apply environment changes.
5. Open `/auth/login?method=admin` at the public origin and enter the temporary
   admin token. Review and accept the displayed legal documents to finish
   first sign-in. Configure a normal administrator account or FreeIPA administrator
   group mapping, then verify that sign-in in a separate session. Remove
   `ADMIN_LOGIN_TOKEN` from Core and recreate Core before normal operation.
   Configure optional services through administration using their internal
   addresses, not `localhost` from another container. FreeIPA and Files do not
   import environment values.
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

## Coordinate an existing installation's identity upgrade

Use one maintenance window for the gateway, Core, OAuth, applications, and
background workers. Replacing images alone is insufficient when the old
installation lacks NATS or the identity secrets below. Record the actual image
digests and source revisions; an approximate installation date does not identify
which migrations apply. The identity checks do not replace the separate Sync,
Notebook, or application-schema upgrade checks.

### Prepare before stopping services

1. Pull a complete immutable release image set and retain the previous image
   digests and deployment configuration for recovery. Include independently
   deployed apps and workers in the inventory; old processes must not keep
   writing after the migration.
2. Preserve the existing `APP_SECRET`, database, and saved public `app.url`.
   If Core identity keys already exist, preserve their current KEK. If this is
   the installation's first Core identity release, provision an independent
   `CLOUD_IDENTITY_KEY_ENCRYPTION_KEY` for Core; Core creates its signing keys
   during startup. Do not replace a KEK protecting existing rows with a newly
   generated value.
3. When running OAuth, supply the same independent
   `CLOUD_OAUTH_BROKER_SECRET` to Core and OAuth. OAuth needs no app-credential
   provisioning. Supply private Core/OAuth origins as described in
   [Runtime configuration](/en/docs/operations/runtime-configuration), and check
   NATS, database, cache, private-network, and clock prerequisites above.
4. Quiesce user writes and new background work while old workers finish accepted
   work. Close Notebook editing connections and prove that their final updates
   reached durable snapshots before stopping the old snapshot workers. For an
   existing NATS installation, use the applicable
   [snapshot cutover check](/en/docs/operations/notebooks-snapshot-cutover).
   That NATS check does not inspect Redis-backed Sync v5 history; a v5 upgrade
   needs snapshot coverage established against the old release first.
5. Stop all old application processes after their drain checks pass. Take a
   consistent recovery backup of Postgres, the applicable broker state, file
   storage, and the independent deployment secrets. Verify the restore path
   before allowing new migrations to run. Keep ingress restricted.

### Start the new release and verify it

1. Check persistent infrastructure, then start updated Core alone. Wait for
   migrations, key initialization, and its private `/_cloud/ready` endpoint.
   Confirm that the private session and invocation JWKS endpoints respond.
2. Start updated OAuth and the other selected apps, then the gateway. OAuth
   checks Core's authority before its migrations. Check every service's private
   readiness and its registered public route; gateway health alone is not enough.
   The supplied Compose orders OAuth after Core, but does not impose that order
   on every other application.
3. Sign in again with the installation's normal account method. Check logout
   and re-login, an authorized app page, global search, a dashboard widget, and
   a Notebook edit that survives reconnect and reload. If OAuth is used, test an
   existing client's authorization and refresh flow through the real HTTPS
   ingress. Old browser sessions and old OAuth access/ID tokens are rejected;
   client registrations, client secrets, and refresh grants are retained.
4. Check startup logs and the
   [JSON metadata repairs](/en/docs/operations/repair-jsonb-containers). Those
   repairs run on startup; no blanket manual repair or database reset is needed.
   Apply each app's separate schema requirements before enabling it. Provision
   Mail's workload credential only if its background integrations are used;
   scheduled AI tasks without a mandate require owner recreation. Neither is
   an OAuth startup prerequisite.
5. For the supplied platform Compose, run the read-only
   [fleet check](/en/docs/operations/build-and-deploy#deploy-the-service) against
   the new release. Review each app's Sync resources and failures, then reopen
   normal traffic. Keep backups and retired broker resources through acceptance.

If a startup or functional check fails, keep traffic restricted and inspect the
owning service. Do not restart old binaries against the migrated database or
flush shared Valkey/NATS state. Restore the coordinated pre-upgrade data,
secrets, and old image set if rollback is necessary. See the
[identity cutover contract](/en/docs/reference/deprecations-and-migrations#jwt-only-sessions-and-internal-invocations)
for token compatibility and [Identity key operations](/en/docs/operations/identity-key-operations)
for key recovery.

## Upgrade from Sync v5

The Redis-backed Sync v5 runtime cannot read or write Sync v6 state. Finish or
explicitly reconcile accepted work before switching all applications together.
Notebook updates must be fully snapshotted into Postgres before the cursor
schema changes. Follow the repository's Sync v6 migration runbook; backing up
Redis alone does not prove that a notebook snapshot includes its last update.

Use the Sync view in Gateway Ops to inspect each application's resources,
schedules and dead letters. Requeue and manual schedule runs are administrator
actions routed through Core with target-bound invocation credentials.
Use the separate NATS view for infrastructure diagnostics. Configure its
system-account credentials only on Gateway Ops and set up independent outage
monitoring as described in [NATS operations](/en/docs/operations/nats-operations).

## Upgrade from Sync 6.2.0

Deploy Cloud's pinned Sync 6.4.0 version after stopping every old producer and
worker. Old workers can overwrite or delete repaired coalescing claims, so
these versions must not share a running fleet. Keep Postgres, Valkey, and NATS
data and take backups before starting the new release. If readiness reports a
`ResourceDriftError`, repair only the named resource as the migration runbook
describes: a drifted consumer is deleted alone and its stream keeps the
retained work; a drifted stream is deleted only where the runbook lists its
work as ephemeral or recoverable from Postgres.

First quiesce new work while old workers can finish. Complete the
[notebook snapshot checks](/en/docs/operations/notebooks-snapshot-cutover) and
the [FreeIPA backfill checks](/en/docs/operations/freeipa#backfill-account-expiry-dates).
Keep retired broker resources through verification. Grids resumes publication
from its retained Postgres outbox; historical workflow failures keep their
explicit replay path.

Grids requires a fresh schema when replacing an older Grids storage layout;
there is no in-place upgrade. See [Grids schema reset](/en/docs/reference/deprecations-and-migrations#grids-starts-with-a-fresh-schema).

If Sync reports a legacy pending claim without queued input, reconcile that
specific job against its application's durable state before clearing its
claim and resubmitting it. Do not clear claims in bulk or fabricate lost input.
After startup, verify each application's resources, schedules, and dead letters
through Core, plus normal domain reads and recovery.

Application authors remove calls to `syncOps.registerDeadLetters()` and
`syncOps.registerScheduler()`: Cloud discovers native handles automatically.
Custom administration clients must include `queue`, `job`, or `topic` in dead-letter
mutation paths, between `/dead-letters/` and the resource name.

## Optional Help search ranking

Help publication and native full-text search require the Core-managed Postgres
schema. Every supported PostgreSQL version (15 to 17) provides this baseline.
Apps renew their Help collection through the existing app heartbeat; Core owns
bounded cleanup of expired collections. See [In-product Help](/en/docs/platform/help).

BM25 ranking is optional. This integration was verified with `pg_textsearch`
1.4.0 on PostgreSQL 17. The extension supports PostgreSQL 17 and 18; check its
[installation instructions](https://github.com/timescale/pg_textsearch) against
your operator-managed database before enabling it.

1. Install the extension package matching the database major version and architecture.
2. Add `pg_textsearch` to `shared_preload_libraries` and restart Postgres during
   an approved maintenance window.
3. Enable it in the Cloud database with `CREATE EXTENSION pg_textsearch`.
4. Run Core setup again to create the optional Help indexes.

Cloud does not install this extension automatically. It checks extension and
index availability when searching, so existing processes can use the indexes
once they are ready. If the extension or an index is absent, native search
remains active. Ordinary database failures are still reported as errors.

Keep the existing database's storage and major version unchanged when testing
BM25 in a separate environment. Verify both search modes with real application
articles and the required language; a healthy Postgres container alone does
not prove that the optional indexes are usable.


### Files capability downloads

The Filegate public origin must be reachable from the requesting user's browser
or CLI. See [private file lists and downloads](/en/apps/filesv2#compose-private-file-lists-and-downloads)
for the capability flow, lease expiry, and access checks.
