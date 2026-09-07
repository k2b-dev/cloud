---
title: API Docs
navTitle: API Docs
section: Platform
order: 340
description: Live OpenAPI references from the Cloud apps that publish an API contract.
tags: [api-docs, openapi, cli]
updated: 2026-09-07
---

# API Docs

API Docs collects the OpenAPI references published by currently registered
Cloud apps. Use it to find an operation, read its request and response schemas,
or retrieve a live contract for tooling without searching application source.

## Use API Docs

- Choose the app that owns the data or action you want to integrate.
- Search by operation name, route, field, or schema.
- Open an operation to inspect its method, path, parameters, request body,
  responses, and declared authentication.
- Compare reusable schemas before creating a client or mapping data.
- Retrieve the raw OpenAPI document when another tool needs the live contract.

## Understand the API Docs model

| Resource or surface | Responsibility |
| --- | --- |
| API source | One registered app and the OpenAPI URL it publishes |
| Operation | An HTTP method and path with parameters, schemas, and responses |
| Schema | A reusable request or response shape from the owning app |
| Security metadata | The credentials an operation declares it accepts |
| Source selector | The browser control for switching between app references |

Only apps that publish a safe OpenAPI source appear in API Docs. The list
changes with the live app registry, so a missing app may be offline or may not
publish an OpenAPI contract.

## How API Docs fits Cloud

API Docs aggregates contracts; it does not own the operations or merge their
schemas into one API. Each app remains responsible for the accuracy of its own
reference. Published security metadata describes accepted credentials but does
not enforce access, and seeing an operation does not grant permission to call
it.

## Find detailed product help

Open **Help** inside API Docs for source selection, operation lookup, schemas,
authentication metadata, and CLI reference. Developers can read
[Typed HTTP APIs](/en/docs/server/http),
[Define an application](/en/docs/build/define-app), and
[Route policies](/en/docs/identity/route-policies) for publishing and enforcing
an application's API contract.

## Search API Docs from the terminal

The native CLI module uses the same live source list as the browser app:

```bash
cld api-docs list --json
cld api-docs search "account request" --app accounts --json
```

Run `cld api-docs help` for operation lookup and raw specification output. A
query can only return contracts that the current deployment is publishing.

## Deployment requirements

See [Deployment requirements](/en/docs/operations/deployment-requirements) for
this app’s startup prerequisites, optional integrations, configuration and
functional checks.
