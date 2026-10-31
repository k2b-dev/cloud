---
title: App keys
navTitle: App keys
section: Operations
order: 1144
description: Enroll, export, rotate and revoke an application's Ed25519 key without sending its private seed to Core.
tags: [operations, identity, credentials, cli]
updated: 2026-10-31
---

# App keys

Enroll one Ed25519 key pair for each application. Generate the pair locally;
Core stores only its public key and lifecycle metadata. An application can have
at most two active, unexpired keys. Core and Gateway cannot have app keys.
Other IDs, including `oauth`, can be enrolled before their first start.

Enrollment is available through `cld` and the administrator API. Keep your
current [runtime configuration](/en/docs/operations/runtime-configuration):
enrolling a key alone does not configure or start an application.

You need a Cloud administrator credential. OAuth credentials also need `write`
or `admin` scope for creation and revocation. Use HTTPS when talking to Core
across machines.

## Create keys with cld

Select the intended administrator profile explicitly:

```bash
cld --profile operator admin apps keys create inventory --out-dir ./secrets
cld --profile operator admin apps keys create oauth --grant oauth:issue --out-dir ./secrets
cld --profile operator admin apps keys create --all --apps inventory,chat --out-dir ./secrets
cld --profile operator admin apps keys create --all --apps ./apps.txt --out-dir ./secrets
```

`apps.txt` contains app IDs separated by commas, whitespace, or newlines.
`--all` requires this explicit inventory; it does not infer running apps or
include optional applications. App IDs match `^[a-z][a-z0-9-]{0,79}$`.

`--out-dir` is required. The default `--format file` creates `<app>.key`, whose
contents are the private key string followed by a newline. Its JSON result
includes `environment.CLOUD_APP_KEY_FILE` with the absolute filename. Other
formats are:

| `--format` | File | Contents |
| --- | --- | --- |
| `env` | `<app>.env` | `CLOUD_APP_KEY=<private key>` |
| `compose` | `<app>.compose.yaml` | A service environment fragment with `CLOUD_APP_KEY` |
| `k8s-secret` | `<app>.secret.yaml` | A Kubernetes Secret with `stringData.CLOUD_APP_KEY` |

These files use the deployment names `CLOUD_APP_KEY` and `CLOUD_APP_KEY_FILE`;
they do not replace the existing runtime configuration in this release.
The Kubernetes Secret is named `<app>-app-key`; long app IDs use a shortened
name with a stable hash suffix. Secret files, including YAML, are private
material. Keep them out of Git and deployment logs.

Every secret file has mode `0600`. A newly created output directory has mode
`0700`. `--uid <number>` sets file ownership when run as root or with your own
UID; the target service must also be able to traverse the directory.
`--name "Deployment"` sets a human-readable key name. Text and `--json` output
contain paths, IDs, and fingerprints, never private keys.

### Resume after an interruption

Before contacting Core, `cld` atomically saves the seed and public key as
`.<app>.enrollment.json` in the output directory. It then registers the public
key and atomically writes the final artifact. Core treats a repeated public
key for the same app as the same enrollment, including after a lost response.

Repeat the same command and output directory after any interruption. Keep the
enrollment file: repeated creation uses that same key and never silently
rotates it. A different server, corrupted enrollment file, or existing output
without an enrollment record causes an error; preserve the file and repair the
cause before retrying. Use a **new output directory for a new key or rotation**. The enrollment file is private material
and needs the same protection as the final key.

## Use the key at start

After enrollment, supply either `CLOUD_APP_KEY` or
`CLOUD_APP_KEY_FILE=/run/secrets/inventory.key` to the application process, plus
`CLOUD_CORE_INTERNAL_ORIGIN=https://core.example.internal`. Mount the key file
so the application user can read it. Do not supply both key sources: that
stops startup. The key's app ID must match the built or development app ID.
Core and Gateway keep their infrastructure environment values and refuse keys.

**Keep infrastructure environment values until the platform-client import
migration is complete.** Key-only production operation is not yet supported;
remaining Bun-global SQL/Redis imports still read `DATABASE_URL` and
`REDIS_URL` from the environment. The bootstrap initializer itself supports a
key and Core origin, but that does not migrate application imports.

