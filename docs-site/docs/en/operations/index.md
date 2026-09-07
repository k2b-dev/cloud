---
title: Operations
navTitle: Overview
section: Operations
order: 1100
description: Develop and operate an independent Cloud application through the shared gateway.
tags: [operations, deployment, runtime]
updated: 2026-09-07
---

# Operations

Cloud runs each application as an independent Bun service.

The gateway is the only public entry point. Applications, Postgres, Valkey, and
supporting services share a private network.

For a third-party app, the normal unit of ownership is its own repository,
version, image, and release cycle. The public application contract is the same
inside the Cloud monorepo, but repository scripts and workspace aliases are not
part of that contract.

## Choose the development shape

| Shape | Use it when |
| --- | --- |
| [Standalone development](/en/docs/operations/standalone-development) | Your application consumes the published package |
| [Monorepo development](/en/docs/operations/monorepo-development) | You maintain Cloud itself or a built-in application |

Both shapes use the same application contract. They differ in dependency and
container ownership.

## Deployment workflow

1. [Choose apps and their deployment requirements](/en/docs/operations/deployment-requirements).
2. [Build the application](/en/docs/operations/build-and-deploy).
3. [Set infrastructure configuration](/en/docs/operations/runtime-configuration).
4. Configure application values through [Settings](/en/docs/platform/settings).
5. [Scale and stop services safely](/en/docs/operations/scaling-and-shutdown).
6. Use [Observability](/en/docs/operations/observability) for health and failure.
7. Use [Troubleshooting](/en/docs/operations/troubleshooting) when the registry,
   gateway, or dependencies disagree.

FreeIPA is optional. See [FreeIPA](/en/docs/operations/freeipa) only when
the deployment uses it.
