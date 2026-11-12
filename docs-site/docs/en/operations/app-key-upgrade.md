---
title: Upgrade applications to app keys
navTitle: App key upgrade
section: Operations
order: 1141
description: Prepare application keys before upgrading, verify signed work, and check every deployed replica.
tags: [deployment, upgrade, configuration, app-keys]
updated: 2026-11-12
---

# Upgrade applications to app keys

This release requires an enrolled Ed25519 app key for every serving application
except Core and Gateway. There is no workload-token or shared broker-secret
fallback. Prepare the keys on the previous parallel-support release before
upgrading. Core and Gateway keep their infrastructure environment values and
refuse app keys.

## Upgrade an existing installation

Stop all old Core replicas before starting the new Core version, as described
in step 5. The migration removes the former workload, migration-observation
and proof replay tables. Applications keep running during this Core-only
maintenance window. All new Core replicas must share the same Valkey replay
store before signed traffic resumes. See
[Upgrade all Core replicas together](/en/docs/operations/app-keys#upgrade-all-core-replicas-together)
for the shared Valkey requirement and recovery behavior.

Use the same Compose infrastructure overlay and CLI profile throughout.
The commands below use profile `migration`, already signed in as a Cloud
administrator to the installation being upgraded. Keep the previous release's
immutable image tag, Compose files, environment and still-valid credentials
for rollback. Back up Postgres and the encryption keys before upgrading.
Never generate a new `APP_SECRET` for this migration.

1. On the previous parallel-support release, upgrade every Core replica and
   application to a version that supports signed app requests and resource
   principal reads. Releases 0.56.0–0.65.0 cannot serve signed resource-principal
   reads ([#2377](https://github.com/k2b-dev/cloud/issues/2377)); first upgrade
   to a parallel-support version containing that fix.
2. Check imported settings with `cld --profile migration admin settings status --env`.
   Repair missing, unreadable or conflicting settings before removing their
   environment sources or mounts.
3. Write the complete intended app inventory to `apps.txt`, one ID per line,
   including third-party and stopped apps; exclude `core` and `gateway`.
   Enroll each identity locally:

   ```bash
   cld --profile migration admin apps keys create oauth --grant oauth:issue --out-dir ./secrets
   awk '$0 != "oauth"' apps.txt > apps-without-oauth.txt
   cld --profile migration admin apps keys create --all --apps ./apps-without-oauth.txt --no-grant --out-dir ./secrets
   ```

   Omit the first command when OAuth is absent. Grant `oauth:issue` explicitly
   to any other intended issuer in its own enrollment command. Repeat the grant
   on every rotation; neither app IDs nor repeated enrollment add authority.
   A database upgrade that introduces the grant column also leaves every key
   ungranted; enroll a replacement key with the explicit grant before starting
   its issuer. Existing stored grants remain unchanged.
   Preserve the private `<app>.key` files and owner-only enrollment records.
   Never print or commit them. Production images run as UID 1000: use the
   CLI's `--uid 1000` as root or set corresponding secret-store ownership.
   File-backed Compose secrets retain host ownership.
4. Still on the previous release, mount each key and set `CLOUD_APP_KEY_FILE`
   and `CLOUD_CORE_INTERNAL_ORIGIN`. Restart every app replica and verify a
   routed request, representative background work, resource-principal reads
   and OAuth readiness and issuance where applicable. Retain explicit connection
   environment values for third-party apps that still use Bun globals.
5. Stop **all old Core replicas before starting any Core replica on this
   release**. This Core-only maintenance window is required because the migration
   drops the workload, migration-observation and proof replay tables used by old
   Core versions. Mixing versions can cause failed requests or block the
   migration on old broker transactions. Applications keep running; requests and background work that
   need Core are briefly unavailable. Start the new Core version and wait for
   readiness, then upgrade Gateway and the applications. Core's migration
   revokes active app API tokens carrying former workload scopes and records each
   revocation once. Use this release's Compose template: ordinary apps receive
   their key file and direct Core origin; Core and Gateway retain infrastructure
   configuration. Keep documented third-party connection overrides. Across hosts
   use verified HTTPS to Core.
6. After all replicas are ready, check the complete inventory:

   ```bash
   cld --profile migration admin apps migration status --strict --json --expect "$(paste -sd, apps.txt)"
   ```

   Continue only with exit code zero. Every live replica needs key bootstrap
   metadata, a current key and fresh signed broker receipts; keys granted
   `oauth:issue` also need OAuth receipts. Stopped apps, malformed metadata,
   probe failures and `lastRejectedStart` keep status nonzero. A successful
   bootstrap clears a rejected start. During rotation, finish the rollout and
   retry if the endpoint reaches a replica using the other key.

   Add `--allow-env inventory` only for an app deliberately retaining explicit
   connection values. It still needs an app key and signed probes. This option
   does not permit keyless HTTP processes or waive stopped apps and rejected starts.
7. Remove retired workload-token and broker-secret injection from deployment
   files and secret stores. Check each service's private `/_cloud/ready`, a
   routed app request, background work and OAuth issuance. Gateway readiness
   alone does not establish application readiness.

The status command no longer uses an observation window. It verifies current
metadata and fresh signed work. Review actual deployment configuration and
representative jobs too; a probe does not exercise every business operation.
See [App migration status](/en/docs/operations/app-key-status).

## Roll back at the right boundary

Returning to environment-only application identity requires returning to the
previous parallel-support release. Restoring environment values alone cannot
start an ordinary HTTP app on this release. Enrolled keys remain usable on
that previous release, so retain them during rollback. The revocation migration
is permanent: returning to older images does not reactivate retired tokens.
If old authentication is needed there, provision replacement credentials using
that release's supported procedure.

This upgrade does not rotate the encryption root. Keep `APP_SECRET` and the
Core identity encryption keys stable. An incompatible encryption-format change
has its own database-and-key restore boundary.

## Start a fresh installation

Start infrastructure, then Core and Gateway with infrastructure configuration.
Sign in using the temporary Core `ADMIN_LOGIN_TOKEN`, enroll keys for the
complete app inventory as in step 3, and start apps with their mounted keys.
Grant OAuth issuance explicitly. Check readiness, real work and strict status.
An app can be enrolled before its first start; its active key keeps a stopped
app visible in the status inventory.

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
