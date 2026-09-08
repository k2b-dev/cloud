---
title: Identity and access
navTitle: Overview
section: Identity and access
order: 300
description: Separate credential, route, and resource decisions in an application.
tags: [identity, authentication, authorization]
updated: 2026-08-12
---

# Identity and access

Cloud owns accounts, sessions, credentials, roles, groups, and permission
primitives so every installed application receives the same caller model. Your
application remains the authority for its own resources and domain operations.

That split matters most for independently deployed applications: they can
trust Cloud to establish an identity without giving Cloud enough information
to decide whether that identity may read or change an app-owned resource.

Keep three boundaries separate on every request:

| Boundary | Question | Owner |
| --- | --- | --- |
| Authentication | Is the credential valid, and who acted? | Cloud authentication |
| Route policy | May this kind of caller enter the route? | Application middleware |
| Resource authorization | May this caller perform this operation on this resource now? | Application service |

A valid login does not grant access to every resource. A route role does not
replace a resource permission check. Every entry point that reaches the same
domain operation—HTTP, SSR, capability, CLI, or background work—should converge
on the same permission-aware application service.

## Continue by task

| Task | Page |
| --- | --- |
| Understand the actor and access subject | [Request identity](/en/docs/identity/authentication) |
| Prepare local Linux attributes alongside FreeIPA | [Linux identities](/en/docs/operations/linux-identities) |
| Decide who may enter a route | [Route policies](/en/docs/identity/route-policies) |
| Check access to one domain resource | [Resource authorization](/en/docs/identity/authorization) |
| Create a credential for one resource | [Resource API keys](/en/docs/identity/resource-api-keys) |
| Integrate an OAuth client | [OAuth](/en/docs/identity/oauth) |
| Allow a route without a session | [Public access](/en/docs/identity/public-and-anonymous-access) |

OAuth and API keys change how Cloud establishes the actor; they do not create a
second authorization model. Public access likewise opens only the route and
resources the application explicitly makes public.
