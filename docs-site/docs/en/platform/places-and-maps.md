---
title: Places and maps
navTitle: Places and maps
section: Platform services
order: 559
description: Find addresses and places through Core with shared budgets, caching, and attribution.
tags: [geo, addresses, places, capabilities, maps]
updated: 2026-10-20
---

# Places and maps

Use Core's geo Queries to suggest addresses, locate an address, or find places.
Built-in and third-party applications use the same contracts. Authenticated
people, agents, app sessions, and service accounts follow the same path.
The Assistant discovers these Queries through the capability catalog; MCP and
CLI clients use the same [capabilities](/en/docs/platform/capabilities).

An operator must set `geo.api_key` under
**Administration → Settings → Places and addresses**. This tab also contains
the provider plan and credit budgets. All provider calls use
`https://api-eu.geoapify.com`. The endpoint cannot be changed. No provider key
appears in geo responses. This service does not supply routes,
map tiles, a map style, or map components.

## Choose a Query

Coordinates use `{ lat, lon }` in degrees. Locale comes from request metadata,
never from Query input. Inputs are strict: unknown fields are refused.

| Core Query | Input | Result |
| --- | --- | --- |
| `address.autocomplete` | `text` (3–300 characters), optional `limit` (1–5, default 5), `countryCode`, `type`, `bias` point, and `area` | `suggestions` (up to 5 addresses) and `provenance` |
| `address.geocode` | Either `text` (1–300 characters) or `fields`; optional `countryCode` | One `address` and `provenance`; ambiguity returns candidates in error details |
| `address.reverse` | `point` | One `address` and `provenance` |
| `place.search` | `categories` (1–5), exactly one of `near`, `area`, or `along`; optional `limit` (1–20, default 20) | `places` and `provenance` |
| `geo.availability` | `{}` | `configured`, `person` and `cloud`; each balance has `exhausted` and `resetsAt` |

Autocomplete `type` accepts `country`, `state`, `city`, `postcode`, `street`,
`amenity`, or `locality`. `bias` affects ranking. `countryCode` is an ISO
alpha-2 country filter. An area is either:

```json
{ "type": "bbox", "west": 9.9, "south": 48.3, "east": 10.1, "north": 48.5 }
```

```json
{ "type": "circle", "point": { "lat": 48.4, "lon": 10 }, "radiusMeters": 1000 }
```

A bounding box must have west < east and south < north; split a search that
crosses the date line. A circle needs a positive radius in meters.
`near` ranks places by distance to a point.

Structured geocoding accepts `line1`, `postalCode`, `city`, `stateRegion`, and
`country`, each at most 200 characters. At least one field must contain text.
Core always requests 5 provider candidates; there is no caller-selected limit.
A provider candidate is plausible when `rank.confidence` is at least 0.5.
One plausible candidate is returned; several produce
`GEO_ADDRESS_AMBIGUOUS`. Missing or lower confidence produces
`GEO_ADDRESS_NOT_FOUND`. Confidence describes the provider's match, not a
verified entrance or delivery address.

Addresses carry `line1`, `postalCode`, `city`, `stateRegion`, `countryCode`,
`point`, `formatted`, `confidence` (number or null), and `provenance`.
Unavailable text components are empty strings.

Place categories are `museum`, `cafe`, `restaurant`, `bar`, `pub`, `bakery`,
`supermarket`, `pharmacy`, `hotel`, `accommodation`, `fuel`, `parking`,
`charging`, `toilets`, `park`, `viewpoint`, and `attraction`.
`GeoCategorySchema` and `GEO_CATEGORIES` export the verified mapping.

A place carries `id`, `name`, provider `categories`, `point`, `address`, and
`provenance`. It may include `distanceMeters`, `openingHours` (the raw OSM
string), `website`, and `phone`. Missing opening hours are normal. No Place
Details request is made. Results and cache entries are at most 256 KiB;
oversized or malformed provider data fails rather than being returned partly.

## Search along a route

Pass `along: { polyline6, fromKm, toKm, bufferMeters? }`. Positions refer to
the full route. The window must be positive and at most 200 km.
`bufferMeters` is 100–5,000 m, default 1,000 m.

The raw polyline is bounded to 102,400 ASCII characters, matching the provider's
documented geometry byte budget. Core decodes it, cuts the requested distance
window, then reduces it by minimum spacing to at most 4,000 points before
applying iterative Douglas–Peucker to at most 2,000 points. Each stage doubles
the tolerance until it fits. A dense full route is allowed within
the raw string budget. A window starting beyond the route is unsupported;
a window ending beyond it stops at the route's end.

Core sends a Places POST with `filter.type: "polyline"`, widening the provider
buffer by twice the simplification tolerance (rounded up, capped at 100,000 m),
then filters hits against the original window with the requested buffer.
It requests up to 20 candidates within the one-credit search budget, then
applies the caller's result limit after filtering. If all 20 candidate slots
are used and too few remain inside the requested corridor, `truncated: true`
marks the search as incomplete. Narrow the distance window and search again;
an empty truncated result does not mean that the corridor has no matches.
It orders hits by `atMeters`, the position on the full route, and returns
`distanceToRouteMeters`, a straight-line distance rather than a driving detour.
Positions, distance windows, and corridor distances follow the shortest
great-circle arc between consecutive route points, including near the poles
and across the date line.
Exactly antipodal segment endpoints do not define a unique arc and are
unsupported; include an intermediate route point to choose the path.
The result includes `simplificationToleranceMeters`.

