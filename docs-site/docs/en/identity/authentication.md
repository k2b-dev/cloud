---
title: Request identity
navTitle: Request identity
section: Identity and access
order: 310
description: Resolve Cloud credentials into the actor and access subject used by an application.
tags: [identity, authentication, sessions, middleware]
updated: 2026-09-08
---

# Request identity

Cloud turns a browser session or bearer token into a request actor.
Applications select an auth policy. They do not parse or store credentials.
The choice of [sign-in method](/en/docs/accounts) does not change this contract.

Add the policy to the Hono router:

```ts
import { type AuthContext, auth } from "@k2b/cloud/server";
import { Hono } from "hono";

const routes = new Hono<AuthContext>()
  .use("*", auth.requireRole("authenticated"))
  .get("/items", (c) => {
    const actor = c.get("actor");
    return c.json({ actor: actor.kind });
  });
```

See [Request middleware](/en/docs/server/middleware) for the complete router
order.

## Accepted credentials

An explicit `Authorization: Bearer` credential takes precedence over the
browser cookie. A `cld_<prefix>_<secret>` bearer is resolved as an API key. Any
other bearer is checked first as a session credential and then as an OAuth
access token. Without a bearer, Cloud uses the `session_token` cookie. An
invalid explicit bearer does not silently fall back to the cookie.

| Credential | Typical caller | Actor |
| --- | --- | --- |
| Session cookie | Browser | User |
| Personal API key | CLI or personal automation | Service account with delegated user |
| Resource API key | Integration bound to one resource | Resource-bound service account |
| OAuth authorization-code token | App acting for a user | User |
| OAuth client-credentials token | Service integration | Resource-bound service account |

All branches produce the same `actor` and `accessSubject` contract.

Operators can disable Guest, local Login or FreeIPA account access separately
from login-page visibility. Cloud rechecks the category on user-bound
authentication, including existing credentials. See
[Account types and sign-in](/en/docs/operations/account-categories) for the
scope and recovery options.

For a framework-owned internal capability request, Core replaces the incoming
credential with a short-lived `cloud-invocation+jwt`. Applications do not parse
that JWT. Cloud verifies its exact target and operation, reloads the current
principal, and exposes the same `actor` and `accessSubject` values to the
provider. Optional `actor.delegation` records the calling app, original
credential kind, and invocation ID for audit context; it grants no permission.

## Use actor and access subject

Every authenticated request exposes:

```ts
const actor = c.get("actor");
const accessSubject = c.get("accessSubject");
```

`actor` identifies the credential that acted:

```ts
type RequestActor =
  | {
      kind: "user";
      user: User;
    }
  | {
      kind: "service_account";
      serviceAccount: ServiceAccount;
      delegatedUser: User | null;
      scopes: string[];
      credentialId?: string | null;
      credentialExpiresAt?: string | null;
    };
```

Use it for audit records, credential scope caps, expiry, and exact resource
binding.

`accessSubject` identifies whose grants apply:

```ts
type AccessSubject =
  | {
      type: "user";
      userId: string;
      delegatedByServiceAccountId?: string | null;
    }
  | { type: "service_account"; serviceAccountId: string };
```

| Caller | Actor | Access subject |
| --- | --- | --- |
| Session or authorization-code token | User | User |
| Personal API key | Service account with delegated user | User |
| Resource API key or client credentials | Resource-bound service account | Service account |

A delegated credential uses only its user's grants. Do not merge them with
service-account grants.

## Get a user only when required

Display names, avatars, and roles require a user:

```ts
import {
  expectUserBackedActor,
  userFromActor,
} from "@k2b/cloud/server";

const optionalUser = userFromActor(c.get("actor"));
const user = expectUserBackedActor(c);
```

Use `expectUserBackedActor()` only after a user-backed
[route policy](/en/docs/identity/route-policies).

For an API route, apply `auth.requireRole("authenticated")` before
`auth.requireUser()`. See
[Route policies](/en/docs/identity/route-policies#require-a-user-backed-actor)
for the response behavior.

> **Authorize with the access subject.**
>
> A resource-bound service account has no user. Code based on a request user
> rejects valid machine credentials.
>
> Do not authorize from `User.memberofGroupIds`. It is display metadata. Cloud
> resolves direct and nested memberships from the authoritative tables.

## Browser sessions

Core stores a signed session token in the `session_token` cookie. Cloud resolves
current account status and permissions on authenticated requests rather than
trusting roles or grants embedded in a token.

The cookie is:

- HTTP-only;
- `SameSite=Lax`;
- secure outside development;
- valid for the configured `user.session.expiry_hours`.

Signing out removes the current session. Revoking all sessions for a user
invalidates every older session.

After credential verification, Core completes browser sign-in through
`/auth/continue`. If the account has not accepted the terms yet, the new session
cannot authorize application requests until the user confirms there. This
applies to every browser sign-in method; applications do not collect consent
themselves. See [First use](/en/docs/accounts#before-your-first-use).

Revocation takes effect without waiting for the token to expire. OAuth grants,
API credentials and background mandates have separate lifecycles; signing out
of the browser does not revoke them.

An application should not read the cookie value or use `sessionToken` as a
domain identifier.

The browser session JWT is not a delegation credential. Background work and
application-to-application calls use operation-bound invocation credentials;
they must not persist or replay a browser cookie.

## Bearer authentication

Send API keys and OAuth access tokens in the standard header:

```http
Authorization: Bearer <token>
```

An API key is stored as a hash. The raw value is returned only when the key is
created.

OAuth access tokens must have:

- the deployment issuer;
- the `cloud` audience;
- `token_use: "access"`;
- a valid active or grace-period signing key.

Applications do not verify these claims themselves.

## Authentication does not grant resource access

Credential scopes can reduce a resource permission. They cannot create one.

Route middleware decides whether the caller may enter. The domain service must
still enforce the resource grant, machine binding, and credential scope.
[Resource authorization](/en/docs/identity/authorization) defines that check.

## Authentication failures

The default middleware response is:

| Condition | Status | Body |
| --- | --- | --- |
| No valid credential | `401` | `{ "message": "Authentication required" }` |
| Valid caller without the required policy | `403` | `{ "message": "Insufficient permissions" }` |

`auth.requireUser()` has a narrower response because it checks for a
user-backed actor. It returns `403` with
`{ "message": "Self-service endpoints require a user-backed actor", "code": "FORBIDDEN" }`.
Use it after an authentication policy, not instead of one.

SSR routes can redirect instead. See
[Route policies](/en/docs/identity/route-policies).
