### Pulse dashboards showed DB-IP countries without the required link

- **What happened:** A Pulse map or table over saved `ipCountry()` results showed no "IP Geolocation by DB-IP" link, and dashboard descriptions are plain text, so an application author could not meet the CC BY 4.0 terms of DB-IP Lite (#2706).
- **Root cause:** The lookup returned `attribution`, but the country was saved as a plain dimension. Pulse displayed the saved result later and never asked which database produced it.
- **Error class:** A licence obligation travels with a lookup result but is dropped when the result is stored and shown by another component.
- **Guard:** Each panel result carries `attribution` from the active City database for map panels and panels whose SQL mentions `country` (`dashboard-panels.test.ts`, `dashboards.integration.test.ts`). `Dashboard.browser.test.ts` requires the link on a map in light and dark, no link on other panels, and none while the City database is from another provider.
