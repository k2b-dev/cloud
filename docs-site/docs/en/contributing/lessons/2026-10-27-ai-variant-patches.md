### Partial configuration patches must preserve omitted fields

- **What happened:** A rename-only model or provider patch could reset other fields to their creation defaults.
- **Root cause:** Zod defaults inside a partial schema still populated omitted properties before merging the patch.
- **Error class:** Creation defaults applied to partial updates.
- **Guard:** `packages/cloud/src/ai/model-catalog.test.ts` checks that omitted provider, model and variant defaults stay absent; the admin route test checks the parsed PATCH passed to the catalog.
