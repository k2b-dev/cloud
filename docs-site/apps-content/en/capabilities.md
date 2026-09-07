---
title: Capabilities
navTitle: Capabilities
section: Platform
order: 350
description: Discover and run the live Queries and Actions published by Cloud applications.
tags: [capabilities, queries, actions, automation]
updated: 2026-09-07
---

# Capabilities

Capabilities is the live catalog of interfaces that Cloud applications expose
to people, scripts, and agents. It shows the Queries and Actions available to
the current account, including their input, output, and execution policy.

## Use Capabilities

- Find which applications publish machine-readable operations right now.
- Inspect an operation before writing a script or connecting an agent.
- Run a Query to read data without changing application state.
- Review the confirmation and authorization policy before running an Action.
- Copy a generated request when another tool needs the same operation.

The catalog is built from registered applications. An application that is
offline, unavailable to the current account, or using an incompatible
capability protocol does not appear as a usable entry.

## Understand the Capabilities model

| Resource | Responsibility |
| --- | --- |
| Application manifest | Names the application's published Queries and Actions |
| Query | Read-only operation with typed input and output |
| Action | State-changing operation with an explicit execution policy |
| Schema | Describes accepted input and the result returned by the application |
| Invocation result | Carries the application result or a structured failure |

The live manifest is the reference for operation IDs and schemas. Do not copy
its complete contents into long-lived documentation or prompts.

## How Capabilities fits Cloud

The Capabilities app owns discovery, inspection, and the invocation workspace.
Each publishing application still owns its operation, domain data,
authorization checks, and result. Cloud supplies the shared capability
protocol, application registry, request identity, and access boundary.

Running an operation through Capabilities does not bypass the provider
application. Queries and Actions use the same authenticated application
contract as other callers.

## Find detailed reference

Open an application and operation inside Capabilities to read its live
description, schemas, policy, and result presentation. Developers can read
[App capabilities](/en/docs/platform/capabilities),
[Resource authorization](/en/docs/identity/authorization), and
[CLI modules](/en/docs/platform/cli-modules) for the shared contracts behind
the catalog.

## Inspect capabilities from the terminal

The generic CLI module reads the same live catalog:

```bash
cld capabilities catalog --json
cld capabilities catalog --limit 25 --json
```

Run `cld capabilities help` for the available operation types. Run
`cld capabilities query --help` or `cld capabilities action --help` before an
invocation; the live manifest remains authoritative for IDs and schemas.

## Deployment requirements

See [Deployment requirements](/en/docs/operations/deployment-requirements) for
this app’s startup prerequisites, optional integrations, configuration and
functional checks.
