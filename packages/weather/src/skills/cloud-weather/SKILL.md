---
name: cloud-weather
description: Use for current weather and forecasts through Cloud Weather, including saved locations, unsaved German city lookup, hourly or daily outlooks, and saving or deleting locations. Load it whenever the user asks about weather, temperature, rain, or a forecast for a place.
---

# Work with Cloud Weather

Use these defaults unless the user asks otherwise or a more specific loaded Skill overrides them.

## Capabilities

- Saved locations: `weather.location.search`, `weather.location.list`, `weather.location.read`, `weather.location.create`, and `weather.location.delete`.
- Forecasts: `weather.forecast.current` and `weather.forecast.get`.
- Unsaved places: `weather.city.search` finds German city candidates and explicit coordinates.

## Normal flows

- For a saved place, use location search or list and pass the returned location ID to `weather.forecast.current` for current conditions or `weather.forecast.get` for hourly and daily outlooks.
- For an unsaved German city, use `weather.city.search`, choose an unambiguous candidate, and pass its coordinates directly to a forecast. Save it with `weather.location.create` only when the user asks.
- If city search is unavailable, use known coordinates with `weather.forecast.current` or `weather.forecast.get` and `source.kind = "coordinates"`; an administrator can configure the Geo API URL in Weather settings.
- If multiple city candidates remain plausible, ask which one instead of choosing silently. Delete a saved location only when explicitly requested.

## Reporting defaults

- Answer the user's decision first: current conditions, a useful hourly window, or the daily trend. Do not dump every returned value.
- Keep the returned units: °C, km/h, mm, hPa, metres, and sunshine minutes where applicable.
- Treat forecasts as time-sensitive estimates. State the relevant place and time horizon and avoid certainty beyond the returned data.
- If weather affects a Space event or task, mention the implication but change the item only when requested.
