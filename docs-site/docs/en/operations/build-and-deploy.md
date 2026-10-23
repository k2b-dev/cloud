---
title: Build and deploy
navTitle: Build and deploy
section: Operations
order: 1130
description: Build a standalone application image and connect it to a Cloud deployment.
tags: [build, docker, deployment]
updated: 2026-10-22
---

# Build and deploy

The Cloud build creates one self-contained Bun bundle for one application.

It emits the server, Solid island chunks, application CSS, static assets, and
optional application-specific build output.

## Updating sharing controls

Applications rebuilt with the current Cloud package include service accounts
and agents in their shared permission picker and access CLI by default. Deploy
the rebuilt applications to update these surfaces; existing grants do not
change. Update Core before the consuming applications to provide the directory
kind and status filters. The permission editor searches active accounts for new
grants and keeps existing grant rows visible. An application with a documented
user-backed workflow can keep `allowServiceAccounts={false}`. See
[resource authorization](/en/docs/identity/authorization).

### Update Project and Skill service callers

Rebuild Core, Assistant, and custom applications that call Project or Skill
services against the same Cloud package before deploying their images. Service
calls now pass `AiResourceContext` with both `actor` and `accessSubject`; HTTP
request shapes stay the same. This change requires no database migration.
See the [service migration](/en/docs/reference/deprecations-and-migrations#project-and-skill-service-authorization-context).

## Build a standalone application

```bash
NODE_ENV=production APP_ID=inventory \
APP_DIR=. \
bun run node_modules/@k2b/cloud/scripts/build.ts
```

The output is written to `dist/`:

```text
dist/
├── server.js
├── _ssr/
│   ├── manifest.json
│   └── <island>.js
├── assets/
├── cli/
│   └── inventory/
│       ├── cli.js
│       ├── manifest.json
│       └── references/
└── public/
    └── inventory/
        └── app.css
```

Run it with:

```bash
cd dist
bun server.js
```

The server bundle does not need root `node_modules` at runtime. Native workers
are shipped under `dist/canvas/` only when their caller survives bundling, with
their own `node_modules` dependency closure for the build OS, CPU, and libc.
Copy the whole directory into the runtime image and keep build and runtime
platforms aligned. Print image preparation adds sharp's libvips (about 18 MB);
the build runs the packaged image worker once to verify native loading. See
[Prepare images for print](/en/docs/platform/pdf-and-templates#prepare-images-for-print).

Cloud maintainers building an application from the monorepo use the same build
contract through the checked-out script:

```bash
NODE_ENV=production APP_ID=inventory bun run packages/cloud/scripts/build.ts
```

That repository path is not an application API. Standalone builds always use
the script shipped by their pinned package version.

## Add build output

Place browser assets in `public/`. The build copies them to
`dist/public/<app-id>/`.

Keep files the server reads at runtime, such as document templates or seed
data, in `src/assets/`. The build copies that directory to `dist/assets/`, and
`appAssetPath` from `@k2b/cloud/server` resolves a file inside it from the
source tree and from the bundle alike:

```ts
import { appAssetPath } from "@k2b/cloud/server";

const template = Bun.file(appAssetPath("templates", "empty.odt"));
```

Do not locate server-side files relative to `import.meta.url`: the bundle
flattens every module into `dist/server.js`, so such paths only work from the
source tree.

Import Bun built-ins statically, for example `import { sql } from "bun"`. The
minified server bundle breaks `await import("bun")`: it runs from source but
throws a `ReferenceError` in the built image.

The build bundles each module declared in `defineApp({ cli })` into one
self-contained `dist/cli/<name>/cli.js`, copies its skill references, and
writes a `manifest.json` with the SHA-512 of every file. It imports each
bundle once and fails when its module name differs from the declaration. See
[Application CLI modules](/en/docs/platform/cli-modules#serve-a-module-from-the-application).
Every built-in application serves its module this way, and Core serves
`account`, `admin`, `apps`, and `capabilities`; the `cld` binary contains no
application module. A `cld` release therefore works against a Cloud that
serves plugins, and users install them with `cld plugins install --all`.

Add `scripts/build-extras.ts` only when the application must generate another
artifact. The build sets `WORKSPACE_ROOT` and `DIST_DIR` before importing it.

The build precompresses supported static files with Brotli and gzip.

The application's `app.css` and `favicon.svg` URLs carry `?v=<content hash>`.
The shared stylesheets (`fonts.css`, `tabler-icons.css`, and `global.css`)
carry Core's registered release. URLs stay the same across restarts, and all
applications use the same shared stylesheet URLs. Core's `/branding/favicon`
keeps its unversioned URL.

In production, these files use `immutable` only when the requested version
matches the serving process's version. Other requests use `no-cache` with an
ETag: revalidation takes one round trip and sends no body if the file is
unchanged. Images built with the default `CLOUD_RELEASE=local` link the shared
stylesheets without a version, so browsers revalidate them on each page.
Set `CLOUD_RELEASE` to one immutable `sha-<commit>` value per build.

During the first upgrade to a Cloud version with this behavior, stop every
old instance of Core and of each application before a new instance receives
traffic. Use stop-then-start, such as the Compose default or the Kubernetes
`Recreate` strategy, because a rolling or surge update overlaps old and new
instances even with one replica. An old instance answers every `/public` file
`immutable`, also under a version that names the new build. A browser that
gets the old file this way keeps it until the file changes in a later release.
Later upgrades can roll, because new instances answer only their own versions
`immutable`.

Island URLs are `/inventory/_ssr/<content-hash>/<island>.js`. The hash covers
built island JavaScript, so it stays stable across restarts and releases that
do not change the application's island code, preserving browser caches. Build
from a fixed path, such as the Docker `WORKDIR`, because lazy chunk names
depend on it. Files remain flat in `dist/_ssr/`; the SSR adapter serves
compressed siblings. Copy the whole `_ssr` directory into the image, including
the build output `dist/_ssr/manifest.json`. The server fails with a clear
error when `_ssr` exists without the manifest. The production inline loader
preloads rendered islands' shared static imports after the page's stylesheets.
It creates modulepreload links at runtime so the HTML preload scanner does not
compete with first paint.
Rebuild affected application images when updating SSR so entry modules and lazy
chunks come from the same build.

## Build a standalone image

A standalone repository can keep the dependency, build, and runtime stages in
one Dockerfile:

```dockerfile
FROM oven/bun:1 AS dependencies
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

FROM dependencies AS build
COPY . .
RUN APP_ID=inventory APP_DIR=/app \
  bun run node_modules/@k2b/cloud/scripts/build.ts

FROM oven/bun:1-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist/ ./
EXPOSE 3000
CMD ["bun", "server.js"]
```

Build it on macOS or Linux with the same Linux runtime:

```bash
docker build -t inventory:local .
```

Cloud's monorepo Dockerfile additionally accepts an application ID, the Cloud
version, and a release label:

```bash
docker build \
  --build-arg APP_ID=inventory \
  --build-arg CLOUD_VERSION=0.8.0 \
  --build-arg CLOUD_RELEASE=sha-0123456789ab \
  -t cloud-app-inventory:local \
  .
```

| Build argument  | Default       | Set by release builds to      | Visible at runtime as                                   |
| --------------- | ------------- | ----------------------------- | ------------------------------------------------------- |
| `CLOUD_VERSION` | `0.0.0-local` | the release version (`X.Y.Z`) | `version` in `/_cloud/ready` and the app registration   |
| `CLOUD_RELEASE` | `local`       | the immutable `sha-<commit>`  | `release` in `/_cloud/ready` and the app registration   |

Both values are baked into the bundle and exported as `CLOUD_VERSION` and
`CLOUD_RELEASE` environment variables of the runtime image.

The final image contains only the bundle and Bun runtime. It listens on port
3000.

The monorepo Dockerfiles take the Bun base images and the Dockerfile frontend
from the public mirror `ghcr.io/k2b-dev/mirror`, pinned to the same digests as
on Docker Hub. A build from source needs no Docker Hub or GitHub login, but it
must be able to reach `ghcr.io`.

## Deploy the service

First select the required services, secrets and feature integrations in
[Deployment requirements](/en/docs/operations/deployment-requirements).
That reference includes every built-in app and the fresh-install startup order.

Run every application on the private Cloud network.

Give it:

- `DATABASE_URL`;
- `REDIS_URL`;
- `NATS_SERVERS` and the installation's `SYNC_NAMESPACE`;
- the deployment-wide `APP_SECRET`;
- the public `APP_URL` for initial setup.

Configure product integrations through saved application settings. FreeIPA,
Filegate and Mail provider environment bootstrap is not supported. The gateway
has a smaller environment; use its row in Deployment requirements.

Core additionally requires the Core-only
`CLOUD_IDENTITY_KEY_ENCRYPTION_KEY`. Do not add that variable to the shared
application environment. All other applications obtain public verification
keys from Core and keep no shared signing secret.

Apps calling Core's workload or mandate broker also need
`CLOUD_CORE_INTERNAL_ORIGIN` and their own `CLOUD_APP_CREDENTIAL` with scope
`identity:invoke`, including Mail incoming automations. OAuth instead needs
`CLOUD_CORE_INTERNAL_ORIGIN` and `CLOUD_OAUTH_BROKER_SECRET`; inject that same
broker secret only into Core and OAuth. It requires no admin provisioning. See
[Runtime configuration](/en/docs/operations/runtime-configuration) for
provisioning requirements, Compose input names, and optional private JWKS origins.

Inject secrets into the appropriate container at runtime. Do not bake them into
Dockerfile `ENV` instructions or pass them as build arguments.

Do not expose the application directly. The gateway discovers its registered
prefixes and proxies public traffic.

## Choose an image tag

Every Cloud release publishes one complete image set under
`ghcr.io/k2b-dev/cloud-<image>:vX.Y.Z`. The GitHub release for `cloud-vX.Y.Z`
carries `release.json`, which lists each image with its digest. Deploy by the
`vX.Y.Z` tag or, for a fully reproducible rollout, by the digests from that
file.

| Tag | Meaning | Use |
| --- | --- | --- |
| `vX.Y.Z` | One released Cloud version; the same tag on every image in the set | Production |
| `sha-<12 commit>` | A main-branch build after the pull request gate; not a release | Staging and pre-release verification |

`main` and `latest` tags do not exist. The former `cloud-<image>-v*` per-app
tags are gone; all images of one installation carry the same Cloud version.

The Cloud platform's production Compose requires one `CLOUD_IMAGE_TAG` for its
runtime image set. A separately released application uses its own immutable
image tag while remaining on the same private network.

The pull request gate runs Grids certification before any change reaches
`main`: the full Grids and shared workflow tests with PostgreSQL, NATS
JetStream, Valkey and real PDF rendering, plus an unfiltered Grids typecheck.
This gate does not replace the operator's backup restoration and process
recovery checks.

See [Release process](/en/docs/contributing/release-process) for how versions
and tags are produced.

## AI provider upgrade: nessi 0.15

Cloud now uses nessi 0.15. Before rolling out the updated runtime, review these
changes for configured AI models:

- Anthropic's default output budget increases from 1,024 to 8,192 tokens when no
  `maxOutputTokens` is configured. Quota reservations use the new default. Set an
  explicit profile limit if the installation needs a smaller output budget.
- Gemini output-token usage includes thinking tokens, which can increase
  recorded reference costs and consume cost allowances sooner.
- Truncated or interrupted provider streams end the chat loop as errors instead
  of being stored as complete answers.

Model profiles also accept a thinking level and extra provider parameters.
vLLM and OpenAI-compatible chat profiles can use encrypted, write-only HTTP
headers. Existing profiles preserve their provider defaults when the new fields
are unset. Extra parameters apply to helper calls too; review their scope before
using them to change thinking behavior. See
[Models and providers](/en/docs/ai/models-and-providers#set-the-thinking-level)
for validation limits, provider mappings and CLI commands.

## Assistant Skills after the upgrade

Apps now ship their own Assistant Skills; Core no longer contains built-in
Skill templates. The first Core start of this release links the installed
built-in Skills to their apps: `cloud-grids` to Grids, `cloud-mail` to Mail,
`cloud-notebooks` to Notebooks, `cloud-contacts` to Contacts, `cloud-spaces` to
Spaces, `cloud-weather` to Weather, and `cloud-assistant`, `scheduled-tasks`,
`skill-creator`, `assistant-code-mode`, and `assistant-data-analysis` to
Assistant. It keeps Skill IDs, access, personal **Enabled** settings, and
administrator changes, and does not recreate deleted ones. It creates no
duplicates and can run again safely.

The migration removes the old seed table, so this is a one-way step for Core.
Once a Core of this release has started, do not start a Core of an older
release against that database, also not by restarting an old replica during the
rollout: it would install the deleted built-in Skills again, open to everyone
signed in. To go back, restore the database backup taken before the upgrade.

Each app installs or updates its Skills when it starts with the new release. Until
then, its Skills are not offered to Assistant. An app that does not run offers
no Skills. Afterwards, open **Administration > AI Skills**:

- **App update available** marks a customized Skill whose app ships different
  content. Compare it and reset it to the app version if you want the update.
- **Name in use** marks an app Skill whose name an existing Skill already has,
  for example a built-in Skill installed before templates were linked. Select
  **Use existing Skill** to link it to the app and keep its content.
- **App Skills not installed** lists app Skills that were deleted.
  **Restore** installs them again.

App Skills are offered only to people who may open the app, by the same rule
as Help. Guests no longer see the Skills of apps that require a full account,
such as Grids, Mail, Contacts, Spaces, and Weather. See
[Ship Assistant Skills](/en/docs/platform/assistant-skills#who-can-use-an-app-skill).

## Enable panel providers

Core now declares Help as a panel provider. Every signed-in reader has the
slot on Layout pages unless the page sets `panel={false}`. Other applications
can declare their own providers through optional `panel` registry metadata.
During a mixed rollout, pages served by an application built against an older `@k2b/cloud` show no slot; they ignore the
new field.

Keep same-origin iframes allowed on provider routes. An operator's reverse
proxy or security headers must not set `X-Frame-Options: DENY` or a
`frame-ancestors` policy that blocks `'self'`. The provider remains responsible
for authorization: panel visibility grants no route or resource access.
Blocked framing prevents Help from becoming ready; the slot shows **The panel
did not load** with **Try again**.
See [Offer a panel](/en/docs/platform/panels).

Chat and Assistant now register their existing workspaces as panel providers.
Assistant's conversation recovery uses the current Core AI API. Core's normal
AI migration adds the owner-bound `ai.conversation_creations` request ledger and
a submitted-draft lookup index on `ai.messages`; no manual configuration is
required. Keep this ledger when backing up or restoring AI data: deleted
conversations retain their request tombstone so replay cannot create a replacement.
Update Core before enabling the new Assistant consumer.

Editable providers can register the synchronous `onPanelBeforeLeave` guard
from `@k2b/cloud/browser/panel`. Updated hosts keep a guarded provider mounted
when it reports unsaved work; the provider owns saving and recovery. Deploy
the host and editable provider against this contract together. Older hosts
do not consult the guard. It does not replace application persistence or
guarantee recovery after browser termination.

`defineApp()` now rejects a `panel.href` at or below the application's
`<basePath>/help` path, because the framework's Help redirects would shadow
it. An application with such a provider route must move it before it upgrades,
or it fails at startup.

### Panel context consent after the upgrade

The panel runtime now supplies place context through the first iframe URL and
subsequent same-origin messages. Providers served by Core need no consent;
every other provider receives context only after the person allows it. Older
application images do not report or receive this context. Rebuild applications
that use the new `Layout.context` or provider helpers against this runtime.

Core's normal migrations create `auth.panel_context_consent` before startup
completes; no manual migration or configuration step is needed. The
idempotent `panel-context-consent` migration adds one row per user and provider
app ID, holding `allowed`, `revision`, and `updated_at`. It preserves existing answers and
deletes a person's rows when their `auth.users` account is deleted. Include
this table in the existing Core database backup policy. The table stores
answers only, never resource refs or page context.

Keep provider `Referrer-Policy: same-origin` responses intact, and keep query
strings out of proxy logs and error reports. See the
[panel context contract](/en/docs/platform/panels#page-context).

## Roll out a release

Render and inspect the deployment before changing platform containers:

```bash
export CLOUD_IMAGE_TAG=v0.8.0
docker compose -f compose.prod.yml config
docker compose -f compose.prod.yml pull
```

Pull every image successfully before stopping or recreating services. For the
Sync v5 to v6 boundary (Redis to NATS JetStream), stop the complete old runtime
before starting the new release set.

The production Compose file is an application template, not a complete host
installation. Copy `.env.prod.example` to a protected `.env`, replace the example
values, and supply persistent infrastructure and the existing Traefik
network before using it. Keep rendered Compose output private because it
contains resolved secrets. Follow the fresh-install order in Deployment
requirements for Core initialization, administrator sign-in, and app setup.

`bun run release:preflight` checks an already running fleet against the selected
release; it cannot pass before a fresh installation starts or while an older
release is still running. It needs `CLOUD_IMAGE_TAG`, `SYNC_NAMESPACE`,
`CLOUD_CORE_URL` (reachable Core origin) and `CLOUD_ADMIN_TOKEN` (an authorized
administrator bearer credential). Supply these through the process environment;
do not confuse that API credential with Core's temporary `ADMIN_LOGIN_TOKEN`
used on the sign-in page. If you adapt Compose, adapt the preflight's Compose
target and expected service inventory too.

## Check the rollout

After deployment:

1. confirm that the process stays running;
2. confirm that the application appears in gateway health;
3. inspect skipped or duplicate route warnings;
4. request one route through the gateway;
5. verify migrations and background workers;
6. verify Core identity key readiness and the internal JWKS response;
7. confirm the app reports its expected release and Sync version in Admin → Apps;
8. for a platform release, run `bun run release:preflight`;
9. stop one application instance and confirm registry cleanup.

See [Identity key operations](/en/docs/operations/identity-key-operations) for
normal signing-key rotation, KEK rewrap, and emergency revocation.

See [Runtime configuration](/en/docs/operations/runtime-configuration) before
setting container values.

### Assistant runtime assets

Assistant script and action workers use the `cloud` runtime contract. Deploy its
eager worker, content-hashed CSV/sheet/finance/PDF-reader chunks, and chunk manifest
from the same image. Existing app source needs the migration described in
[Studio library migration](/en/docs/reference/deprecations-and-migrations#studio-script-and-action-library).
Startup adds personal server-side KV storage through Assistant migrations. App
database tables gain nullable audit user columns on first access, without backfill.

Studio apps are HTML pages in a locked frame. The image ships their prelude
(`assistant-app-prelude.js`, pinned by hash in every app document) and the
`@k2b/ui` base stylesheet with IBM Plex as data URLs (`assistant-app-base.css`,
also used by `cloud.pdf.render`). Both come from the same build as the worker;
nothing is fetched from the network at runtime. The first start after the update
clears chat presentations saved in the old format once; see
[Studio apps are plain HTML](/en/docs/reference/deprecations-and-migrations#studio-apps-are-plain-html).
Public links to Studio apps are switched off in this release: existing public
grants stay listed but open nothing.

## Update theme preferences

Rebuild application images to receive the Automatic theme preference and its
head script. Existing `theme=light` and `theme=dark` cookies retain their
meaning. People without a saved choice follow their device's appearance.
Every Cloud page now also sets a functional `color-scheme` cookie (`light` or
`dark`, path `/`, one year, `SameSite=Lax`, `Secure` on HTTPS). It tells the
server the device's last appearance and holds no personal data. Add it to the
cookie list in your privacy notice if you keep one.
No data migration or configuration change is required. See
[Follow the person's theme](/en/docs/frontend/styling-and-accessibility#follow-the-persons-theme).
