---
id: gateway-ops-start
title: Start
icon: ti ti-route-scan
description: Check gateway apps, routes, health, logs, telemetry, metrics, data diagnostics, notifications, and webhooks.
order: 100
---

Gateway Ops is the administration console for the Cloud gateway. Use it to see which apps are registered, which route prefixes the gateway serves, how requests behave, and which platform health signals need attention.

## Know the parts {icon="layout-grid"}

:::reference
- **App registry:** Apps register with the gateway. They report metadata such as name, route prefix, navigation support, administration pages, search support, and health state.
- **Routes:** Each route prefix shows which app owns the path now, how often the route was hit, and how many gateway errors were recorded.
- **Health:** Gateway health combines live app registrations, stale app status, offline apps, route statistics, unmatched requests, and gateway instances.
- **Observability:** Groups logs, telemetry, Prometheus metrics, Redis diagnostics, Postgres diagnostics, notifications, and alert webhooks.
:::

## Start a task {icon="route"}

:::reference
- **Check the platform state:** Start with **Apps** to see online, degraded, and offline services. Remove an offline registration only when you do not expect the app to return.
- **Trace routing:** Open **Routes** to check the route prefixes, total hits, and recorded errors of each prefix that the gateway serves.
- **Investigate a request problem:** Use **Telemetry** for request events, slow requests, status codes, route prefixes, methods, and error kinds. Use **Logs** when the app wrote structured log entries.
- **Check platform storage:** Use the **Postgres** and **Redis** diagnostics to check table growth, dead rows, installed extensions, key counts, prefix distribution, TTL coverage, and warnings.
:::

:::info Gateway Ops is for administrators
The API routes of Gateway Ops require administrator access. The interface uses the same administrator API for destructive actions, such as removing offline apps or deleting webhooks.
:::
