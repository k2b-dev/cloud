---
id: gateway-ops-reference
title: Reference
icon: ti ti-book
description: Look up health states, webhook delivery rules, and the limits of the diagnostics.
order: 120
---

Gateway Ops summarizes platform signals. It does not list raw Redis keys. For logs, telemetry, settings, metrics, and health webhooks, it uses the existing service APIs.

## Read the health states {icon="point"}

:::reference
- **OK:** The apps in scope are online, and their status is fresh enough for the gateway health check.
- **Warning:** An app is reachable but reports stale health information or another degraded state.
- **Error:** At least one app in scope is offline, or so unhealthy that the health status for the scope fails.
:::

## Understand webhook delivery {icon="send"}

:::reference
- **Send when:** A webhook can send on **OK**, **Warning**, **Error**, **Recovery**, or **Every check**, which means every scheduled check. If you select no trigger, it uses error and recovery.
- **Repeat interval:** An unresolved warning or error repeats only after the configured interval. Cloud limits the interval to at least one minute and at most thirty days.
- **Timeout:** Cloud limits the delivery timeout to at least one and at most thirty seconds. A failed delivery updates the last error and the failure count of the webhook.
- **Payload:** A GET delivery sends a ping request. A POST delivery sends JSON with the mode and the gateway health report for the scope.
:::

:::info Know the limits of the diagnostics
Redis prefixes come from a bounded sample, not from a full view of all raw keys. Postgres row counts are planner estimates, not exact counts from full table scans.
:::

## Read Postgres connections {icon="point"}

PostgreSQL connections and their limit describe the database server. They do not include PgBouncer clients, pool limits, or pool wait times; monitor PgBouncer separately. With transaction pooling, sessions stand for shared PostgreSQL backends. A failed session or index query appears as a loading error, not as an empty list.
