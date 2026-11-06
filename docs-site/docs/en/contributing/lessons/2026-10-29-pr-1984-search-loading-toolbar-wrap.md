### Search loading changed the phone toolbar's line count

- **What happened:** The phone toolbar shrank from 68 to 36 pixels when search results were replaced by loading placeholders. The CLI cursor test also expected name sorting for a search that now defaults to relevance.
- **Root cause:** Loading replaced the result count and Select action with a shorter label, letting the wrapping toolbar collapse to one line. The merged CLI test applied the browsing default to search as well.
- **Error class:** Transient status content changes responsive geometry; shared consumer tests retain defaults superseded by a feature.
- **Guard:** `packages/filesv2/src/frontend/Search.browser.test.ts` compares toolbar and row geometry before, during, and after loading, including German on a phone, and checks that Select is hidden while loading. `packages/cloud-cli/src/filesv2.integration.test.ts` distinguishes browsing's explicit name sort from search's server-selected default and retains explicit sort and cursor assertions.
