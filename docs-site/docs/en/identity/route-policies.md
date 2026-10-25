---
title: Route policies
navTitle: Route policies
section: Identity and access
order: 318
description: Choose who may enter an API or SSR route before the service checks its resource.
tags: [identity, middleware, routes, policies]
updated: 2026-09-04
---

# Route policies

A route policy decides which kind of caller may reach a handler.

It does not decide whether that caller may read or change a resource.

## Choose a policy

```ts
import { auth } from "@k2b/cloud/server";
```

| Policy | Allows |
| --- | --- |
| `auth.requireRole("authenticated")` | Any resolved actor |
| `auth.requireRole("admin")` | A user-backed actor with the `admin` role |
| `auth.requireRole("admin", "group-manager")` | Either listed role |
| `auth.requireRole("*")` | Authenticated or anonymous requests |
| `auth.requireRole("anonymous")` | Anonymous requests only |
| `auth.requireUser()` | Any actor with a user behind it |
| `auth.requireAccount({ provider, profile })` | A matching user-backed account |

Role arguments use OR logic.

Every authentication policy caps OAuth requests using methods other than GET,
HEAD, or OPTIONS: the token must have `write` or `admin` scope. Otherwise,
Cloud returns `403 FORBIDDEN` before the handler runs. This applies to ordinary
resource routes, administrative routes, and optional authentication alike.
Sessions and personal API keys keep their existing behavior. Resource-bound
API keys retain the scope checks defined by their application.

Mount administrative routes behind `auth.requireRole("admin")`. The role and
OAuth scope checks are independent: a scope never grants an administrator role
or resource permission. Capability Actions and write streams also require
`write` or `admin`, including when forwarded to another application.

Declare a read-only POST operation explicitly on its route:

```ts
const routes = new Hono<AuthContext>()
  .use(auth.requireRole("authenticated"))
  .post("/search", auth.readOnly, searchHandler)
  .post("/items", createItemHandler);
```

`auth.readOnly` requires `read` or `admin` for OAuth callers. It permits the
transport method; the handler still checks resource permissions and must not
change resources, permissions, credentials, or queued work. Use it for queries,
previews, and downloads. Register it as the first handler on a concrete method and route, never
through `.use()` or on a wildcard path. Nested `.route()` mounts are supported.

Hono represents both `.use()` middleware and `.all()` handlers as ALL routes.
An unmarked ALL handler between authentication and the endpoint therefore keeps the
write requirement, including one interleaved after the read-only declaration. Put common middleware before authentication, or explicitly
mark middleware that only reads, validates, or authorizes with
`auth.readOnlyMiddleware(handler)`. This annotation permits a later read-only endpoint;
it never makes a mutation endpoint read-only. Do not annotate middleware that changes
resource data or creates authority. The read-only endpoint must return its response;
it must not fall through with `next()` into an unrelated handler.

GET, HEAD, and OPTIONS handlers must be read-only. A legacy GET endpoint that
creates authority must explicitly require `auth.requireOAuthScope("write", "admin")`.

`authenticated` includes resource-bound service accounts. Add
`auth.requireUser()` when the handler needs a user.

```ts
const routes = new Hono<AuthContext>()
  .use("*", auth.requireRole("authenticated"))
  .use("*", auth.requireUser())
  .get("/profile", (c) => {
    const user = expectUserBackedActor(c);
    return c.json({ name: user.displayName });
  });
```

## Require a user-backed actor

Apply `requireRole("authenticated")` before `requireUser()` when a handler needs
a profile, display name, roles, or another user-owned value.

| Request | Stopped by | Default response |
| --- | --- | --- |
| No valid credential | `requireRole("authenticated")` | `401 Authentication required` |
| Resource-bound service account | `requireUser()` | `403 Self-service endpoints require a user-backed actor` |
| User or user-delegated credential | Neither | Continue to the handler |

`requireUser()` alone is not an authentication policy. It returns `403` for
every request without a user, including a request without a valid credential.

