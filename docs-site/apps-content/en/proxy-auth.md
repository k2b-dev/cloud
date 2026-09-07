---
title: Proxy Auth
navTitle: Proxy Auth
section: Platform
order: 330
description: Traefik ForwardAuth clients that protect external services with Cloud groups.
tags: [proxy-auth, forward-auth, traefik]
updated: 2026-09-07
---

# Proxy Auth

Proxy Auth protects an external service through Traefik ForwardAuth. An
administrator creates one client for a protected service or route, chooses the
Cloud groups that may enter, and places the generated verify URL in Traefik.

## Use Proxy Auth

- Create a separate client for each service or route with its own access rule.
- Allow one or more purpose-specific groups, including users who inherit
  membership through nested groups.
- Copy the generated verify URL into a Traefik ForwardAuth middleware.
- Forward the returned identity headers to an upstream that needs the signed-in
  user and effective groups.
- Test the protected route while logged out, as an allowed user, and as a user
  outside every allowed group.

## Understand the Proxy Auth model

| Resource or result | Responsibility |
| --- | --- |
| Client | One protected external service or route |
| Allowed group | A local or FreeIPA group whose effective members may enter |
| Verify URL | The endpoint Traefik calls before forwarding the original request |
| Login redirect | The result for a request without a valid Cloud session |
| Forbidden result | The result for a signed-in user outside the allowed groups |
| Identity headers | User, email, and effective groups returned after an allowed check |

The verify URL is middleware configuration, not a link that users should open.
Users visit the protected service; Traefik performs the verification request.

## How Proxy Auth fits Cloud

Cloud authenticates the browser session and resolves effective group
membership. Proxy Auth applies the client's group gate. Traefik calls the
verify endpoint and forwards the original request only after an allowed result.
The protected service remains a separate deployment and owns its own behavior
and data.

## Find detailed product help

Open **Help** inside Proxy Auth for client setup, the Traefik middleware,
forwarded headers, and diagnosis of login redirects, forbidden users, or
invalid verify URLs. Review group membership in Accounts. Developers can read
[Request identity](/en/docs/identity/authentication) and
[Resource authorization](/en/docs/identity/authorization) for the surrounding
identity model.

## Inspect the Proxy Auth API from the terminal

Proxy Auth does not register a dedicated CLI module. Its published OpenAPI
reference can still be inspected through API Docs before building an admin
integration:

```bash
cld api-docs operations proxy-auth --method GET --json
cld api-docs show proxy-auth GET /api/proxy-auth --json
```

Run `cld api-docs help` for reference lookup. The API requires administrator
access and uses the same validation and authorization as the Proxy Auth page.

## Deployment requirements

See [Deployment requirements](/en/docs/operations/deployment-requirements) for
this app’s startup prerequisites, optional integrations, configuration and
functional checks.
