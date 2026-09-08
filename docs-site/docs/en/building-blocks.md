---
title: Find a platform API
navTitle: Building blocks
section: Start
order: 30
description: Match a third-party application task to its supported public Cloud entry point.
tags: [platform, api, services]
updated: 2026-08-18
---

# Find a platform API

Find the task in the table. Every listed import is a supported package entry
point for a standalone application. Do not replace it with a source path or an
import from another application.

| Task | API | Import | Reference |
| --- | --- | --- | --- |
| Declare and register an application | `defineApp()` and `app.start()` | `@k2b/cloud` | [Build an application](/en/docs/build) |
| Handle a request | Middleware and response helpers | `@k2b/cloud/server` | [Server requests](/en/docs/server) |
| Check identity and access | Actor, access subject, roles, and permissions | `@k2b/cloud/server` | [Identity and access](/en/docs/identity) |
| Store domain records | Bun SQL and Postgres helpers | `bun`, `@k2b/cloud/services` | [Data ownership](/en/docs/data) |
| Read runtime configuration | Settings declarations and snapshots | `@k2b/cloud`, `/server`, `/services` | [Settings](/en/docs/platform/settings) |
| Write operational logs | Structured logger | `@k2b/cloud/services` | [Logging](/en/docs/platform/logging) |
| Trace one operation | Spans and trace events | `@k2b/cloud/services` | [Tracing](/en/docs/platform/tracing) |
| Record security evidence | Audit events | `@k2b/cloud/services` | [Audit events](/en/docs/platform/audit-events) |
| Send notifications | Typed definitions and delivery | `@k2b/cloud`, `/services` | [Notifications](/en/docs/platform/notifications) |
| Publish agent-friendly reads and mutations | Types, Queries, and Actions | `@k2b/cloud`, `@k2b/cloud/contracts` | [App capabilities](/en/docs/platform/capabilities) |
| Add resources to global search | Universal Search Query | `@k2b/cloud/contracts` | [Universal search](/en/docs/platform/search) |
| Let a user choose a Cloud resource | `openCloudResourcePicker()` | `@k2b/cloud/browser/resource-picker` | [Universal search](/en/docs/platform/search#let-a-user-choose-a-cloud-resource) |
| Add a dashboard summary | Widget declaration and response contract | `@k2b/cloud`, `@k2b/cloud/contracts` | [Dashboard widgets](/en/docs/platform/dashboard-widgets) |
| Add product guidance | Help collection | `@k2b/cloud/server` | [In-product Help](/en/docs/platform/help) |
| Render documents | Template and PDF services | `@k2b/cloud/services` | [PDF and templates](/en/docs/platform/pdf-and-templates) |
| Read document content | Bounded document-to-Markdown service | `@k2b/cloud/services/document-extraction` | [Document extraction](/en/docs/platform/document-extraction) |
| Add CLI commands | CLI module builders | `@k2b/cloud/cli` | [CLI modules](/en/docs/platform/cli-modules) |
| Run jobs or coordinate instances | Jobs, queues, schedulers, topics, and mutexes | `@k2b/sync` | [Automation](/en/docs/automation) |
| Add durable workflows | Workflow definitions and runtime adapters | `@k2b/cloud/workflows` | [Workflow overview](/en/docs/automation/workflow-overview) |
| Render application pages | SSR shells, islands, and navigation | `@k2b/cloud/ssr`, `@k2b/ssr` | [Frontend](/en/docs/frontend) |
| Use shared components | Portable UI package | `@k2b/ui` | [UI catalog](/ui) |
| Add AI features | AI resources, models, tools, and streaming | `@k2b/cloud/ai` | [AI](/en/docs/ai) |

The [API surface](/en/docs/reference/api-surface) lists every supported import,
its runtime, and its stability. A symbol that exists in the Cloud source tree
but is absent from that public surface is not an application API.

Domain-specific behavior stays in the application.
