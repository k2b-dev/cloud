---
title: Request identity
navTitle: Request identity
section: Identity and access
order: 310
description: Resolve Cloud credentials into the actor and access subject used by an application.
tags: [identity, authentication, sessions, middleware]
updated: 2026-10-19
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

Without a `pwa_session` cookie every request behaves as described above. The
auth middleware applies the fallback of the last row. A WebSocket or stream
handler that authenticates the token itself reads it with
`await auth.session.resolveToken(c)`, which applies the same fallback.
`auth.session.getToken(c)` only picks the cookie and does not check it. Never
read a session cookie by name.

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
      sessionKind?: "app"; // the mobile app's session, see below
    }
  | {
      kind: "service_account";
      serviceAccount: ServiceAccount;
      delegatedUser: User | null;
      scopes: string[];
      credentialId?: string | null;
      oauthClientId?: string | null;
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

## Retain service-account authority

An application that issues its own transfer or editor capability can retain
`credentialId` for an API key, or `oauthClientId` for OAuth, together with
`credentialExpiresAt`, the service-account ID and the captured scopes. These
identifiers contain no bearer secret. Protect their provenance in server-side
storage or an application-signed payload; never retain the original credential.
Cloud forwards these references through internal invocations too.

For an OAuth reference, call `isServiceAccountOAuthAuthorityCurrent` from
`@k2b/cloud/services` with `{ serviceAccountId, clientId, expiresAt }` before
each authorized operation. It checks expiry and the same live client, account
and delegated-user policy as OAuth authentication. It grants no domain access:
reload resource permissions and keep the captured scopes as an upper bound.
Inside a SQL transaction, pass its connection as `{ query }` in the optional
second argument so revalidation uses that transaction's current client and policy state.
For an API key, also check the current credential's status, account binding,
expiry and scope cap through `serviceAccountCredentials.getOverview`.

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

Successful browser sign-ins also set a separate 90-day
[browser cookie](/en/docs/operations/sign-in-locations#browser-cookie) that is
kept on sign-out; it does not authenticate requests.

Signing out of one browser ends only that session. Signing an account out
everywhere with `auth.session.revokeAllForUser` invalidates every older session,
ends its OAuth sign-ins and access tokens at the next request, and revokes its
paired [sign-in devices](/en/docs/operations/app-approval#what-revocation-ends).
It returns the account's new authentication epoch.

Changing a FreeIPA password in Cloud ends the person's other sign-ins. This
applies to profile password changes, administrator resets, reset links, and
expired or temporary password changes at sign-in. Browser sessions, OAuth
sign-ins (including the command line, MCP and connected apps), pending sign-in
completions, and mobile app phones end. API keys, passkeys and background
mandates stay valid.

A password sign-in is bound to the account's authentication epoch read before
FreeIPA checks the password. If a password change or sign-out everywhere lands
between that read and session creation, `POST /api/auth/login` answers `409` and
the person signs in again. An account that is synced into Cloud only after that
read gets no session either; the next attempt signs in. Expired-password and
reset-link flows likewise bind their new browser session to the epoch after
their own sign-out and answer `409` if it changes before session creation. Their
password stays changed, so the sign-in page replaces the form with a prompt to
sign in with the new password and keeps where to go afterwards.

The platform operation `auth.session.endOtherSignIns(userId, { keep, reason })`
owns this behavior. `reason` is `password_change`, `password_reset` or
`sign_out_others`. It advances the account's authentication
epoch and revokes its mobile app phones, with an audit entry per phone. Cloud
Login phones stay paired. A reset link calls `revokeAllForUser` before the
password changes, so that flow also unpairs Cloud Login phones. If that fails,
the password stays unchanged and the person requests a new reset link. Because
the old password works until FreeIPA has changed it, the flow calls
`revokeAllForUser` again after the change; that also ends a sign-in or phone
added in the meantime. If that second call fails, the flow issues no browser
session and answers `500`: the password changed, and the person requests a new
reset link to finish. Every attempt uses up the reset link, so Core's reset form
offers **Request a new reset link** next to any failure.
If the session signer cannot be prepared or stays inactive, the operation still
ends every sign-in and keeps no browser.

`keep` is the browser sign-in that the request authenticated, `{ sid, authEpoch }`
as returned by `auth.browserSignIn(c)`. Only a current, active web session of the
account whose epoch is still current can be kept, so a request that a concurrent
change already ended keeps nothing. The kept browser moves to a new session ID
with the same sign-in time and expiry; its old family is revoked. It stays tied
to the Cloud Login device that approved its sign-in, so removing that device can
still end it. The epoch change also ends pending device pairing and removal
requests. The operation returns
`{ kept: { token, expiresAt } | null }`; the caller sets the reissued cookie with
`auth.session.setWebCookie(c, token, expiresAt)`. `kept` is null when no browser was
kept: no `keep`, no current active web session of the account, or signing
failed after the change. That browser must sign in again. Old copies of its
cookie stop working, and keeping it does not count as a recent sign-in.

`POST /api/me/password` keeps the current browser session this way and returns
`200 { message, signInAgain }`. If the browser could not be kept, `signInAgain`
is true and the stale cookie is cleared. A password change made through OAuth
keeps no session and returns `signInAgain: true`, so the caller signs in again.
An administrator reset keeps none; the reset-link and expired-password flows
issue a new browser session after ending the old sign-ins.

If the password changed but ending other sign-ins failed before commit, the
profile endpoint answers `500` with `SIGN_OUT_OTHERS_FAILED` and says that the
password changed. The expired-password flow `POST /api/auth/change-expired-password`
still issues the new browser session and answers `200` with
`signOutOthersFailed: true`; on success it is `false`.
`POST /api/auth/password-reset/complete` returns the same field, which is `false`
whenever it issues a session. An
administrator reset returns no temporary password when ending the sign-ins
fails, so the administrator resets again.
Retry with `POST /api/me/sign-ins/sign-out-others`, which uses the same operation
and rotates the current browser cookie. It requires a web browser session:
OAuth and API keys receive `403 BROWSER_SIGN_IN_REQUIRED`, and mobile app
sessions receive `403 FORBIDDEN`. Core's profile dialog and both sign-in page
forms offer this retry and keep it in the address (`signOutOthers=retry`,
without a used reset token) until it succeeds; the profile page also drops it
when the person closes the retry. A reload asks again. When the retry answers
`401` or `403`, the page has no browser sign-in; the person signs in or confirms
the terms, and the page asks again afterwards.
Success returns `200 { message, signInAgain }`
and records one `auth.session.sign_out_others` audit event in the person's
account activity; if this browser could not be kept, `signInAgain` is true and
its stale cookie is cleared. Failure before commit returns
`500 SIGN_OUT_OTHERS_FAILED`.

After credential verification, Core completes browser sign-in through
`/auth/continue`. If the account has not accepted the terms yet, the new session
cannot authorize application requests until the user confirms there. This
applies to every browser sign-in method; applications do not collect consent
themselves. See [First use](/en/docs/accounts#before-your-first-use).

Revocation takes effect without waiting for tokens to expire. API keys and
background mandates keep their own lifecycles.

An application should not read the cookie value or use `sessionToken` as a
domain identifier.

The browser session JWT is not a delegation credential. Background work and
application-to-application calls use operation-bound invocation credentials;
they must not persist or replay a browser cookie.

## Confirm new access in a browser

New passkeys and personal API keys require a browser sign-in from the last ten
minutes. Cloud checks the session again in the transaction that stores the key
or passkey, so starting registration before the window ends is not enough.

OAuth access tokens, personal API keys, background mandates, and mobile app
sessions cannot create these credentials. The account API answers `403` with
`BROWSER_SIGN_IN_REQUIRED`. Create API keys in **Developer → API keys**
(`/me/developer`) and passkeys in **Sign-in → Passkeys** using a browser.

An older or no longer valid browser sign-in returns `403` with
`REAUTHENTICATE`. Sign in again with the same account, then repeat the action.
These error codes stay the same in every language.

New OAuth refresh-token families require the same recent browser confirmation;
see [OAuth clients and flows](/en/docs/identity/oauth). Rotating an existing
refresh token does not require another browser sign-in.

## App sessions (preview)

> **Preview:** the mobile app is not released yet. This contract may still
> change until it is, without counting as a breaking change.

A phone pairs with the [mobile app](/en/docs/frontend/layout-and-navigation#use-the-responsive-profile-menu)
through `/me/app`; it never sees a password. A paired phone holds two
credentials:

- a **device key** in the HTTP-only `pwa_device` cookie with the path
  `/pwa/_auth`, so only Core receives it. It stays valid while the phone is used
  at least every 150 days and changes on every renewal;
- an **app session** in the HTTP-only `pwa_session` cookie with the path `/`,
  valid for 24 hours. It is an ordinary Cloud session, validated by every
  application like a web session. Core renews it with the device key.

An app session resolves to the same `accessSubject` and
`credentialKind: "session"` as a web session. `c.get("sessionKind")` is
`"app"`, the user actor carries `sessionKind: "app"`, and
`auth.isAppSession(c)` returns `true`. The kind comes from the session record,
not from the cookie name. Invocations made for an app session keep the marker,
also from Assistant turns started in the app. The marker travels in the
invocation token, and an application built on an older `@k2b/cloud` rejects
such tokens, so update applications before people use the mobile app.

App sessions never carry the installation `admin` role, also not in calls to
other applications. A service that reloads the user to confirm the role must
treat the request actor's roles as the upper bound and never add `admin` back.

The mobile app cannot create access that would keep working after the phone
is removed:

- passkeys and personal API keys follow the
  [browser confirmation rule](#confirm-new-access-in-a-browser) above and return
  `403` with `BROWSER_SIGN_IN_REQUIRED`;
- Core's account API answers `403` with
  `{ "code": "FORBIDDEN", "message": "Use Cloud on the web for this." }` for
  password changes, account deletion, SSH public keys, background mandates,
  and browser push endpoints;
- resource API keys of Spaces, Notebooks, Contacts, Pulse, and Venue, scheduled
  Assistant tasks (create, change, resume), and Mail incoming automations with
  Spaces steps answer the same `403`;
- OAuth treats an app session as no session: `/oauth/authorize` leads to
  sign-in, and the consent and device pages ask the person to use the web;
- Cloud Login pairing management and pairing another phone answer
  `FORBIDDEN` in their own error format.

Ordinary work stays available, including profile changes, sharing, and
read-only calendar feed links. In your application, guard every route that
creates such authority with `auth.rejectAppSession`, which answers the `403`
above. In services and capabilities, check `isAppSessionActor(actor)` from
`@k2b/cloud/server`.

A phone's sessions end when the person removes it in `/me/app` or signs out of
the app, when an administrator removes it, when a password changes or
`revokeAllForUser` runs, when the account expires or is deleted, and after 150
days without use. A disabled
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

A personal API key can have models-only access (`access: "models"`). Such a
key fails authentication on every route except the
[OpenAI-compatible endpoint](/en/docs/ai/openai-compatible-api); it cannot
reach Cloud tools or account self-service. Applications on an older
`@k2b/cloud` version reject such a key as invalid.

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
