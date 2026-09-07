---
title: Built-in applications
navTitle: Overview
section: Start
order: 10
description: See what Cloud applications provide and where each application's responsibility begins.
tags: [apps, products]
updated: 2026-09-07
---

# Built-in applications

Cloud ships focused applications on the same platform contract available to
standalone services. Each application owns its product behavior and data.
Cloud supplies shared identity, access, navigation, operations, and other
platform building blocks.

This catalog answers three questions: what an application is for, which
resources it owns, and which Cloud building blocks it uses. Open **Help** inside
a running application for detailed usage instructions.

## Work

| Application | Use it for |
| --- | --- |
| [Assistant](/en/apps/assistant) | Writing, rewriting, summarizing, and questions with configured AI models |
| [Contacts](/en/apps/contacts) | Shared contact books, structured records, tags, notes, and hierarchy |
| [Files](/en/apps/files) | Browsing, uploading, moving, and managing files across accessible bases |
| [Grids](/en/apps/grids) | Structured tables, views, forms, reports, and document workflows |
| [Mail](/en/apps/mail) | Searching, organizing, and collaborating on email |
| [Notebooks](/en/apps/notebooks) | Collaborative notebooks, structured notes, and realtime editing |
| [Spaces](/en/apps/spaces) | Boards, tasks, events, and team planning |

## Everyday tools

| Application | Use it for |
| --- | --- |
| [FAQ](/en/apps/faq) | Publishing frequently asked questions and public help content |
| [Quotes](/en/apps/quotes) | Showing a cached quote in Cloud surfaces and dashboards |
| [Tools](/en/apps/tools) | Small utilities for recurring day-to-day tasks |
| [Venues](/en/apps/venue) | Opening hours, staffing shifts, public status pages, and feedback |
| [Weather](/en/apps/weather) | Saved locations, forecasts, radar, and weather displays |

## Platform administration

| Application | Use it for |
| --- | --- |
| [Accounts](/en/apps/accounts) | Account requests, users, groups, and access administration |
| [API Docs](/en/apps/api-docs) | Browsing the OpenAPI contracts published by Cloud applications |
| [Capabilities](/en/apps/capabilities) | Inspecting and running the Queries and Actions available to an account |
| [Core](/en/apps/core) | Shared authentication, search, administration, and platform surfaces |
| [Dashboard](/en/apps/dashboard) | A personal home assembled from application widgets |
| [OAuth](/en/apps/oauth) | OAuth and OIDC clients, redirects, scopes, and secrets |
| [Proxy Auth](/en/apps/proxy-auth) | Forward-auth clients and callback access flows |

## Operations

| Application | Use it for |
| --- | --- |
| [Gateway](/en/apps/gateway-ops) | Gateway status, registered applications, routes, and operational events |
| [Hosts](/en/apps/ipa-hosts) | FreeIPA hosts, host groups, and mirrored membership data |
| [Pulse](/en/apps/pulse) | Metrics, events, states, and realtime dashboards in development deployments |

The [UI catalog](/en/ui) in Fibel documents the reusable component package.

## Know which reference to use

| Question | Source |
| --- | --- |
| What does this application provide? | This Apps catalog |
| What do I need to deploy these applications? | [Deployment requirements](/en/docs/operations/deployment-requirements) |
| How do I use the product UI? | Help inside the running application |
| How do I build or extend a Cloud application? | [Developer documentation](/en/docs) |
| Which shared components can I use? | [UI catalog](/en/ui) |
| What can my installed CLI do? | `cld help` and `cld <module> help` |

Installed applications depend on the deployment and the current user's access.
Run `cld apps list --json` when a script needs the live list from the selected
Cloud instance.