The platform requests its connections once before loading application code.
Explicit environment values win per value; Core supplies missing values.
Connection changes require a rolling restart. Use verified TLS across hosts;
install a private CA through `NODE_EXTRA_CA_CERTS` before startup. See
[Deployment requirements](/en/docs/operations/deployment-requirements#prepare-application-connection-bootstrap)
for replica consistency and startup probes.

Invalid, unknown, revoked or mismatched keys stop startup. If Core is
unreachable or answers HTTP 429 or 503, startup retries for at most five minutes
without opening an HTTP listener. A retry signs a new proof even if the first
response was lost. Successful bootstrap updates `lastUsedAt`. Revocation blocks
new bootstrap requests on every Core replica immediately; it does not close
already established database or NATS connections or recall delivered secrets.

## Background and OAuth authority

The platform signs final requests to Core with the configured app key.
Every key has `identity:invoke`. OAuth issuance additionally requires the
operator-owned `oauth:issue` grant, stored as `oauth_issue_allowed` on
`auth.service_account_credentials`, beside `connections_allowed`. Core reads
the grant directly on each request; any app, including a third-party app, can
hold it. Mandates and current OAuth grants still limit each operation.

Every new key defaults to no issuance permission, including a key for `oauth`
and a replacement for a granted key. Enrollment never inherits grants from
other keys. Pass `--grant oauth:issue` explicitly whenever creating or rotating
an issuer key. The flag applies to every app named in that command; enroll
issuer keys separately from apps that do not need issuance.

For the built-in OAuth app's first enrollment on a fresh installation, setup
and development tooling must run:

```bash
cld --profile operator admin apps keys create oauth --grant oauth:issue --out-dir ./secrets
```

The one-time migration grants built-in issuer keys enrolled before this grant
existed. Repeated migrations preserve operator changes. New keys always need
an explicit grant, on upgraded installations too.

The administrator API accepts `grants: ["oauth:issue"]` on enrollment; an omitted
`grants` or `grants: []` creates an ungranted key. `cld` also accepts `--no-grant`
for an explicit empty choice. These options apply only to a new public key;
repeating enrollment preserves its original grants, name, and expiry. To
withdraw issuance authority, create an ungranted replacement in a new output
directory, deploy it, and revoke every granted key for that app. A granted key
can still issue during the rotation overlap. Revoke it immediately if issuance
must stop immediately. There is no grant-editing UI.

Issuance serves clients and one-shot grants registered in Cloud's OAuth
registry. A third-party app holding `oauth:issue` uses that same registry and
Core's issuance checks. A separate client or grant registry owned by a
third-party identity provider is not supported by this contract.

Core owns the issuer and OAuth signing keys. Every granted app uses the same
Core issuance endpoint and internal JWKS; changing the granted app leaves the
public issuer and JWKS unchanged.

Keys with `connections_allowed=false` can sign requests but cannot retrieve
startup connections. Revoking a key rejects its next bootstrap or background
request on every Core replica. An invocation already admitted keeps its
existing short lifetime. See [background mandates](/en/docs/identity/background-mandates).

## Inspect and revoke keys

```bash
cld --profile operator admin apps keys list inventory --json
cld --profile operator admin apps keys revoke inventory <keyId> --yes
```

The list includes the public key, fingerprint, name, creation and creator,
optional expiry, last use, grants, and revocation metadata. Status is `active`,
`expired`, or `revoked`; `accountStatus` is `active` or `disabled`. A disabled
account prevents authentication with all its keys. Successful bootstrap updates
`lastUsedAt`; a key that has never authenticated has a null value. Lists accept `--page` and `--per-page`
(default 100, maximum 500).

Revocation is idempotent. Retrying enrollment of a revoked or expired public
key returns its original ID and never reactivates it. Generate a new pair to
replace it. Disabling the app's service account remains a separate app-wide
off switch. New enrollment into a disabled account returns HTTP 409; repeating
an existing enrollment reports `accountStatus: "disabled"` without enabling it.
The CLI refuses to publish a final artifact for an inactive key or disabled
account. Use a new output directory to replace a revoked or expired key.

## Register a public key through the API

Core's endpoints require administrator authorization:

| Method and path | Request or response |
| --- | --- |
| `POST /api/admin/apps/:appId/keys` | `{ publicKey, name?, expiresAt?, grants? }` → `{ keyId, installationId, fingerprint, status, accountStatus }` |
| `GET /api/admin/apps/:appId/keys` | `{ installationId, items, page, perPage, total, hasNext }` with public-key metadata |
| `DELETE /api/admin/apps/:appId/keys/:keyId` | Revoke that app's exact key; repeated revocation succeeds |
| `GET /api/admin/apps/keys` | `{ installationId, items, page, perPage, total, hasNext }`; each item has `appId`, `accountStatus`, `totalKeys`, `activeKeys` |

Both GET endpoints accept `page` and `perPage` with the same limits as `cld`.
The overview includes apps with revoked keys, even when the app is not running.
`activeKeys` counts unexpired, unrevoked keys; account disablement is separate.

`publicKey` is exactly 32 raw Ed25519 bytes encoded as canonical, unpadded
base64url. Malformed, noncanonical, off-curve, and small-order points are
rejected. `name` contains 1–120 characters. `expiresAt`, when supplied on a new
enrollment, is a future ISO 8601 timestamp. A third active key returns HTTP
409 with an instruction to revoke an old key. Registration is idempotent per
`(appId, publicKey)`; a retry preserves the original grants, name, and expiry.

Creation and revocation produce administrator audit events. Responses use
`Cache-Control: no-store`. No endpoint accepts or returns a private seed.

`installationId` is a UUID created once in a Core database transaction. It
survives a database restore. Preserve the database when restoring an
installation; a newly initialized database has a different identity.

## Create a key with OpenSSL

Use OpenSSL with Ed25519 support, `jq`, and a shell. Store your administrator
request authorization in a mode `0600` curl config file named `admin.curl`,
using curl's `header = "Authorization: Bearer <credential>"` syntax. The file
keeps that credential out of command arguments.

Work in a private directory. Disable shell tracing before handling the seed:

```bash
set +x
set -eu
umask 077
openssl genpkey -algorithm ed25519 -out app.pem
openssl pkey -in app.pem -outform DER -out app.der
openssl pkey -in app.pem -pubout -outform DER -out app-public.der

test "$(wc -c < app.der)" -eq 48
test "$(wc -c < app-public.der)" -eq 44
seed="$(tail -c 32 app.der | openssl base64 -A | tr '+/' '-_' | tr -d '=')"
public_key="$(tail -c 32 app-public.der | openssl base64 -A | tr '+/' '-_' | tr -d '=')"
jq -n --arg publicKey "$public_key" '{publicKey: $publicKey, name: "Deployment"}' > public-key.json

curl --fail-with-body --config admin.curl \
  --json @public-key.json \
  https://cloud.example.com/api/admin/apps/inventory/keys > registration.json
```

The private DER is the 16-byte Ed25519 PKCS#8 prefix plus the 32-byte seed;
the public DER is the 12-byte SubjectPublicKeyInfo prefix plus the 32-byte
public key. The size checks above guard the extraction layout. Keep `app.pem`
and `app.der` private. If the request fails or its response is lost, repeat the
curl command with the same public-key file; do not generate another pair.

After a successful response, assemble the private key using shell built-ins:

```bash
jq -e '.status == "active" and .accountStatus == "active"' registration.json > /dev/null || exit 1
installation_id="$(jq -er '.installationId' registration.json)"
key_id="$(jq -er '.keyId' registration.json)"
printf 'cloud-app-key-v1.%s.%s.%s.%s\n' \
  "$installation_id" inventory "$key_id" "$seed" > inventory.key
unset seed
```

`inventory.key` is the final secret artifact. The public key and registration
response are not private key material. Protect the administrator curl config
and private PEM/DER files as well.

## Rotate or recover a key

For rotation, create a second key in a new output directory, distribute it to
the application deployment, then revoke the old key. At most two keys can be
active during this overlap. An issuer replacement needs `--grant oauth:issue`
again; grants are never inherited. Keep the existing runtime configuration
until its key-consuming startup protocol is available.

For a lost key, create a new pair and revoke the lost key. Core cannot recover
the private seed; losing it does not delete application data.

For a stolen key, revoke it and rotate any credentials already delivered to
the application: Postgres, Valkey, NATS, and `APP_SECRET`. Revoking an app key
does not close existing infrastructure connections or recover copied data.
Follow the affected service's credential-rotation procedure; changing
`APP_SECRET` also needs its data-encryption migration procedure.

## Use the portable key-format helpers

`@k2b/cloud/app-key` has no server imports and works in Bun and browsers with
WebCrypto Ed25519. Browser generation requires a secure context.

- `generateAppKeyPair()` returns `{ seed, publicKey }` through WebCrypto JWK export.
- `deriveAppPublicKey(seed)` derives the public key from a 32-byte seed.
- `importAppKeySeed(seed)` and `importAppPublicKey(publicKey)` return WebCrypto keys for signing or verification.
- `formatAppKey({ installationId, appId, keyId, seed })` and `parseAppKey(value)` validate the private string; IDs are canonical lowercase UUIDs.
- `validateAppKeyAppId(appId)` enforces the ID syntax and reserved IDs.
- `appKeyFingerprint(publicKey)` returns the first 16 bytes of SHA-256 of the raw public key as **32 lowercase hexadecimal characters**.

Private strings have the form
`cloud-app-key-v1.<installationId>.<appId>.<keyId>.<base64url seed>`.
The seed is exactly 32 bytes, encoded without padding. Parsing rejects
whitespace, noncanonical base64url, extra segments, and unknown versions.

```ts
import { formatAppKey, parseAppKey } from "@k2b/cloud/app-key";

export function finishEnrollment(
  seed: string,
  appId: string,
  registration: { installationId: string; keyId: string; status: string; accountStatus: string },
) {
  if (registration.status !== "active" || registration.accountStatus !== "active") throw new Error("Enrollment is inactive");
  const value = formatAppKey({ ...registration, appId, seed });
  return { value, identity: parseAppKey(value) };
}
```

Keep the locally generated pair until registration succeeds. Retrying with the
same public key is what makes lost responses safe. Core-owned consumers read
`getInstallationId`, `getActiveAppKey`, and `touchAppKey` from
`@k2b/cloud/services/app-keys`; the active-key read goes directly to Postgres
and checks account status, revocation, and expiry without a cache.
