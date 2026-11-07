### Keep migration fixtures and workflow references aligned with model classes

- **What happened:** The quota repeat-migration test failed on duplicate columns, and Mail workflow reference coverage failed on the new model classes.
- **Root cause:** Fixture-only column creation was copied into the repeat-migration test. Workflow references still described string profile IDs after the schema changed to class or variant objects.
- **Error class:** Test fixture duplication and documentation drift after a shared contract change.
- **Guard:** The repeat-migration case in `packages/cloud/src/ai/quotas.integration.test.ts` and the manifest-derived reference coverage in `packages/mail/src/help/index.test.ts`.
