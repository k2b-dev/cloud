### Code metadata needs documentation and locale validation

- **What happened:** The new Code pages failed documentation validation, and Code Queries had German titles but no German input descriptions.
- **Root cause:** Local verification omitted the documentation validator and the built-in capability presentation test, which checks input fields as well as titles.
- **Error class:** Incomplete metadata at documentation and localization boundaries.
- **Guard:** Run `bun docs-site/scripts/check-documentation.ts` and `tests/capability-presentation.test.ts` when adding documentation pages or built-in capabilities. They reject missing navigation metadata, invalid sections, duplicate section orders and missing German input descriptions.
