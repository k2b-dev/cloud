---
title: Upgrade applications to app keys
navTitle: App key upgrade
section: Operations
order: 1141
description: Replace application infrastructure environment values with an app key file and the Core address, with explicit migration checks and rollback boundaries.
tags: [deployment, upgrade, configuration, app-keys]
updated: 2026-10-31
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
   Upgrade every Core replica first and wait for its migrations and readiness,
   then upgrade Gateway and the other services. Verify that no older Core replica
   remains before starting the observation in step 5. Existing environment mode remains supported in this release.
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
   # The supplied deployment includes oauth; issuance is an explicit key grant.
   cld --profile migration admin apps keys create oauth --grant oauth:issue --out-dir ./secrets
   awk '$0 != "oauth"' apps.txt > apps-without-oauth.txt
   cld --profile migration admin apps keys create --all --apps ./apps-without-oauth.txt --no-grant --out-dir ./secrets
   ```

   For a deployment without OAuth, omit the first command and use `apps.txt`
   directly with `--no-grant`. Apply `--grant oauth:issue` to any other issuer
   deliberately, in its own enrollment command. Repeat the grant on rotation;
   the library never infers it from an app name. Repeating enrollment preserves
   the original grants: replace a key enrolled without the needed grant using
   a new output directory rather than expecting a retry to add authority.

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
5. Recreate the app services and wait for readiness. After **every Core replica**
   is upgraded and all intended callers are migrated, begin durable legacy-use
   observation:

   ```bash
   cld --profile migration admin apps migration observe --json
   ```

   Choose a clean interval that covers representative scheduled background work,
   OAuth issuance and infrequent clients. For example, use `OBSERVATION_SECONDS=86400`
   for a daily work cycle; include weekly jobs explicitly or choose a longer
   interval when needed. Exercise real background work and OAuth token issuance
   during this interval. Accepted legacy bearer or OAuth broker-secret requests
   restart the clean interval, across all Core replicas and process restarts.
   Starting observation again discards elapsed time, so do not restart it while
   waiting. No observation or no chosen duration can pass status.
6. After that clean interval, check every expected app:

   ```bash
   cld --profile migration admin apps migration status --strict --json --observation-seconds "$OBSERVATION_SECONDS" --expect "$(paste -sd, apps.txt)"
   ```

   Continue only with exit code zero. The inventory combines apps with active
   keys on enabled accounts, registered apps and `--expect`. The result includes
   every live replica's mode, key ID, sources and format/protocol capability.
   Missing metadata, stopped apps and unknown producers do not pass. During a
   rolling update, both old and new replicas count. Each deployed key must
   complete a **fresh signed broker probe**; keys granted `oauth:issue` also
   complete a signed OAuth probe. Core records these authenticated receipts;
   an app's claim alone is insufficient. Missing, rejected, timed-out or
   unreachable probes keep status nonzero. The check uses the registered
   application endpoint. During key rotation, an endpoint reaching a replica
   using the other key may report an incomplete probe: finish the rollout and
   retry; never bypass the result.

   `lastRejectedStart` appears per app in JSON and text as an attention reason.
   A successful bootstrap clears that rejection. An already running older
   replica does not clear it by reporting readiness.

   Use `--allow-env inventory` only as an explicit exception for a third-party
   app retaining connection environment values. It still needs its deployed key,
   modern bootstrap metadata and successful signed probes. The exception does
   not waive observation, stopped instances or rejected starts. Keep the app's
   old environment block and record the exception in the deployment inventory.
7. Review the actual deployment configuration and representative work results.
   A clean window cannot prove that a stopped or unexercised client migrated.
   Only after the strict check and this review, remove
   `CLOUD_MAIL_APP_CREDENTIAL`, `CLOUD_APP_CREDENTIAL` and
   `CLOUD_OAUTH_BROKER_SECRET` from the relevant deployment configuration and
   revoke obsolete workload tokens through **Administration › Apps** or
   `cld admin app-credentials revoke`.

Check the private `/_cloud/ready` endpoint of each service, a routed app
request, a background action and OAuth issuance after the rollout. Gateway
readiness alone does not establish app readiness.

See [Check application migration evidence](/en/docs/operations/app-key-status)
for the status command and its evidence fields.

## Roll back at the right boundary

- **App key/environment switch (steps 3–6):** restore the previous app
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
app inventory as in step 3, explicitly granting `oauth:issue` to the built-in
OAuth app, and then start the apps using this release's Compose template.
Begin observation and run the strict check as above before retiring legacy
configuration. An app can
be enrolled before it ever registers; a stopped app with an active key remains visible
in the status result.

## Mount app keys in Kubernetes

Keep Core and Gateway infrastructure values in their operator-managed Secret.
Enroll the built-in OAuth app with `--grant oauth:issue` as in step 3 before
creating its Secret. Repeat that grant on key rotation. Create one separate Secret per application; do not grant the application a
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
application services depend on that healthcheck. The deployment enrollment
explicitly grants `oauth:issue` only to the built-in OAuth fixture; it is not
a library default. Repeated starts do not
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
