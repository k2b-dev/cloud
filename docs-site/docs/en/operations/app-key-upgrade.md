---
title: Upgrade applications to app keys
navTitle: App key upgrade
section: Operations
order: 1141
description: Replace application infrastructure environment values with an app key file and the Core address, with explicit migration checks and rollback boundaries.
tags: [deployment, upgrade, configuration, app-keys]
updated: 2026-10-30
---

# Upgrade applications to app keys

Each application receives its own `CLOUD_APP_KEY_FILE` and
`CLOUD_CORE_INTERNAL_ORIGIN`. Core and Gateway keep their infrastructure
environment values. The app loads database, Valkey, NATS and `APP_SECRET`
from Core at startup; it keeps those values only in memory until it stops.

This upgrade requires the release containing the complete platform-client
migration and signed background and OAuth requests. Do not apply the new
Compose template to an earlier release. Third-party applications must also
use the platform clients; explicitly retain their environment values until
the application author has migrated them.

## Upgrade an existing installation

Use the same Compose infrastructure overlay and CLI profile throughout.
The commands below use profile `migration`, already signed in as a Cloud
administrator to the installation being upgraded. Keep the previous release's
immutable image tag, Compose files, environment and still-valid credentials
for rollback. Back up Postgres and the encryption keys before upgrading.
Never generate a new `APP_SECRET` for this migration.

1. Upgrade the images to the release containing this guide **using the previous
   release's Compose files and environment**. Do not copy the new Compose
   template yet: it requires key files created in step 3. Retain every existing
   app environment block, including deprecated network allowlists and
   `NATS_ADMIN_*` values and mounts, until the settings import is verified.
   Start Core first and wait for its migrations and readiness, then upgrade the
   other services. Existing environment mode remains supported in this release.
2. Check the settings import. Continue only with exit code zero:

   ```bash
   cld --profile migration admin settings status --env
   ```

   Repair unreadable, missing or conflicting settings before removing their
   environment sources. NATS diagnostic credentials are imported as contents,
   not container file paths.
3. Write the complete intended app inventory into `apps.txt`, one app ID per
   line, including installed third-party apps and apps that are currently
   stopped. Exclude `core` and `gateway`. Create the keys locally:

   ```bash
   cld --profile migration admin apps keys create --all --apps ./apps.txt --out-dir ./secrets
   ```

   This writes `<app>.key` and owner-only enrollment records. Preserve both;
   rerunning the same command resumes after a lost registration response or
   interrupted file write without rotating the key. Never print these files
   or commit them. Ensure each file is readable by its container's process
   user. The supplied production images run as UID 1000; run enrollment with
   `--uid 1000` as root when needed, or arrange the corresponding ownership
   through the deployment's secret store. Compose file-backed secrets retain
   host ownership; Compose `uid`/`mode` settings do not repair host permissions.
4. Use `compose.prod.yml` from this release. Replace each ordinary app's
   environment block with its key-file path and the direct Core origin;
   mount its corresponding `./secrets/<app>.key` as a Docker secret. Keep
   infrastructure values on Core and Gateway. Include the infrastructure
   overlay as before. On a network crossing hosts, use verified HTTPS to Core
   and install any private CA before the first bootstrap request.
5. Recreate the app services and wait for readiness. Check every expected app:

   ```bash
   cld --profile migration admin apps status --strict --json --expect "$(paste -sd, apps.txt)"
   ```

   Continue only with exit code zero. The inventory combines apps with active keys on enabled accounts,
   registered apps and `--expect`. The result includes every live replica's
   mode, key ID, sources and format/protocol capability. Missing metadata,
   stopped apps and unknown producers do not pass. During a rolling update,
   both old and new replicas count. Use `--allow-env inventory` only as an
   explicit exception for a third-party app, keep that app's old environment
   block, and record the exception in the deployment inventory.