## Use computed roles

Roles describe a user at the platform level. Use them for coarse route access,
not resource permissions.

Cloud computes:

| Role | Meaning |
| --- | --- |
| `user` or `guest` | Account profile |
| `ipa` or `local` | Account provider |
| `ipa/user`, `ipa/guest`, `local/user`, `local/guest` | Provider and profile |
| `admin` | Platform administrator |
| `group-manager` | Manages at least one group |

Guest profiles never receive `admin` or `group-manager`.

Roles come from account state and authoritative group membership. They are not
an editable string array.

Concrete roles require a user-backed actor. A resource-bound service account
can satisfy `authenticated`, but it has no user roles.

## Protect API routes

API routes normally use JSON rejections:

```ts
const api = new Hono<AuthContext>()
  .use("*", auth.requireRole("authenticated"))
  .get("/:id", async (c) => {
    return respond(c, inventory.read({
      id: c.req.param("id"),
      actor: c.get("actor"),
      accessSubject: c.get("accessSubject"),
    }));
  });
```

The default status is `401` when no credential resolves and `403` when the
caller fails the policy.

## Protect SSR routes

Use the owning application's SSR rejection policy for browser pages:

```ts
import { ssr } from "../config";

const pages = new Hono<AuthContext>().get(
  "/:id",
  auth.requireRole("user", ssr.access),
  ...inventoryPage,
);
```

`ssr.access` redirects anonymous or expired sessions to login with a safe local
`redirectTo`, including the query string. An authenticated caller who fails the
policy receives a localized HTML `403`, not another login redirect. Both
responses use `Cache-Control: private, no-store`.

The router must already have the usual `middleware.runtime()` and
`middleware.settings()` context. Use the same option for account policies:
`auth.requireAccount({ provider: "ipa", profile: "user", ...ssr.access })`.
For any user-backed actor, combine
`auth.requireRole("authenticated", ssr.access)` with
`auth.requireUser(ssr.access)`.

Resource checks still belong to the service. Render their terminal page errors
with [ssr.error()](/en/docs/frontend/ssr-pages-and-routing#render-page-errors).
Do not use page responses on JSON APIs, downloads, or protocol endpoints.

Redirect rejected callers to a fixed path when needed:

```ts
auth.requireRole("admin", auth.redirect("/"));
```

Explicit `auth.redirect()` and `auth.redirectToLogin` overrides redirect for
both rejection reasons. A custom `onReject(c, reason)` may return a response,
redirect path, or a promise of either. Prefer `ssr.access` for ordinary pages
to avoid a forbidden-page/login loop.

## Match an account type

Use `requireAccount()` only when provider or profile changes the route itself:

```ts
auth.requireAccount({ provider: "ipa" });
auth.requireAccount({ provider: "local", profile: "user" });
```

For ordinary application access, prefer roles and resource permissions. An
account provider is not a resource grant.

Every user has one provider and profile:

| Provider | Profile | Meaning |
| --- | --- | --- |
| `ipa` | `user` or `guest` | FreeIPA-managed account |
| `local` | `user` or `guest` | Cloud-managed account |

Provider identifies who owns the account record. It does not identify the
login method.

## Allow optional identity

`auth.requireRole("*")` tries to resolve a credential and then continues.
Anonymous requests have no actor or access subject.

```ts
const actor = c.get("actor");
const accessSubject = actor ? c.get("accessSubject") : null;
```

See [Public and anonymous access](/en/docs/identity/public-and-anonymous-access)
before exposing a route.

## Repeat resource checks

Route middleware is defense in depth. The service still checks the resource.

SSR pages often call services directly instead of calling their JSON route.
They must therefore call the same permission-aware service themselves.

## Keep OpenAPI metadata separate

`requiresAuth`, `requiresAdmin`, and related OpenAPI helpers describe security
requirements. They do not run middleware.

Pair the metadata with the real route policy. See
[Typed HTTP APIs](/en/docs/server/http#publish-openapi).
