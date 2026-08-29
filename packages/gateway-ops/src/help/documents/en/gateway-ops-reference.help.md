---
id: gateway-ops-reference
title: Reference
icon: ti ti-book
description: Field meanings, webhook behavior, and what the diagnostics are allowed to show.
order: 120
---

Gateway Ops summarizes platform signals. It avoids listing raw Redis keys and relies on existing service APIs for logs, telemetry, settings, metrics, and health webhooks.

## Health states {icon="point"}

:::reference
- **OK:** The scoped apps are online and their status is fresh enough for the gateway health check.
- **Warning:** An app can be reached but reports stale health information or another degraded state.
- **Error:** At least one scoped app is offline or otherwise unhealthy enough to make the scoped health status fail.
:::

## Webhook delivery {icon="send"}

:::reference
- **Triggers:** Webhooks can send on OK, warning, error, recovery, or every scheduled check. If no trigger is selected, error and recovery are used.
- **Repeat interval:** Unresolved warning or error states repeat only after the configured interval. The interval is clamped between one minute and thirty days.
- **Timeout:** Delivery timeout is clamped between one and thirty seconds. Failed deliveries update the webhook's last error and failure count.
- **Payload:** GET delivery sends a ping request. POST delivery sends JSON containing the mode and scoped gateway health report.
:::

:::info Diagnostics limits
Redis prefixes come from a bounded sample, not a full raw key browser. Postgres row counts are planner estimates, not exact counts from full table scans.
:::
