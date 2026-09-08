---
title: Public and anonymous access
navTitle: Public access
section: Identity and access
order: 360
description: Expose selected routes without creating another identity or permission model.
tags: [identity, public, anonymous, sharing]
updated: 2026-07-27
---

# Public and anonymous access

Public access needs both an open route and an explicit domain rule.

Opening a route does not make every resource public.

## Allow optional authentication

Use `*` when the same route works for signed-in and anonymous callers:

```ts
import {
  type AuthContext,
  auth,
  respond,
} from "@k2b/cloud/server";
import { Hono } from "hono";

const routes = new Hono<AuthContext>()
  .use("*", auth.requireRole("*"))
  .get("/:id", async (c) => {
    const actor = c.get("actor");
    const accessSubject = actor ? c.get("accessSubject") : null;

    return respond(c, inventory.read({
      id: c.req.param("id"),
      actor: actor ?? null,
      accessSubject,
    }));
  });
```

`requireRole("*")` loads identity when a valid credential is present. It also
allows requests without one.

Anonymous requests have no actor and use `null` as the access subject.

## Allow anonymous callers only

Use `anonymous` for routes such as login pages that should reject an existing
session:

```ts
auth.requireRole("anonymous", auth.redirect("/"));
```

This policy is not a replacement for optional authentication. It rejects
authenticated callers.

## Grant public resource access

A public access entry is:

```ts
const created = await createAccess({
  principal: { type: "public" },
  permission: "read",
});
```

Link the returned access ID to the application resource.

`getEffectivePermission({ subject: null })` matches public entries.

A public grant also matches authenticated callers. Higher direct or group
grants can give a signed-in caller more access.

An `authenticated` principal is different. It matches every authenticated user
or service account, but not an anonymous request.

## Keep the route and grant aligned

Both conditions must pass:

| Route | Resource grant | Result |
| --- | --- | --- |
| Requires authentication | Public | Anonymous caller is rejected by the route |
| Allows anonymous | No public grant | Service returns forbidden |
| Allows anonymous | Public read | Anonymous caller can read |

The service remains the source of truth for the resource.

## Use a share token when access is link-specific

A public principal makes the resource available to everyone who can discover
its ID.

Use a domain share token when access should depend on possession of a link.
The application owns:

- token generation and hashing;
- expiry and revocation;
- the resource operation allowed by the token.

Validate the token in the service before loading protected data.

Do not convert a share token into a Cloud user or session.

## Choose a page prefix

Anonymous HTML needs its own declared route prefix:

```ts
defineApp({
  id: "inventory",
  routes: [
    "/api/inventory",
    "/app/inventory",
    "/share/inventory",
  ],
});
```

`/public/<app-id>` is reserved for framework-owned static assets. A page
registered there is unreachable.

Use `/share/<app-id>` for anonymous-facing pages unless the product has a more
specific public route.

## Protect SSR data

An anonymous SSR page calls services directly.

It must pass either:

- `null` to the shared permission resolver for a public grant; or
- the validated domain share token to a share-aware service.

Do not render a resource before that check.

## Check responses

Avoid revealing private resource existence through different error detail.

For a share link, use a single unavailable state when the resource is missing,
the token is invalid, the token expired, or access was revoked.

Continue with [Resource authorization](/en/docs/identity/authorization).
