### Keep chart examples in the registered catalog

- **What happened:** Adding Sankey guidance broke Assistant startup, production bundling and tests that imported its skill registry.
- **Root cause:** The data-analysis skill mentioned a Code skill reference path as if it were its own declared reference. Skill validation correctly rejected the missing reference before the application could start.
- **Error class:** Cross-skill reference leakage through duplicated guidance.
- **Guard:** `packages/assistant/src/skills.test.ts` imports and validates the complete registry. Sankey now uses the generated chart catalog and registered Code reference. The catalog generator retains the endpoints of its shortened link list; `packages/cloud/src/ai/sankey.test.ts` and the catalog tests validate the generated examples through the model and saved-view schemas.

Add new chart guidance to its showcase example and run `bun scripts/generate-chart-catalog.ts`. Do not add an undeclared reference path to another skill's instructions.
