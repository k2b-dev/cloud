### A wrong app hint hid an available map tool

- **What happened:** A map request ended in an external link because `search_tools({appId: "venue", query: "map location"})` returned no tools, although Core's geo capabilities were live and callable.
- **Root cause:** An empty app-scoped search was treated as a missing platform feature, and localized operation titles were absent from the search index.
- **Error class:** A wrong app hint hides an available tool.
- **Guard:** Test: Cloud `ai/capabilities.test.ts` searches map, address and route terms through the resolver with a wrong app hint, loads and calls the returned map tool, and checks that fallback preserves app visibility, fixed scopes and mandate grants.
