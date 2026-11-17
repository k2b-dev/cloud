### Period arrows carried a class with no stylesheet rule

- **What happened:** The UI class-contract test failed for both the UI job and its unit shard.
- **Root cause:** PeriodPicker added a step class only for test selectors; IconButton already supplied all arrow styling.
- **Error class:** Test-only styling hooks in component markup.
- **Guard:** The existing class-contract test rejects unstyled classes. Period stepping browser tests now find the arrows by their accessible names and check focus on the actual button.
