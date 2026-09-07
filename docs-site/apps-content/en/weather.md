---
title: Weather
navTitle: Weather
section: Everyday
order: 240
description: Saved locations, forecasts, radar, displays, and weather widgets.
tags: [weather, forecasts, capabilities]
updated: 2026-09-07
---

# Weather

Weather saves locations for the current user and presents current conditions,
hourly and daily forecasts, rain radar, and unattended display views. Use it to
check one place quickly or keep several locations ready for recurring plans.

## Use Weather

- Save a German city once and return to its forecast from the overview.
- Compare current conditions with hourly values for near-term decisions.
- Use the daily forecast for the broader trend across the available days.
- Check rain radar when the timing and movement of precipitation matter.
- Open Display for a shared screen, or add the current-weather widget to a
  dashboard.

Forecasts describe the saved coordinates rather than every street or local
microclimate. Provider data can change as newer observations arrive.

## Understand the Weather model

| Resource or surface | Responsibility |
| --- | --- |
| Saved location | A named set of coordinates owned by one user |
| Forecast | Current conditions plus bounded hourly and daily data |
| Rain radar and display | Visual views for near-term rain and shared screens |
| Current-weather widget | A compact dashboard view using saved or configured coordinates |

Location search currently covers German cities. A saved location stays in the
user's account until the user removes it. Weather may reuse cached provider
data according to the configured cache duration.

## How Weather fits Cloud

Weather owns location and forecast behavior. It uses Cloud for user identity,
application settings, dashboard widgets, API publication, capability
registration, and the shared in-product Help surface.

## Find detailed product help

Open **Help** inside Weather for saved locations, forecast views, displays, and
troubleshooting. Developers can read [App capabilities](/en/docs/platform/capabilities),
[Application settings](/en/docs/platform/settings), and
[Dashboard widgets](/en/docs/platform/dashboard-widgets) for the shared
contracts Weather adopts.

## Automate Weather from the terminal

Weather does not register a dedicated `cld weather` module. Use its typed
Queries through the generic capabilities interface when a script needs weather
data:

```bash
cld capabilities query weather location.list \
  --input '{"limit":10}' \
  --json

cld capabilities query weather forecast.get \
  --input '{"source":{"kind":"coordinates","lat":52.52,"lon":13.405}}' \
  --json
```

Run `cld capabilities catalog --json` to inspect the live schemas and safety
metadata. Run `cld capabilities query --help` for the current invocation
syntax. Capability calls use the current profile and do not bypass application
authorization.

## Deployment requirements

See [Deployment requirements](/en/docs/operations/deployment-requirements) for
this app’s startup prerequisites, optional integrations, configuration and
functional checks.
