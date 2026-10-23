# Geoapify response fixtures

These fixtures are adapted from the public Geoapify OpenAPI examples at
[geoapify/geoapify-openapi-specs](https://github.com/geoapify/geoapify-openapi-specs/tree/dd07a5f).
They cover autocomplete, forward and reverse geocoding, and Places GeoJSON.
`along.json` uses the Places response shape; the service test supplies
synthetic corridor coordinates to check ordering, the window, and distance.
`routing.json` and `route.test-fixture.ts` supply entirely synthetic stopover
legs and waypoint permutations in the documented Routing JSON response shape (`format=json`). Optimized waypoint
order uses `results[0].waypoints` as documented by the provider. Waypoint
locations may differ from geometry endpoints, as in the published JSON example;
no input-to-road snap-distance tolerance is assumed. Raw route responses are bounded at 26 ×
256 KiB, then compacted to the 256 KiB public result budget.
Opening hours use the documented `datasource.raw.opening_hours` field.

Tests use only the placeholder key `test-placeholder-key` and a frozen clock.
No fixture was obtained through an authenticated provider request.
