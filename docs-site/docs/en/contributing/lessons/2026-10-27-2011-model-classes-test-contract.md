### Migrate tests and operating instructions with model contracts

- **What happened:** After a test-process crash was fixed, eight assertions failed on removed CLI commands and valid bulk setting saves.
- **Root cause:** The model-classes migration left pricing and request-settings tests and CLI references on the profile contract. The geo-budget SQL fixture also rejected the new setting-writer attribution statement, making valid saves appear to fail with HTTP 500.
- **Error class:** Test and documentation drift after a contract migration.
- **Guard:** Admin CLI tests exercise model prices, model and variant patches, row revisions, validation and conflicts; request-settings help tests verify the replacement commands. Geo-budget route tests support and assert setting-writer attribution while preserving final-pair validation and unreadable-value recovery assertions.
