---
title: OAuth
navTitle: OAuth
section: Platform
order: 320
description: OAuth 2.0 and OpenID Connect clients, callbacks, scopes, access rules, and secrets.
tags: [oauth, oidc, identity]
updated: 2026-09-07
---

# OAuth

OAuth lets administrators connect external applications to Cloud sign-in. It
provides OAuth 2.0 and OpenID Connect endpoints and keeps each integration's
callbacks, scopes, access rules, and secret lifecycle separate.

## Use OAuth

- Register one client for each external application and environment.
- Choose a public client for software that cannot keep a secret, or a
  confidential client for a protected server-side application.
- Register exact sign-in and optional logout callback URLs.
- Limit the scopes, account profiles, users, and groups that may authorize the
  client.
- Rotate a confidential-client secret when it is exposed, and delete clients
  that should no longer start authorization flows.

## Understand the OAuth model

| Resource or setting | Responsibility |
| --- | --- |
| Client | One external application with a stable client id |
| Redirect and logout URIs | Exact destinations accepted during sign-in and logout |
| Public or confidential type | Whether the client can hold a secret |
| Scope and audience | Claims and token targets the client may request |
| Access rule | Allowed profiles or an explicit set of users and groups |
| Service-account binding | Optional machine identity for client-credentials flows |

New and regenerated client secrets are shown once. Store them in the external
application's secret store, not in source code, browser bundles, screenshots,
or documentation.

## How OAuth fits Cloud

OAuth turns a successful flow into the same request identity Cloud uses for
browser sessions and API keys. Client rules decide who may authorize and which
scopes may be requested. They do not grant access to an application's records;
the owning service still enforces resource permissions.

## Find detailed product help

Open **Help** inside OAuth for client setup, endpoint discovery, redirect
matching, scopes, claims, access rules, and troubleshooting. Developers can
read [OAuth clients and flows](/en/docs/identity/oauth),
[Request identity](/en/docs/identity/authentication), and
[Resource authorization](/en/docs/identity/authorization) for token and
application authorization contracts.

## Inspect OAuth clients from the terminal

OAuth provides a native CLI module. List clients first, then use an exact id,
client id, or unambiguous name for a detail lookup:

```bash
cld oauth clients list --json
cld oauth clients list --search codex --page 1 --per-page 50
cld oauth clients get <client> --json
```

Run `cld oauth help` for the available client operations. Run
`cld oauth clients <command> --help` before creating, updating, deleting, or
rotating a secret.

## Deployment requirements

See [Deployment requirements](/en/docs/operations/deployment-requirements) for
this app’s startup prerequisites, optional integrations, configuration and
functional checks.
