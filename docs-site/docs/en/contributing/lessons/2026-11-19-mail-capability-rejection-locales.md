### Mail capabilities exposed untranslated validation details

- **What happened:** A German draft creation request displayed “A verified sender identity is required” with the generic `BAD_INPUT` code.
- **Root cause:** Shared sender validation returned an English-only input error. Mail localized the capability result, but its generic German input fallback appended that English detail.
- **Error class:** Domain failures without stable reasons cross a localized application boundary as raw dependency text.
- **Guard:** `capabilities.test.ts` exercises draft creation and sending in both review and run, across `en`, `de` and `de-CH`, for validation, access, lifecycle, recovery and service errors. It requires final localized messages and unchanged error metadata; `error-messages.test.ts` checks the stable sender code, address and setup guidance. `drafts.integration.test.ts` pins the real SQL rejection in creation and send loading, with unchanged draft state.
