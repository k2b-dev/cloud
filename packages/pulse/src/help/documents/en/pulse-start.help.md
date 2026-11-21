---
id: pulse-start
title: Start with Pulse
icon: ti ti-activity-heartbeat
kind: start
description: Create a base, connect a source, and check collection health.
order: 100
---
Pulse collects metrics, events, and states in bases. Open a base to set up sources and check incoming data.

Open **Pulse** from the app menu. It is hidden from the app bar by default. If you have chosen to show or pin Pulse there, your choice stays in place.

## Read a base

A base opens on **Sources**. The head has four tabs: **Sources**, **Data**, **Usage**, and **SQL**. At the end of the head are **Analyze with Gustav**, **…**, and **Create source**. You see **Create source** only with edit access.

- **Sources** tells you if data arrives. The first line says "All 4 sources receiving" or how many sources need attention. Below it are the sources with refused requests, errors, throttling, or late data, and the alerts that fired. Then all sources follow with their state and newest arrival. Select a row to open its details on the right.
- **Data** lists the data kinds of the base: events, metrics, and states. Select a kind to see its fields with type, an example, and how often each field is filled, and the five newest entries. Pulse never shows confidential event data here.
- **Usage** lists the service accounts and source keys that reach the base through the API. You see them only when you manage the base. From the next release, Usage also shows which Code pages and automations read the data.
- **SQL** runs a query and shows its table and time chart. **Analyze with Gustav** then starts from your SQL.

The source details start with **What does not arrive** when Pulse refuses requests or a fetch fails. The reason is in words. **Arrival** shows the newest data and what Pulse expects. Keys show only to people who manage the base.

An alert row opens the alert: its condition in words, its value, and since when it fired. **Adjust with Gustav** opens an unsent draft with the alert's SQL.

When the data store is not reachable, the first line says so. Pulse checks again every 30 seconds while the page is visible. The rows show the last known state.

**…** holds the base settings. Until the next release, it also holds **Overview** and **Dashboards**.

## Connect a source

Pulse needs a connected data store. If **Pulse is not set up yet** appears, contact your Cloud administrator.

:::steps
1. Choose **New base** and enter a name for your product, environment, or business area.
2. Open the base and choose **Create source**.
3. Choose a metrics endpoint or an HTTP ingest source and save it.
4. Open the source to check its newest data time, errors, and scrape history.
:::

A metrics source fetches a Prometheus endpoint at its configured interval.
An HTTP ingest source accepts batches sent with a source API key.
Create labeled keys under **API keys** in the source details. Keep them in your collector's secret store.

## Choose which metrics to collect

For metrics sources, **Only these metrics (empty = all)** accepts family names or prefixes ending in `*`.
Separate entries with commas or newlines. An empty field includes every family.
Excluded families do not count toward sample or series limits.

The source shows refused histograms, skipped summary samples, and recent throttling.
Use these details to fix the endpoint or reduce the selected metrics.

## Read measurements with SQL

**View** access lets you query one base. **Edit** access lets you save and delete queries.
Use `cld pulse sql --base <base> --file query.sql` to run SQL.
Use `cld pulse queries list --base <base>` to find saved queries.
Read `cld pulse reference sql.md` for parameters and export formats.

Supply values with `--param name=value`. Keep SQL text and values separate.
Ctrl-C cancels a running query. When Pulse is busy, wait for the stated retry delay.
A result with 10,000 rows reached the limit. More rows can exist.
Narrow the time range or group the data to get a complete answer.

Open **SQL** in a base to run a query, inspect its table and time chart, or open a saved query. **Analyze with Gustav** opens an unsent draft with your base, SQL and parameter values. Base settings are under **…** and use a modal with General, Members, Retention, Usage and limits, and Clear and delete tabs.
