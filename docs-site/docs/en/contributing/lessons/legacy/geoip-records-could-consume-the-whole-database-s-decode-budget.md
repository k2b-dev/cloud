### GeoIP records could consume the whole database's decode budget

- **What happened:** A valid MMDB record containing millions of empty strings passed the upload probe and consumed hundreds of megabytes on each lookup. Distinct large records reached by the probe's addresses also stayed in memory together.
- **Root cause:** Record validation bounded nodes by the data section's size and did not charge scalar payload bytes; the probe's batch kept every decoded record until it ended.
- **Error class:** Decode work bounded only by file size.
- **Guard:** `geoip.test.ts` checks records just below and above 32 KiB, failure isolation and refusal of a valid huge array. GeoIP `index.test.ts` checks upload refusal, shared pointers, and that the probe decodes each address on its own.
