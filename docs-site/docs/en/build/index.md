---
title: Build an application
navTitle: Overview
section: Build an app
order: 100
description: Build an independently released application against Cloud's public runtime contract.
tags: [applications, architecture, deployment]
updated: 2026-08-28
---

# Build an application

The normal application is standalone: it has its own repository, version,
image, and release cycle and connects to Cloud through published packages.

Start with [Platform model](/en/docs/overview) for the ownership and runtime
boundary, then create the [first standalone application](/en/docs/build/getting-started).

## Choose the project shape

Choose the repository from release ownership. The public application contract
stays the same.

| Project | Choose it when |
| --- | --- |
| Standalone | The application team owns the repository, image, compatibility decision, and release |
| Built-in | Cloud maintainers intentionally release the application with the platform |

Do not begin in the Cloud monorepo only to gain access to internal imports or
workspace aliases. Use the monorepo path only when the application is intended
to ship as part of Cloud itself; see
[Monorepo development](/en/docs/operations/monorepo-development).

## Build tasks

| Task | Page |
| --- | --- |
| Create and verify a standalone service | [First application](/en/docs/build/getting-started) |
| Look up every `defineApp()` option | [Define an application](/en/docs/build/define-app) |
| Prepare data and manage process work | [Application lifecycle](/en/docs/build/lifecycle) |
| Publish routes through the gateway | [Routes and discovery](/en/docs/build/routing) |
| Add middleware and HTTP APIs | [Server requests](/en/docs/server) |
| Add translations and locale-aware formatting | [Internationalization](/en/docs/build/internationalization) |
| Write labels, feedback, errors, notifications, and Help | [Product language and tone](/en/docs/build/product-language-and-tone) |
