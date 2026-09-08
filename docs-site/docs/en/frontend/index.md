---
title: Frontend
navTitle: Overview
section: Frontend
order: 800
description: Keep server authority while adding the smallest useful browser interaction to a Cloud application.
tags: [frontend, ssr, solidjs]
updated: 2026-08-12
---

# Frontend

Cloud pages render on the server. Islands add browser behavior where a page
needs it.

The server owns result sets, permissions, and durable view state. The browser
owns user intent, transient interaction state, and keeping serialized snapshots
current through application APIs.

This boundary lets an independently deployed app participate in Cloud's shared
shell without becoming a client-only application or importing another app's
frontend. A reload remains a complete, authorized rendering path; hydration,
enhanced navigation, mutations, and realtime updates improve that path.

## Choose the page shape

| Boundary | Owner | Start here |
| --- | --- | --- |
| Authorized route and initial result | Application server | [SSR pages and routing](/en/docs/frontend/ssr-pages-and-routing) |
| Cloud chrome, breadcrumbs, and registered navigation | Shared layout and live app registry | [Layout and navigation](/en/docs/frontend/layout-and-navigation) |
| Content geometry inside the page | Application using shared shells | [Application shells](/en/docs/frontend/application-shells) |
| Local browser interaction | The smallest hydrated application island | [Islands and hydration](/en/docs/frontend/islands-and-hydration) |

Use the URL for filters, sorting, pagination, selection, and the active view.
See [URL state and navigation](/en/docs/frontend/url-state-and-navigation).

## Add browser behavior only where needed

- [Server-backed state](/en/docs/frontend/server-backed-island-state) keeps an
  SSR snapshot current inside an island.
- [Browser clients and mutations](/en/docs/frontend/browser-clients-and-mutations)
  covers typed API calls and writes.
- [Realtime UI](/en/docs/frontend/realtime-ui) adds live updates to an
  SSR-owned result set.
- [Forms, prompts, and feedback](/en/docs/frontend/forms-prompts-and-feedback)
  covers user input and mutation states.

Finish with [Styling and accessibility](/en/docs/frontend/styling-and-accessibility)
and [Frontend testing](/en/docs/frontend/testing).

## Choose shared components

Use the [UI catalog](/ui) to inspect supported components, props, and live
examples. Shared components carry accessibility, responsive behavior, theming,
and platform vocabulary.

Import public components from `@k2b/ui` and compose them in an application-owned
island when the UI needs domain state or typed API calls. Keep domain-specific
components in the application. A component belongs in the shared package only
when several applications need the same behavior and contract.

If a recurring need is missing, improve the shared primitive and its catalog
example instead of hiding a local lookalike or CSS override.
