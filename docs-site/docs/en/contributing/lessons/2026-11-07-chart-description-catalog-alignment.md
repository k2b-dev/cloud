### Keep portable descriptions aligned as chart kinds land

- **What happened:** A new area schema landed while portable description ownership was being moved to UI. Their combined type contract needs the area variant in both layers. Stats change text also selected its points suffix outside the message catalog.
- **Root cause:** Parallel additions changed the validator and description separately; a locale prefix check bypassed catalog fallback.
- **Error class:** Declarative contracts and localized presentation drifting across package boundaries.
- **Guard:** Internal compile-time equality assertions still check the validator and UI types in both directions. Existing area tests cover its nullable series. Stats fixtures check English, German and an unsupported locale through the Cloud message catalog. The assertions remain internal instead of extending Editor's public API.
