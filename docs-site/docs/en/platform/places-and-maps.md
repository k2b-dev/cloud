---
title: Places and maps
navTitle: Places and maps
section: Platform services
order: 559
description: Find addresses, places, and routes through Core with shared budgets, caching, and attribution.
tags: [geo, addresses, places, capabilities, maps]
updated: 2026-10-22
---

# Places and maps

Use Core's geo Queries to suggest addresses, locate an address, find places, or calculate and edit a route.
Built-in and third-party applications use the same contracts. Authenticated
people, agents, app sessions, and service accounts follow the same path.
The Assistant discovers these Queries through the capability catalog; MCP and
CLI clients use the same [capabilities](/en/docs/platform/capabilities).

An operator must enter the Geoapify key under
**Administration → Places and maps** (`/admin/places-and-maps`). The page also
holds the provider plan, the credit budgets, and this month's usage; see
[Administer places and maps](#administer-places-and-maps). All provider calls use
`https://api-eu.geoapify.com`. The endpoint cannot be changed. No provider key
appears in geo responses. Use `CloudMap` for the shared light and dark map.

## Choose a Query

Coordinates use `{ lat, lon }` in degrees. Locale comes from request metadata,
never from Query input. Inputs are strict: unknown fields are refused.

| Core Query | Input | Result |
| --- | --- | --- |
| `address.autocomplete` | `text` (3–300 characters), optional `limit` (1–5, default 5), `countryCode`, `type`, `bias` point, and `area` | `suggestions` (up to 5 addresses) and `provenance` |
| `address.geocode` | Either `text` (1–300 characters) or `fields`; optional `countryCode` | One `address` and `provenance`; ambiguity returns candidates in error details |
| `address.reverse` | `point` | One `address` and `provenance` |
| `place.search` | `categories` (1–5), exactly one of `near`, `area`, or `along`; optional `name` (1–300 characters after trimming) and `limit` (1–20, default 20) | `places` and `provenance` |
| `map.style` | Optional `theme` (`light` or `dark`) | Same-origin `styleUrl` and attribution links |
| `route.calculate` | `{ plan }`: 2–26 stops, route/per-leg options, optional optimization and reference-distance allowance | A self-contained `route` with resolved stops, independent legs, meters, seconds, polyline6, and provenance |
| `route.update` | `{ route, changes, distanceAllowanceMeters? }` | Proposed `route`, `before`, `after`, `delta`, and optional insertion details |
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
`point`, `formatted`, `confidence` (number or null), `buildingConfidence`
(number or null), and `provenance`. `buildingConfidence` is the provider's
certainty that `point` is this building (`rank.confidence_building_level`);
it is null when the result is not a house-number match. Store a point for a
typed address only when this value is high; Contacts requires at least 0.9.
Unavailable text components are empty strings.

Place categories are `museum`, `cafe`, `restaurant`, `bar`, `pub`, `bakery`,
`supermarket`, `pharmacy`, `hotel`, `accommodation`, `fuel`, `parking`,
`charging`, `toilets`, `park`, `viewpoint`, and `attraction`.
`GeoCategorySchema` and `GEO_CATEGORIES` export the verified mapping.

Use optional `name` to ask the provider for places matching a name, such as
`"Wasserfall"`, within the required categories and geographic controls. This
works for both area searches and route corridors. Outer whitespace is removed;
case and internal whitespace are preserved in requests and cache keys. Omitting
`name` keeps category-only search. Blank or longer than 300-character names are
refused. Cloud returns provider matches rather than filtering a cached category
result page by name.

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

## Calculate and edit a route

Import `geoRouteContract`, `GeoRoutePlanSchema`, and `GeoRouteSchema` from
`@k2b/cloud/contracts`. Call `geoClient.calculateRoute({ plan }, caller)` or
`geoClient.updateRoute({ route, changes }, caller)` from a server. Core exposes
these as `route.calculate` and `route.update` on the same capability, MCP,
CLI, and mandate paths as address and place queries.

A plan has 2–26 stops with unique, case-sensitive `id` values and optional
`label` values. Each stop supplies exactly one of `point` or `address`.
An address uses the same shape and ambiguity rules as `address.geocode`.
An ambiguity error identifies the `stopId` and up to five candidates; choose
one candidate's point before trying again. Successful geocodes are charged
even when a later address is ambiguous or no route is found.

```ts
const result = await geoClient.calculateRoute({
  plan: {
    stops: [
      { id: "A", label: "Start", point: { lat: 48.4, lon: 10 } },
      { id: "B", address: { text: "Example Street 8, Example City" } },
    ],
    options: { mode: "car", avoid: ["highways"] },
    distanceAllowanceMeters: 500_000,
  },
}, caller);
```

Options accept `mode: "car" | "bike" | "walk"` (default `car`) and `avoid`
preferences `tolls`, `ferries`, and `highways` (default none). Tolls and highways
require `car`; when changing mode, clear incompatible preferences explicitly.
A preference is not a prohibition: the provider may use it if there is no
alternative. Core always requests metric units, `free_flow` traffic, and
independent `stopover` legs. There is no truck or live-traffic mode.
Walking legs in a fixed order with known straight-line distance above 100 km
are refused before routing. Optimization uses the order-independent total bound
described below instead. The provider also enforces its walking-distance limit.

Use `legOptions: [{ fromStopId, toStopId, options }]` to override supplied
options for an adjacent pair. Different options are calculated separately.
With `optimize: true`, the provider orders intermediate stops using the route
defaults while keeping the first and last fixed. Core then applies overrides
to the outgoing leg of each departure stop. Thus the optimized order is based
on defaults, rather than a mixed-mode optimization objective.

Save the entire returned `route`, including stops, legs, options, allowance,
input hash, and provenance. Core stores no route. Each leg and the full route
carry `polyline6`; geometry is simplified with a reported conservative
`simplificationToleranceMeters` until the result fits the 256 KiB capability
budget. Geometry simplification leaves distance and duration totals unchanged.

Pass the saved route with exactly one `changes` object:

| Change | Fields and behavior |
| --- | --- |
| `insert` | `stop`, optional `afterStopId`. With a chosen gap, inserts there. Otherwise compares all gaps when there are at most three; for larger tours, compares the three smallest straight-line detours. Chooses the least added travel time, breaking ties by distance. Only the winning gap's leg is replaced. Candidates with an explicit empty Routing result (`GEO_NO_ROUTE`) are skipped. HTTP errors stop the chain; provider no-route HTTP behavior has not been verified live. |
| `move` | `stopId`, `toIndex` (zero-based final index). Changes the order and recalculates affected legs. |
| `optimize` | Reorders intermediate stops using defaults, fixes endpoints, then reapplies outgoing leg options. |
| `options` | `options`, optional `leg: { fromStopId, toStopId }`. A leg change patches only that leg. A route-wide change patches defaults and clears overrides. |

Options travel with their departure stop when moving or optimizing stops.
An inserted stop inherits the replaced leg's options for both new legs.
The update returns `before` and `after` summaries with `stopIds`,
`distanceMeters`, and `durationSeconds`, plus signed `delta` values (after
minus before). The caller chooses whether to save the proposal. Insertion
also returns `afterStopId`, `candidateGaps`, and `exhaustive`; when there are
more than three gaps, its geographic shortlist can miss the globally best gap.

### Set a reference-distance allowance

`plan.distanceAllowanceMeters` defaults to **500,000 meters per leg**. Updates
inherit the route's allowance; pass `distanceAllowanceMeters` alongside
`route` and `changes` to choose a new one. The allowance is multiplied by the
number of legs in each provider request when reserving that request's cost.
A known straight-line distance already above the per-leg allowance is refused
before any provider call. Optimization instead checks an order-independent
minimum-spanning-tree distance bound against the total allowance; input
adjacency is discarded. After address resolution, Core repeats the applicable
checks before routing and validates replacement legs in the optimized order.

Core reserves the full chain atomically before the first provider call,
including unresolved geocodes, every insertion candidate, optimization, and
any per-leg replacements. Conservative reference pricing is:

```text
base = pairs + avoid preferences
if optimizing at least 4 stops:
  base += (stops - 2) * min(stops - 2, 10)
reference credits = base * max(1, ceil(distance meters / 500000))
```

If the entire reservation exceeds either configured total budget, Core returns
`GEO_LIMIT_EXCEEDED` with `limit: "reservationCredits"`, `actual`, and `max`
in credits. A reset cannot resolve this error. Choose a smaller allowance that
still covers the route, reduce the request, or ask an administrator to increase
the budget. With the default 300-credit person budget, 26 stops at the default
allowance need 625 credits, and optimizing eight stops needs 301 credits.

Reservation uses the chosen allowance; settlement uses actual returned route
distance. This is an explicit reference-accounting assumption because the
provider's published distance-pricing examples differ. Geoapify documents no
car/bike road-distance ceiling or request parameter that enforces this
allowance. Straight-line distance is only a lower bound. **The allowance is
not a guaranteed limit on the provider's bill.**

If actual distance exceeds the request's allowance, Core returns
`GEO_COST_OVERRUN`, stops later paid steps, and never retries automatically.
It debits all known reference costs, even beyond the reservation. Counters can
therefore exceed the budget; further reservations are refused until reset or
an operator changes the budget. Unknown costs stay charged at their reserved
amount. Inspect `costs` before choosing a larger allowance and trying again.
Routing responses are limited to **26 × 256 KiB** before decoding and
compacted to the public 256 KiB result budget. Core requests JSON geometry
without redundant encoded-provider polylines. This byte limit is independent
of the distance allowance: dense or very long routes can exceed it, fail with
`GEO_PROVIDER_FAILED`, and retain their reserved charge as unknown. No practical
road-distance ceiling can be inferred from this limit. Split a large plan
before retrying; real response density has not been verified live.

Valid paid responses are cached even on overrun. Reusing them costs zero, but
a retry still requires whole-chain admission; exhausted budgets block it.

## Handle budgets and errors

Costs use Geoapify credits, accounted internally as integer thousandths.
Autocomplete, geocoding, and reverse cost one credit each. Places cost one
credit per started 20 requested results, including empty or shorter responses.
With the current 20-result limit, a place search costs one credit.

Core reserves address/place costs before calling the provider and settles the
reference cost afterward. Routing reserves against the explicit distance
allowance described above. A complete result served from cache costs zero and creates no ledger write.
The defaults are **90,000 credits per Cloud calendar month** and **300 per
access subject per day**. Both periods use `app.timezone`, including daylight
saving changes. Agents and service accounts count like people. Delegated
sessions count against their resolved access subject. Concurrent reservations cannot exceed either limit. Known routing overruns
can exceed a reservation and are recorded as spent.

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
5 seconds for geocoding/reverse, 8 seconds for places, and 15 seconds for each routing request.
Core retries at most once, only for a classified DNS, connection refusal, or
certificate failure proving that nothing reached the provider. A timeout or
abort after sending retains that request's reserved amount; unstarted chain
steps are refunded. A process crash retains the open full-chain reservation.

Errors use the capability envelope's stable `code`, localized `message`, and
structured `details`:

| Code | Details and recovery |
| --- | --- |
| `GEO_NOT_CONFIGURED` | Ask an administrator to enter the key, or to replace an unreadable key or budget value, in Administration → Places and maps. No Valkey, budget, or provider work occurs. |
| `GEO_FORBIDDEN` | Supply an authenticated actor and access subject. |
| `GEO_BUDGET_EXHAUSTED` | `scope` (`person` or `cloud`) and `resetsAt`; wait for reset or ask the operator to review the limit. |
| `GEO_BUSY` | `retryAfterSeconds`; wait, then retry. If it persists, check Valkey and provider capacity. A provider 429 also uses this code. |
| `GEO_LIMIT_EXCEEDED` | `limit`, `max`, `actual`; reduce that field. For a minimum bound, `max` reports the required minimum. |
| `GEO_UNSUPPORTED_OPTION` | Correct the input shape or choose one supported search mode/address representation. |
| `GEO_ADDRESS_NOT_FOUND` | Refine the address, city, or country. |
| `GEO_ADDRESS_AMBIGUOUS` | Up to 5 `candidates`; ask the person to choose or refine the address. |
| `GEO_NO_ROUTE` | Adjust stops or mode; no connected route was found. Completed steps remain charged. |
| `GEO_COST_OVERRUN` | `distanceAllowanceMeters`, `actualDistanceMeters`, and `costs`; later paid steps stopped. Known costs were charged beyond the reservation when necessary. Review spend before increasing the allowance and trying again. |
| `GEO_PROVIDER_FAILED` | `costs: { settledCredits, unknownCredits }`; check known and uncertain spend before retrying. `adminHint` identifies an operator recovery step. On failed ledger settlement, `costs` reports the original reservation as unknown, while optional `accounting: { reservationCredits, knownReferenceCredits, unknownReferenceCredits }` exposes the costs that need reconciliation; no uncommitted overrun is claimed as settled. |

Provider 429 errors also carry costs after a paid request. Provider bodies and
transport error text are discarded. `geo.availability` is free, reads only
the caller's counters, and makes no provider call. Missing keys or unreadable
`geo.*` settings return `configured: false` without reading counters.

## Administer places and maps

Only administrators open **Administration → Places and maps**. The old link
`/admin/settings?tab=places` leads there. Every part of the page uses the same
admin API, `/api/admin/core/geo`; OAuth tokens need the `read` scope to view
and `write` to change.

| Request | Effect |
| --- | --- |
| `GET /` | Key state (`none`, `set`, `unreadable`) with when and by whom it was set, the plan, the budgets, the plan table, and `app.timezone`. Never the key. |
| `GET /usage` | This month and today in credits, the share per function (`tiles`, `places`, `route`, `address`), and how many access subjects reached their daily limit today. |
| `PUT /key` `{ apiKey }` | Checks the key with one reverse-geocoding lookup at the EU endpoint, then stores it. A refusal (`422 geo_key_rejected`) or an unreachable provider (`502 geo_key_unverified`) stores nothing; the previous key stays active. `400 geo_key_missing` or `geo_key_malformed` stop before the provider is called. |
| `DELETE /key` | Removes the key; maps, place search, and address suggestions turn off for everyone. |
| `PUT /budget` | Saves `plan`, `monthlyCredits`, and `personDailyCredits` (plus `customRps` and `customDailyCredits` for the custom plan) together. Each field must be a whole number within the setting's bounds, and the daily limit at most the monthly budget. A refusal returns `400 geo_budget_invalid` with a code per field and changes nothing. |

The verification lookup costs about one credit at Geoapify and is not counted
in Cloud's budget. The general settings API refuses `geo.api_key`, so a key
always passes this check before it replaces another.

The page shows the month and today as bars. Today compares Cloud's use with
the plan's daily allowance, which Geoapify treats as a soft limit. Usage is
counted in Cloud's reference credits from the formulas above, not read from
Geoapify's billing. The budgets stop Cloud from admitting new paid calls; they
do not guarantee the provider's invoice.


## Keep attribution with results

Every address, place, route, and route leg retains `provenance`: provider `geoapify`, an ISO
`computedAt`, and attribution text **Geoapify · OpenStreetMap** with links to
[Geoapify](https://geoapify.com) and
[OpenStreetMap copyright](https://www.openstreetmap.org/copyright).
Keep provenance on stored objects. Show that linked attribution near lists
that have no map, including address suggestions.

Valkey caches suggestions for 7 days, geocoding/reverse for 30 days, places and routes
for 24 hours. Empty suggestion/place results last one hour. Errors are never
cached. A hit keeps the original provenance and `computedAt`.
Cache keys hash normalized input, request language, and adapter version:
lowercase address text with collapsed whitespace and sorted categories.
Routing preserves exact coordinates and case-sensitive stop IDs/labels, and
sorts avoid preferences. Full route-result cache hits bypass the ledger;
reused component calls are refunded during chain settlement. Only the
autocomplete bias rounds to 0.01°; area, near, and reverse coordinates round
to five decimal places. Circle radii stay exact.
Route searches hash the full raw polyline6 route and include the window,
buffer (with its default applied), sorted categories, limit, and request language.
A cache failure skips the cache. A Valkey admission failure refuses paid calls
with `GEO_BUSY`.

## Call from a server

Import `geoClient` from `@k2b/cloud/server` and pass the same
`CapabilityCaller` as other server capability calls. Methods are
`autocomplete`, `geocode`, `reverse`, `searchPlaces`, `calculateRoute`,
`updateRoute`, `mapStyle`, and `availability`.
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

## Show a map

Import `CloudMap` from `@k2b/cloud/geo/ui`. Pass markers, lines, selection and
height as for `MapView` in `@k2b/ui`. CloudMap supplies the Cloud style and
required attribution. It inherits the UI locale and theme.

```tsx
import { CloudMap } from "@k2b/cloud/geo/ui";

<CloudMap
  height={320}
  markers={[{ id: "museum", mark: 1, label: "Museum", point: { lat: 48.4, lon: 10 } }]}
/>
```

Pass the authorized SSR `geo.availability` result as `availability` when it
is available. An unconfigured or exhausted snapshot retains the static pins
without loading map assets. The host owns the explanatory message, retry,
and the accessible list of saved places. Server output and the first client
render use the same snapshot.

`map.style` and `geoClient.mapStyle()` return a style URL for non-Solid clients.
Keep every returned attribution link visible. Styles, glyphs, and tiles use
`/api/geo`; no browser request goes to Geoapify. Core serves the bundled
IBM Plex glyphs locally. Tile requests use the fixed EU endpoint and the
server-only key header.

Each tile costs 0.25 reference credits against the same monthly and personal
daily budgets as address searches. Tile admission has a separate shared
bucket at four times the plan's API rate and a 10-second deadline. A tile
body is limited to 1 MiB: at the Free plan's maximum of 200 in-flight tile
requests, buffered bodies are bounded to 200 MiB. Oversized or invalid
responses fail visibly; they are never forwarded as map data.

Tiles have `Cache-Control: private, max-age=604800`; Valkey does not cache
tile bodies. The map uses vector zooms 0–14 and scales the last level above
that. Authentication and read scope apply to every asset route. Failed
requests are not cached, and ambiguous transport failures retain the
reserved credit.

Tile and glyph failures retain pins with **Try again**. `CloudMap` refreshes
free availability after a failure and shows the person/day or Cloud/month
reset time when a budget is exhausted. Core bundles its glyph files as server
assets; production images need no runtime UI package or external font host.


## Export a map image for print or PDF

`CloudMap` forwards the public `MapView` browser `ref` handle. Capture its
complete fitted view with `handle.snapshot({ signal })` after it is ready.
The PNG includes the same flat Cloud basemap, road labels, saved geometry,
pin marks and attribution. Capture introduces no provider request chain:
it never starts, pans, refits or retries a map. Existing tile requests remain
authenticated in Core, attributed to the original actor/access subject and
subject to the same budgets. All provider traffic stays on the EU endpoint;
no key or user credential reaches a renderer.

Use a fitted saved-document map rather than a panned interactive view. Reveal
lazy maps before capture. Missing tiles or glyphs fail visibly; retry the map,
then capture again. The [MapView guide](/en/ui/content/map-view) describes the
complete-resource barrier, dimensions, cancellation and error codes.

For offline PDF, use `geoMapSnapshotFingerprint` from
`@k2b/cloud/contracts/geo-snapshot` to bind each PNG to the complete validated
saved GeoDocument. Submit binary images to an application-owned, authenticated
endpoint with the saved document revision. The shared
[PDF preflight](/en/docs/platform/pdf-and-templates#upload-browser-map-snapshots)
validates membership, fingerprints, dimensions, byte budgets and real decoding.
The application still owns resource authorization, revision checks, omission
reporting and linked attribution. A client's image is presentation input; it
cannot attest that the geography is truthful and must never become canonical
saved map data.

There is no server-side map renderer in this contract. Headless API or CLI PDF
exports without browser image uploads must report unavailable map images and
retain saved-source lists, or fail explicitly when map images are required.
`MapViewFrame` remains a geometry fallback and does not supply a basemap PNG.
## Use maps in Assistant

Assistant's native places and route widgets use these same permission-aware
Queries and `CloudMap`. The conversation owns saved map state and proposals;
Core remains stateless for routes. Follow-ups update the first widget, and saving
to a notebook uses the shared map document format through Notebook capabilities.
See [Explore places and routes](/en/docs/ai/chat-interface#explore-places-and-routes)
for selection, editing, recovery, and persistence behavior.
## Suggest addresses in forms

Import `AddressAutocomplete` from `@k2b/cloud/geo/ui` for a street field. It
calls `address.autocomplete` from the browser as the signed-in person, after
3 to 300 characters and a 250 ms pause, for at most 5 suggestions. A newer
query waits for the open request instead of cancelling a call that Core may
already have paid for, so one request per field is in flight.

```tsx
import { AddressAutocomplete } from "@k2b/cloud/geo/ui";

<AddressAutocomplete
  label="Street and number"
  value={street()}
  onValueChange={setStreet}
  onPick={(address) => fillFields(address)}
  onOwnEntry={() => keepTypedText()}
  availability={ssrAvailability}
/>
```

The field never fills other fields itself. `onPick` receives the chosen
`GeoAddress` with `point` and `provenance`; keep both with the stored address
and drop them when the person changes a location field later. Next to
suggestions, the list offers the typed text as its own entry: last on wide
screens, first on phones so the on-screen keyboard cannot hide it; without
suggestions it says that the typed text is saved as written. Arrow keys move, Enter takes the
active entry, and Escape closes the list and keeps the typed text. The source
line **Geoapify · OpenStreetMap** sits under the list.

Pass the SSR `geo.availability` result as `availability`. Without a configured
key the field is a plain text input. An exhausted personal or Cloud budget,
from the snapshot or from a refused request, shows one calm line with the reset
time instead of suggestions and sends no further requests.

## Link to a navigation app

Cloud does no live navigation. `geoNavigationHref` from `@k2b/cloud/geo/ui`
builds a link that hands a destination to the device's maps app:
`geo:` on Android, Apple Maps on iPhone and iPad, and OpenStreetMap
directions elsewhere. Pass a `point` when one is known, otherwise the address
text. Choose the platform with `geoNavigationPlatform(navigator.userAgent)`
after the first render, so server output and the first client render agree.
The link carries only the destination and an optional name, and it leaves
Cloud only when the person follows it.
