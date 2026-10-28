### Activity keys leaked into note labels

- **What happened:** The note detail panel displayed “note created” instead of a translated sentence.
- **Root cause:** Separate switches mapped open action strings and rendered unknown keys by replacing dots with spaces.
- **Error class:** An open string enum mapped to UI text through a raw-key fallback.
- **Guard:** Notebooks uses a typed action union, an exhaustive English/German activity catalog, and neutral unknown-action labels. `activity-messages.test.ts` scans service activity literals and checks both actor forms and fallbacks; `activity.integration.test.ts` checks filtered paging past unknown stored actions.
