### A select option colour took any text

- **What happened:** A Grids select field stored any string as an option's colour. The table showed only hex colours and eight colour names. The field editor showed a name such as "blue" as black, and an API client could store text that no screen could show.
- **Root cause:** `SelectOptionSchema` in `packages/grids/src/field-types/select.ts` typed `color` as a plain string. Only the browser checked colours, and only when it drew them.
- **Error class:** A value with a closed set of forms that the server accepts as free text and only its readers check.
- **Guard:** Writing a field refuses any colour that is not a hex colour or a known name, with a 400 that names the allowed forms. Reading turns a name into its hex value and drops any other colour, so older configurations still work. `packages/grids/src/field-types/select-colors.test.ts` walks the JSON schema of every writable Grids schema and fails on a colour property without a pattern or an enum. The route test in `core-resource-routes.integration.test.ts` checks the 400 and the reading.
