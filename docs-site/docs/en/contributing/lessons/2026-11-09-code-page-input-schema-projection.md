### Generate page author types from schema inputs

- **What happened:** Adding line-chart gaps made Code SDK generation fail for every page.
- **Root cause:** The page type projection exported the parsed output schema. The nested chart schema transforms JSON null gaps into numeric missing observations, which cannot be represented as an output JSON Schema.
- **Error class:** Parsed representation used as an author input contract.
- **Guard:** `generator.test.ts` generates the complete SDK and compiles a forecast line with a null gap and a marker. `charts.test.ts` checks that the exported input schema accepts null gaps and rejects nonnumeric observations. Both page and chart declarations project the schema input; the runtime still validates and normalizes the supplied chart.
