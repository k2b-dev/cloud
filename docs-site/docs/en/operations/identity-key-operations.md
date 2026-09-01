---
title: Identity key operations
navTitle: Identity keys
section: Operations
order: 1145
description: Operate Core-owned signing keys, rotation, rewrap, and emergency revocation.
tags: [identity, jwt, keys, rotation, recovery]
updated: 2026-09-01
---

# Identity key operations

Core is the only private-key authority for platform session and invocation
tokens. It stores RSA private JWKs encrypted in PostgreSQL with a Core-only
key-encryption key (KEK). Applications receive only public JWKs from the fixed
`/.well-known/cloud-identity-jwks.json` endpoint. The existing OAuth
`/.well-known/jwks.json` endpoint remains separate and compatible.

The current deployment gives every application the same PostgreSQL credential.
The `APP_ID=core` and Core-only environment secret prevent another normal Cloud
process from decrypting or issuing keys, but the database cannot enforce row
ownership against a compromised application with that shared credential. Use
separate database roles before treating PostgreSQL itself as a hard issuer
boundary.

## Normal signing-key rotation

Core performs maintenance every minute. The target signing lifetime is 30
days. It publishes a pending public key at least ten minutes before activation,
keeps the active signer in memory for at most one minute, and leaves retired
public keys available until every issued token plus clock and rollout margin
has expired. Rotation is protected by a purpose-scoped PostgreSQL transaction
lock, so multiple Core instances converge on one active and at most one pending
key.

The JWKS response uses an ETag and a five-minute public cache bound. Unknown
`kid` values trigger the verifier's JWKS refresh behavior. New issuance fails
closed when Core cannot load a validated active signer; verification can
continue from public material and warm caches.

Every application must be able to reach the deployment issuer's HTTPS JWKS
URL before JWT issuance is enabled. Keep that route available through the
normal ingress during Core maintenance: a warm verifier can tolerate a brief
outage, but a cold start or newly published `kid` needs the endpoint. The local
development stack uses an internal Core origin for this route only.

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

Do not rotate `APP_SECRET` as a substitute. It encrypts settings and
credentials and is deliberately not a signing-key or KEK fallback.
