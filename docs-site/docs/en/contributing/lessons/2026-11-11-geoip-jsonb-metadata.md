### Uploaded database metadata was stored as a JSON string

- **What happened:** GeoIP status could not read an uploaded database's size or description from its metadata.
- **Root cause:** A pre-serialized JSON parameter was bound directly to `::jsonb`, so Bun encoded it again.
- **Error class:** Serialized JSON was bound as a JSON string.
- **Guard:** The existing `sql-jsonb-text` check now covers GeoIP without a baseline exemption. `geoip.integration.test.ts` checks the uploaded metadata's type and public size, plus idempotent repair of earlier rows without changing database contents or attribution.
