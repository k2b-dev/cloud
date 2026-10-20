---
id: pulse-data-model
title: Understand collected data
icon: ti ti-stack-2
kind: reference
description: Choose metrics, events, and states and understand timestamps, corrections, and retention.
order: 105
---
Choose the data type that matches what your source reports. Each base keeps its own sources, access, and retention.

## Choose a data type

:::reference
- **Metric:** A number over time, such as memory usage or a counter of completed orders. Counters cannot be negative.
- **Event:** Something happened at a particular time, such as a visit or completed order.
- **State:** The current value of a fact, such as online status or a version. Pulse records history only for initial values and value changes.
- **Dimension:** A reusable label, such as region, route template, or channel. Keep request IDs and full URLs out of metric dimensions.
:::

Use event `attributes` for unique details, `sensitive` for protected fields with shorter retention, and `payload` for nested details.
Use `actorId`, `sessionId`, and `correlationId` to connect related events.

## Understand accepted values

:::reference
- **Time:** Without a timestamp, Pulse uses acceptance time. Supplied timestamps can be at most five minutes in the future.
- **Metric age:** Metric timestamps must be within raw retention. Sealed hours refuse further writes, even after retention is extended.
- **Corrections:** For one metric series and timestamp, the newest accepted value wins. The correction is visible immediately.
- **Current states:** A newer timestamp wins. At equal timestamps, later acceptance wins; input order breaks ties within a batch.
- **Older states:** Older snapshots change nothing. Equal values update the current snapshot without adding history.
- **Source separation:** Metrics and states from different sources stay separate.
:::

Hourly values keep count, sum, minimum, maximum, last value and timestamp, and counter increase.
A counter reset contributes its new value. Corrections trigger recomputation of affected hours.

## Understand retention

Raw retention covers detailed measurements, events, and state history.
Hourly values and sensitive event fields have separate periods. Current states do not expire.

Expired events, history, hourly values, and sensitive fields are removed during storage cleanup.
Raw metric partitions are removed nightly only after their whole day has expired and its recorded hours are sealed.
The base settings preview affected data before you confirm a shorter period.
