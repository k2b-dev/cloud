---
id: gateway-ops-start
title: Start
icon: ti ti-route-scan
description: Gateway apps, routes, health, logs, telemetry, metrics, data diagnostics, notifications, and webhooks.
order: 100
---

Gateway Ops is the admin console for the Cloud gateway. Use it to see which apps are registered, which route prefixes are served, how requests behave, and where platform-level health signals need attention.

## Overview {icon="layout-grid"}

:::reference
- **App registry:** Apps register with the gateway and expose metadata such as name, route prefix, navigation support, admin pages, search support, and health state.
- **Routes:** Route prefixes show which app currently owns a path, how often the route was hit, and how many gateway errors were recorded.
- **Health:** Gateway health combines live app registration, stale app status, offline apps, route stats, unmatched requests, and gateway instances.
- **Observability:** Logs, telemetry, Prometheus metrics, Redis diagnostics, Postgres diagnostics, notifications, and alert webhooks are grouped under Observability.
:::

## Common paths {icon="route"}

:::reference
- **Check the platform state:** Start with Apps for online, degraded, and offline services. Remove an offline registration only when the app is no longer expected to return.
- **Trace routing behavior:** Open Routes to inspect route prefixes, total hits, and recorded errors for each prefix served by the gateway.
- **Investigate a request problem:** Use Telemetry for request events, slow requests, status codes, route prefixes, methods, and error kinds. Use Logs when the application emitted structured log entries.
- **Check platform storage:** Use Postgres and Redis diagnostics to inspect table growth, dead rows, installed extensions, key counts, prefix distribution, TTL coverage, and warnings.
:::

:::info Access
Gateway Ops is an admin surface. API routes require admin access, and destructive actions such as removing offline apps or deleting webhooks are handled through the same admin API as the UI.
:::
