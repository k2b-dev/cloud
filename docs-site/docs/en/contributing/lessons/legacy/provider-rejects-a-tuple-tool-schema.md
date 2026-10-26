### Provider rejects a tuple tool schema

- **What happened:** OpenAI-compatible providers rejected the whole tool list with HTTP 400, which ended the turn ([#1149](https://github.com/k2b-dev/cloud/issues/1149)).
- **Root cause:** The Notebooks `note.edit` input uses a tuple. The AI schema reducer kept its `prefixItems` and `items: false`, Zod rebuilt the tuple, and Nessi sent it to the provider as a list of item schemas (`items: [...]` with `additionalItems: false`), which the provider does not accept.
- **Error class:** Foreign system contracts.
- **Guard:** The reducer rewrites every tuple as a bounded array of its item schemas, and `tests/capability-tool-schemas.test.ts` checks the provider shape of every app's capability tools.