6. Verify background work and OAuth token issuance with app keys, inspect
   legacy usage over a representative work cycle, and review the actual
   deployment configuration. A quiet observation window does not prove a
   stopped or infrequently used client is migrated. Remove
   `CLOUD_MAIL_APP_CREDENTIAL`, `CLOUD_APP_CREDENTIAL` and
   `CLOUD_OAUTH_BROKER_SECRET` from the relevant deployment configuration only
   after these checks, and revoke the obsolete workload tokens through
   **Administration › Apps** or `cld admin app-credentials revoke`.

Check the private `/_cloud/ready` endpoint of each service, a routed app
request, a background action and OAuth issuance after the rollout. Gateway
readiness alone does not establish app readiness.

## Roll back at the right boundary

- **App key/environment switch (steps 3–5):** restore the previous app
  environment blocks and recreate those apps. Keep their previous workload
  credentials valid while this rollback remains needed. The new public keys
  and installation ID can stay in Postgres. Do not change `APP_SECRET`.
- **Removing old broker authentication:** this release still accepts the old
  paths. Removing their configuration is reversible only while those
  credentials remain valid; after revocation, provision replacements. Once
  the following release removes the old paths, rolling the configuration
  back requires returning to this parallel-support release as well.
- **Encryption format/root changes:** this migration does not rotate
  `APP_SECRET` or change its format. A later encryption-root or format change
  has a separate restore boundary; restoring images or environment values
  alone cannot recover data encrypted with an incompatible root.

## Start a fresh installation

Start infrastructure, then Core and Gateway with their infrastructure
environment. Sign in with `ADMIN_LOGIN_TOKEN`, create keys for the complete
app inventory, and then start the apps using this release's Compose template.
Run the strict status check above before enabling normal traffic. An app can
be enrolled before it ever registers; a stopped app with an active key remains visible
in the status result.

## Mount app keys in Kubernetes

Keep Core and Gateway infrastructure values in their operator-managed Secret.
Create one separate Secret per application; do not grant the application a
Kubernetes API role or add an init container. For example, after generating
`secrets/inventory.key`:

```bash
kubectl create secret generic inventory-app-key --from-file=app.key=./secrets/inventory.key --dry-run=client -o yaml | kubectl apply -f -
```

Add the following to that application's Deployment pod template, replacing
the Core origin with the installation's private listener:

```yaml
spec:
  containers:
    - name: inventory
      image: registry.example/inventory:immutable-release-tag
      env:
        - name: CLOUD_APP_KEY_FILE
          value: /run/secrets/cloud/app.key
        - name: CLOUD_CORE_INTERNAL_ORIGIN
          value: https://core.internal.example
      volumeMounts:
        - name: app-key
          mountPath: /run/secrets/cloud
          readOnly: true
  volumes:
    - name: app-key
      secret:
        secretName: inventory-app-key
        defaultMode: 0444
```

Use the pod's established UID and filesystem policy. The key must be readable
by that UID; it is never copied into an environment value. Rotate by enrolling
a second key, replacing the Secret, rolling every replica, checking strict
status and then revoking the old key. Updating a Secret alone does not replace
the key already held in a running process.

## Development installation

`bun run dev` prepares public development-only key files in
`.local/dev-app-keys` before starting infrastructure. Core's migration then
enrolls the matching public keys transactionally before Core becomes healthy;
application services depend on that healthcheck. Repeated starts do not
reactivate revoked keys or disabled app accounts. All workspace apps are
pre-enrolled, including optional apps. A strict development status therefore
reports stopped optional apps until they run or their fixture keys are revoked;
`--expect` adds inventory and never hides an enrolled app.

The isolated Compose development database uses a fixed installation ID.
Existing databases without app keys keep their data when they adopt this ID.
A database that already contains keys for another installation ID is refused;
use a separate development database rather than replacing its identity.
`CLOUD_DEV_APP_KEYS` requires `NODE_ENV=development`. Public development keys
are also refused by enrollment and authentication outside development,
including when a development database was restored into production. The
private fixtures are public source files and must never be used for an
operator deployment.
