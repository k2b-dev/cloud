### Preserve established failure codes during merge resolution

- **What happened:** A capability integration test failed after a branch sync changed an established error code.
- **Root cause:** Error normalization during merge resolution preserved the failure outcome but changed its machine-readable contract.
- **Error class:** Semantic contract drift during merge resolution.
- **Guard:** Keep the original capability integration assertion and test normalized responses against the established error code in the capability unit tests.
