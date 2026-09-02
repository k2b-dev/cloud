---
title: Identity key operations
navTitle: Identity keys
section: Operations
order: 1145
description: Operate Core-owned signing keys, rotation, rewrap, and emergency revocation.
tags: [identity, jwt, keys, rotation, recovery]
updated: 2026-09-03
---

# Identity key operations

Core is the only private-key authority for platform session, invocation, and
OAuth tokens. It stores RSA private JWKs encrypted in PostgreSQL with a Core-only
key-encryption key (KEK). Applications verify sessions only from
`/.well-known/cloud-session-jwks.json` and invocations only from
`/.well-known/cloud-invocation-jwks.json`. The former combined
`/.well-known/cloud-identity-jwks.json` remains available during rolling
upgrades, but current verifiers never use it. The OAuth purpose is
published through the existing, compatible `/.well-known/jwks.json` endpoint;
the validators and key purposes remain mutually exclusive.

The current deployment gives every application the same PostgreSQL credential.
The `APP_ID=core` and Core-only environment secret prevent another normal Cloud
process from decrypting or issuing keys, but the database cannot enforce row
ownership against a compromised application with that shared credential. Use
separate database roles before treating PostgreSQL itself as a hard issuer
boundary.

## Normal signing-key rotation

Core performs maintenance for the session, invocation, and OAuth purposes every
minute. The target signing lifetime is 30 days. It publishes a pending public
key at least ten minutes before activation, keeps the active signer in memory
for at most one minute, and leaves retired public keys available until every
issued token plus clock and rollout margin has expired. Rotation is protected
by a purpose-scoped PostgreSQL transaction lock, so multiple Core instances
converge on one active and at most one pending key.

Each purpose-specific JWKS response has its own ETag and a five-minute public
cache bound. Unknown
`kid` values trigger the verifier's JWKS refresh behavior. New issuance fails
closed when Core cannot load a validated active signer; verification can
continue from public material and warm caches.

OAuth access-token verifiers independently cache the compatible
`/.well-known/jwks.json` response for the same five-minute bound. Configure
`CLOUD_OAUTH_JWKS_ORIGIN` with the private OAuth application origin. A warm
request verifies locally, then resolves the current client and actor in one
PostgreSQL query. It does not query either signing-key table. An unknown `kid`
gets one bounded refresh attempt; a removed or emergency-revoked known key can
remain usable only until that local cache expires, at most five minutes.

Every application must be able to reach Core's JWKS before JWT issuance is
enabled. Set `CLOUD_IDENTITY_JWKS_ORIGIN` to the private Core service origin so
a cold start or unknown `kid` does not depend on public DNS, ingress, or
hairpin routing. The token issuer remains the public HTTPS Cloud origin; only
the public-key transport uses the private address. A warm verifier can tolerate
a brief Core outage.

Private HTTP requires a trusted transport network; it is not secure merely
because a JWKS contains public keys. Follow the network, Core-first rollout,
and clock requirements in
[Runtime configuration](/en/docs/operations/runtime-configuration).

Invocation JWTs have a nominal 30-second lifetime and a dedicated two-second
clock tolerance. A correctly issued token can therefore remain acceptable for
at most 32 seconds after its `iat`; browser sessions retain their separate
30-second clock tolerance.

Inspect key metadata with the admin endpoint:

```http
GET /api/admin/identity/keys
```

The response contains lifecycle metadata and the KEK fingerprint, never private
key material or token contents.

## Rotate the KEK

Generate a new KEK:

```bash
openssl rand -hex 32
```

Then perform a three-phase rolling rewrap:

1. keep the old current KEK and distribute the new value as
   `CLOUD_IDENTITY_NEXT_KEY` to every Core replica;
2. after every replica is ready, promote the new value to
   `CLOUD_IDENTITY_KEY_ENCRYPTION_KEY`, move the old value to
   `CLOUD_IDENTITY_PREVIOUS_KEY`, remove `CLOUD_IDENTITY_NEXT_KEY`, and roll
   every replica again;
3. confirm every key reports the new `encryptionKeyId`;
4. call `POST /api/admin/identity/keys/rewrap` safely if another idempotent pass
   is desired;
5. remove `CLOUD_IDENTITY_PREVIOUS_KEY` and roll every Core replica a final
   time.

The first phase matters: an old-current replica can decrypt new ciphertext via
its pre-distributed next KEK while the second phase is still rolling. Never
skip directly to `current=new, previous=old` when an old Core replica may still
be running.

Core decrypts with the current or previous KEK, validates every private/public
pair, encrypts only with the current KEK, and updates all rows transactionally.
Readiness fails if ciphertext is corrupt, the KEK is wrong, or a pair does not
match. Back up the database and the current KEK through the deployment's secret
and backup systems before beginning.

## Emergency signing-key revocation

Use the authenticated admin endpoint with a durable incident reason:

```http
POST /api/admin/identity/keys/<kid>/revoke
Content-Type: application/json

{"reason":"suspected private-key exposure"}
```

The key disappears from newly generated JWKS responses and Core immediately
creates a replacement signer when the revoked key was active. Already warm
verifier and intermediary caches can retain the compromised public key for at
most the configured five-minute JWKS cache bound. Treat that interval as part
of the incident blast radius. Session-family and user-epoch revocation remains
available when all sessions must be invalidated immediately at the database
authorization step.

Invocation and OAuth issuance confirm the prepared signer against PostgreSQL
while holding a shared lock on its active key row. A capability or widget call
checks once; Universal Search checks once for the whole target fan-out and
reuses that signer. Emergency revocation waits for an already-started signing
batch to finish. After the revocation transaction commits, no Core replica can
release a new invocation or OAuth token under that `kid`; a replica with a
stale signer cache refreshes once and otherwise fails closed. This guarantee
does not invalidate tokens that were already released, so their normal token
and verifier-cache windows still apply.

Core prepares the signer and issuer before reserving the issuance transaction.
Key checks, mandate validation or OAuth grant consumption, and signing then
share one connection. A cold cache or concurrent fan-out does not require a
second connection while holding the first. Mandate signing failures return as
results so their failure audit commits with that transaction before Core returns
an error. Signing callbacks must not start another pool transaction or reload
configuration through the pool.

Each batch also sets a transaction-local PostgreSQL statement timeout using
the remaining issuance budget. This adds one database round trip per batch,
including one for an entire Universal Search fan-out, not one per provider.
The database timeout bounds blocked statements and lock waits; it is not an
instant cancellation of the whole transaction. Core checks the request deadline
before using a queued connection and after commit, and never returns a token
after that deadline. A database failure can roll back the transaction's audit;
the failed-signing audit guarantee assumes the database can commit it.

Do not rotate `APP_SECRET` as a substitute. It encrypts settings and
credentials and is deliberately not a signing-key or KEK fallback.

Maintainers can measure this guard and the complete search authentication path
with the [identity performance check](/en/docs/contributing/identity-performance).
Its p95 gate includes the shared transaction, not just local JWT cryptography.
