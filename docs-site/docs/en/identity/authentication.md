---
title: Request identity
navTitle: Request identity
section: Identity and access
order: 310
description: Resolve Cloud credentials into the actor and access subject used by an application.
tags: [identity, authentication, sessions, middleware]
updated: 2026-10-03
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
| App session cookie (preview) | The installed [mobile app](#app-sessions-preview) | User |
| Personal API key | CLI or personal automation | Service account with delegated user |
| Resource API key | Integration bound to one resource | Resource-bound service account |
| Standalone API key | Integration or agent with its own identity | Standalone service account |
| OAuth authorization-code token | App acting for a user | User |
| OAuth client-credentials token | Service integration or agent | Resource-bound or standalone service account |

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

### Which session a request uses

A browser can hold the web session (`session_token`) and, on a paired phone,
the mobile app's session (`pwa_session`). Cloud picks one per request:

| Request | Credential |
| --- | --- |
| Anything below `/pwa/` except Core's `/pwa/_auth` (documents, iframes, fetches, WebSockets) | `pwa_session` only, and only an app session |
| Navigation elsewhere (`Sec-Fetch-Mode: navigate`: documents, iframes, form posts) | Bearer as before, otherwise `session_token` only |
| Any other request (fetch, images, WebSockets, requests without fetch metadata) | Bearer as before, otherwise `session_token` when it is valid, otherwise `pwa_session` |

Without a `pwa_session` cookie every request behaves as described above. A
WebSocket or stream handler reads the credential through
`auth.session.getToken(c)` or the auth middleware, never from a cookie by name.

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
| Standalone API key or client credentials | Standalone service account (`standalone` or `agent`) | Service account |

A delegated credential uses only its user's grants. Do not merge them with
service-account grants.

A standalone service account has no user and no resource binding. Read
`serviceAccount.kind` before treating a userless actor as resource-bound; see
[Standalone service accounts and agents](/en/docs/identity/service-accounts).

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
with `auth.session.revokeAllForUser` invalidates every older session and also
revokes the account's paired
[sign-in devices](/en/docs/operations/app-approval#what-revocation-ends).

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

## App sessions (preview)

> **Preview:** the mobile app is not released yet. This contract may still
> change in a minor release.

A phone pairs with the [mobile app](/en/docs/frontend/layout-and-navigation#use-the-responsive-profile-menu)
through `/me/app`; it never sees a password. A paired phone holds two
credentials:

- a **device key** in the HTTP-only `pwa_device` cookie with the path
  `/pwa/_auth`, so only Core receives it. It stays valid while the phone is used
  at least every 150 days and changes on every renewal;
- an **app session** in the HTTP-only `pwa_session` cookie with the path `/`,
  valid for 24 hours. It is an ordinary Cloud session, validated by every
  application like a web session. Core renews it with the device key.

An app session resolves to the same `actor`, `accessSubject` and
`credentialKind: "session"` as a web session. `c.get("sessionKind")` is
`"app"`, and `auth.isAppSession(c)` returns `true`. The kind comes from the
session record, not from the cookie name.

The mobile app cannot create authority that outlives the phone:

- app sessions never carry the installation `admin` role, also not in calls to
  other applications;
- passkeys, API keys, password changes, account deletion, background mandates,
  OAuth grants, Cloud Login devices and browser push endpoints answer `403`
  with `{ "code": "FORBIDDEN", "message": "Use Cloud on the web for this." }`.

A phone's sessions end when the person removes it in `/me/app` or signs out of
the app, when an administrator removes it, when `revokeAllForUser` runs, when
the account expires or is deleted, and after 150 days without use. A disabled
account category pauses the phone until it is enabled again. Signing out of the
web does not end the app.

On Android, Chrome and the installed app share cookies. Web pages in Chrome
never use the app session, but fetches can: when Chrome holds a valid web
session of another account, those fetches run as that account, and the app
shows a notice.

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

## Validate a user-scoped stream

For a stream that only needs the current session's user ID, use
`auth.session.authenticateUserId(token)`. It returns the ID or `null`, while
still checking the signed token, durable session family, signing-key revocation,
auth epoch, legal consent, account category, and account expiry. It does not
load groups, roles, IPA profile data, or app-bar preferences. An expired account
revokes its sessions just as full session authentication does.

This is a fresh database check, not a cached authorization decision. It does
not authorize access to a resource; keep the resource's permission check in its
own service. Normal HTTP routes continue to use the authentication middleware.
