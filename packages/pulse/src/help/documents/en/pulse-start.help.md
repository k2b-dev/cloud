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

A base opens on **Sources**. The sidebar holds **Sources**, **SQL**, and **Settings**.

**Sources** lists all sources with their state and newest data. The list refreshes every 5 seconds; focus and scroll position stay. Select a row to open its details on the right. **Source** creates a new source; you need edit access for it.

Above the sources, **Needs attention** appears when alerts fired or cannot be checked. Critical alerts come first, then warnings, then alerts that cannot be checked. Each row gives the condition in words, the value, and since when the alert fired. **Adjust with Gustav** opens an unsent draft with the alert's SQL. **Open SQL** opens the alert's SQL in the console without running it.

When the data store is not reachable, a notice above the sources says so. Pulse checks again every 30 seconds while the page is visible. The list shows the last known state.

An old dashboard link opens the base with the notice **Dashboards are gone**. **Got it** closes the notice. To show numbers or charts to other people, ask Gustav for a Code page that reads this base. The page shows data only to people who may read the base.

## Connect a source

Pulse needs a connected data store. If **Pulse is not set up yet** appears, contact your Cloud administrator.

:::steps
1. Choose **New base** and enter a name for your product, environment, or business area.
2. Open the base and choose **Source**.
3. Choose a metrics endpoint or an HTTP ingest source and save it.
4. Open the source to check its newest data time, errors, and scrape history.
:::

A metrics source fetches a Prometheus endpoint at its configured interval.
An HTTP ingest source accepts batches sent with a source API key.
In **New source**, **Ask AI** helps prepare an adapter for your shop or another service.
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

Open **SQL** in a base to run a query, inspect its table and time chart, or open a saved query. **Ask AI** opens an unsent draft with your base, SQL and parameter values. **Settings** opens a modal with General, Members, Retention, Usage and limits, and Clear and delete tabs.