## Handle budgets and errors

Costs use Geoapify credits, accounted internally as integer thousandths.
Autocomplete, geocoding, and reverse cost one credit each. Places cost one
credit per started 20 requested results, including empty or shorter responses.
With the current 20-result limit, a place search costs one credit.

Core reserves the upper bound before calling the provider and settles the
reference cost afterward. Cache hits cost zero and create no ledger write.
The defaults are **90,000 credits per Cloud calendar month** and **300 per
access subject per day**. Both periods use `app.timezone`, including daylight
saving changes. Agents and service accounts count like people. Delegated
sessions count against their resolved access subject. Concurrent requests
cannot spend beyond either limit.

`geo.plan` selects Free, API 10, API 25, API 50, API 100, API 250, or Custom.
The plans provide 3,000/5, 10,000/12, 25,000/15, 50,000/20, 100,000/25, and
250,000/30 daily credits/requests per second respectively. Custom uses
`geo.custom_daily_credits` and `geo.custom_rps`. The provider allowance is plan
information; Cloud enforces its monthly and per-subject daily budgets.
Set those with `geo.monthly_budget_credits` and `geo.person_daily_credits`.
The daily budget cannot exceed the monthly budget, including on reset.

Calls fail immediately when the shared token bucket or per-function in-flight
bound is full; there is no queue. The in-flight bound is the plan rate times
the function deadline, rounded up. Deadlines are 2.5 seconds for autocomplete,
5 seconds for geocoding/reverse, and 8 seconds for places.
Core retries at most once, only for a classified DNS, connection refusal, or
certificate failure proving that nothing reached the provider. Timeouts,
aborts after sending, and crashes keep the reservation spent.

Errors use the capability envelope's stable `code`, localized `message`, and
structured `details`:

| Code | Details and recovery |
| --- | --- |
| `GEO_NOT_CONFIGURED` | Ask an administrator to set the key or repair/reset unreadable `geo.*` settings in Core settings → Places and addresses. No Valkey, budget, or provider work occurs. |
| `GEO_FORBIDDEN` | Supply an authenticated actor and access subject. |
| `GEO_BUDGET_EXHAUSTED` | `scope` (`person` or `cloud`) and `resetsAt`; wait for reset or ask the operator to review the limit. |
| `GEO_BUSY` | `retryAfterSeconds`; wait, then retry. If it persists, check Valkey and provider capacity. A provider 429 also uses this code. |
| `GEO_LIMIT_EXCEEDED` | `limit`, `max`, `actual`; reduce that field. For a minimum bound, `max` reports the required minimum. |
| `GEO_UNSUPPORTED_OPTION` | Correct the input shape or choose one supported search mode/address representation. |
| `GEO_ADDRESS_NOT_FOUND` | Refine the address, city, or country. |
| `GEO_ADDRESS_AMBIGUOUS` | Up to 5 `candidates`; ask the person to choose or refine the address. |
| `GEO_PROVIDER_FAILED` | `costs: { settledCredits, unknownCredits }`; check known and uncertain spend before retrying. `adminHint` means the provider rejected the key (401/403); check Core settings. |

Provider 429 errors also carry costs after a paid request. Provider bodies and
transport error text are discarded. `geo.availability` is free, reads only
the caller's counters, and makes no provider call. Missing keys or unreadable
`geo.*` settings return `configured: false` without reading counters.

## Keep attribution with results

Every address and place retains `provenance`: provider `geoapify`, an ISO
`computedAt`, and attribution text **Geoapify · OpenStreetMap** with links to
[Geoapify](https://geoapify.com) and
[OpenStreetMap copyright](https://www.openstreetmap.org/copyright).
Keep provenance on stored objects. Show that linked attribution near lists
that have no map, including address suggestions.

Valkey caches suggestions for 7 days, geocoding/reverse for 30 days, and places
for 24 hours. Empty suggestion/place results last one hour. Errors are never
cached. A hit keeps the original provenance and `computedAt`.
Cache keys hash normalized input, request language, and adapter version:
lowercase text with collapsed whitespace and sorted categories. Only the
autocomplete bias rounds to 0.01°; area, near, and reverse coordinates round
to five decimal places. Circle radii stay exact.
Route searches hash the full raw polyline6 route and include the window,
buffer (with its default applied), sorted categories, limit, and request language.
A cache failure skips the cache. A Valkey admission failure refuses paid calls
with `GEO_BUSY`.

## Call from a server

Import `geoClient` from `@k2b/cloud/server` and pass the same
`CapabilityCaller` as other server capability calls. Methods are
`autocomplete`, `geocode`, `reverse`, `searchPlaces`, and `availability`.
The client parses Core's response with schemas from `@k2b/cloud/contracts`.

```ts
import { geoClient } from "@k2b/cloud/server";
import type { CapabilityCaller } from "@k2b/cloud/capabilities/server";

export async function findMuseums(caller: CapabilityCaller) {
  return geoClient.searchPlaces({
    categories: ["museum"],
    near: { lat: 48.4011, lon: 9.9876 },
    limit: 20,
  }, caller);
}
```

Pass caller authorization or cookie only to Core, plus request locale,
request ID, and cancellation signal. Durable background work passes its
revocable mandate and the owning app's workload credential. The shared broker
preserves identity and mandate limits; never call the provider from an app.
See [deployment requirements](/en/docs/operations/deployment-requirements#enable-addresses-and-places)
for operator responsibilities.
