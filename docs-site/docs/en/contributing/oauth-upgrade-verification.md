---
title: Verify OAuth upgrade compatibility
navTitle: OAuth upgrade verification
section: Contributing
order: 1320
description: Check the public OAuth contract against the pre-JWT implementation with an isolated HTTP reference client.
tags: [contributing, identity, oauth, testing, migration]
updated: 2026-09-04
---

# Verify OAuth upgrade compatibility

Run this check to verify the coordinated OAuth hard cut. It exercises
the public HTTP protocol against the actual pre-JWT implementation, upgrades
the same database, and repeats the requests against Core-owned issuance.
A second scenario starts with an empty database and current code.
A third disposable database runs the complete OAuth token and AI store/task
regression suites with real JWT session fixtures and a Core JWKS endpoint.
Those tests load anydoc's native Linux binding from the existing Core image;
the runner checks that its package version matches the checkout. No native
dependency is downloaded during verification.

```bash
bun scripts/verify-oauth-upgrade.ts
```

The check needs the Git history containing baseline revision
`3ae6c09a774fc22dc36b5d01b960bd13b2a1a85d`, installed workspace dependencies,
Docker, and the local images `postgres:15-alpine`, `valkey/valkey:8-alpine`,
and `cloud-app-core:latest`. It does not pull images or install dependencies.
Both revisions use the installed dependencies and built UI; this is not a
reconstruction of a historical dependency build.

## Isolation and success

The runner extracts the baseline into a temporary directory without changing
the checkout. It starts disposable PostgreSQL and Valkey containers on an
offline network, without published ports or persistent database volumes. The
development stack is neither stopped nor used. Containers are removed when
the runner finishes, including after a failed check.

Core and OAuth run as separate processes. Only current Core receives the
identity key-encryption key. OAuth authenticates to the real internal Core
authority with the isolated verification broker secret. The reference
client imports no Cloud services, reads no database, and verifies JWTs using
the public JWKS endpoint. No authentication or signing function is mocked.

A successful run exits with status zero and prints the evidence directory.
It contains `upgrade.json`, `fresh.json`, `environment.json`, `regressions.txt`,
`full-regressions.txt`, and `oauth.diff`. Existing contract, session-JWT, and Core-authority tests also
run against the disposable database; skipped tests fail the check.
The reports contain check results and synthetic contract data, not tokens,
client secrets, or private keys. The environment report records the baseline,
current Git revision, dirty-file inventory, and container image IDs. Keep the
evidence with the exact source changes used for the run.

## What the check proves

| Boundary | Check |
| --- | --- |
| Public schemas | Client/admin schemas and selected protocol declarations are unchanged against the fixed baseline. The check fails if they differ. |
| Discovery | Both discovery endpoints return identical metadata before and after upgrade. |
| User clients | Managed public clients use PKCE S256; confidential clients use Basic for code exchange and form credentials for refresh. |
| Token contract | Response fields, RS256 signatures, issuer, audiences, subjects, one-hour lifetime, profile/email/nested-group claims, and UserInfo remain compatible. |
| Refresh | Rotation, scope reduction, replay rejection, family revocation, and exact resource binding work through HTTP. |
| Machine clients | Client credentials retain resource-service-account identity; invalid secrets, scopes, and resources are rejected. |
| Dynamic clients | Registration, explicit consent, PKCE, and resource-bound refresh work. A resource token cannot authenticate as a general Cloud session. |
| Upgrade | Existing client IDs/secrets, unconsumed codes and refresh families remain usable. Old OAuth JWTs are rejected by Cloud and by the reference client after its JWKS refresh. |
| Authority cutover | Core is the sole issuer; OAuth startup checks readiness and the migration removes obsolete signing tables. |
| Browser logout | Explicit session revocation rejects old opaque and current JWT sessions; a new login returns a usable JWT cookie without revoking OAuth grants. |

For the pre/post comparison, timestamps and fresh token identifiers are not
compared byte-for-byte. Lifetime, nonce binding, signatures, and claim presence
are checked separately. Existing client and user identifiers remain unchanged.

## Interpret differences correctly

The JWT migration does not rename the public OAuth fields or endpoints.
JWKS now additionally supports ETag-based conditional GET with `304` and a
five-minute cache bound. Core can also reject a grant that became invalid
between validation and signing; the public endpoint maps this to
`invalid_grant`. An uncertain authority failure remains `server_error`.
These are observable behaviors, even though the request/response schemas
remain unchanged. Keep their focused failure and concurrency tests too.

The upgrade rejects old opaque browser sessions immediately and verifies JWT
re-login. Isolated regression tests reconstruct the previous JWT release's
migration marker and session families, verify the one-time invalidation under
concurrent migration, and prove that another migration preserves new logins.
OAuth access tokens, codes, and refresh grants remain usable after browser logout.

The coordinated hard cut intentionally invalidates old browser sessions and
old OAuth JWTs. Refresh grants and client registrations are not discarded.
External clients can retain old public keys in their own warm caches; the
reference client explicitly reloads JWKS to verify the new publication set.
See [Request identity](/en/docs/identity/authentication)
and [OAuth clients and flows](/en/docs/identity/oauth).

## What remains a deployment check

This is a reference-client protocol and migration check, not a production
rollout or a claim that every third-party client was tested. It uses a small
routing fixture instead of gateway discovery and an emergency-admin login
instead of FreeIPA, email delivery, or passkeys. It does not exercise browser
rendering, HTTPS ingress, mixed-version fleets, production database roles,
long-running key-grace expiry, or representative application load.

Verify those boundaries separately where the deployment depends on them.
Use [Identity key operations](/en/docs/operations/identity-key-operations) for
rotation and recovery, and [Identity performance](/en/docs/contributing/identity-performance)
for the independent latency and query-budget checks.
