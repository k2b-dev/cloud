# Geoapify response fixtures

These fixtures are adapted from the public Geoapify OpenAPI examples at
[geoapify/geoapify-openapi-specs](https://github.com/geoapify/geoapify-openapi-specs/tree/dd07a5f).
They cover autocomplete, forward and reverse geocoding, and Places GeoJSON.
`along.json` uses the Places response shape; the service test supplies
synthetic corridor coordinates to check ordering, the window, and distance.
Opening hours use the documented `datasource.raw.opening_hours` field.

Tests use only the placeholder key `test-placeholder-key` and a frozen clock.
No fixture was obtained through an authenticated provider request.
