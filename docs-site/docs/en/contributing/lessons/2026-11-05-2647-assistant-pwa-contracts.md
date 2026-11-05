### Keep the Assistant part fixture inside public contracts

- **What happened:** The Assistant part failed repository checks for package imports, help metadata and terminology, app selection colors, responsive chrome, geometry reads, and browser clocks.
- **Root cause:** Its new fixtures and styles bypassed existing public entry points and shared UI/testing conventions.
- **Error class:** Consumer fixtures and application chrome bypass shared contracts.
- **Guard:** The `boundaries`, `help-writing`, `host-breakpoints`, `selection-tokens`, `settle-reads`, and `test-clock` checks, plus `AssistantPwa.browser.test.ts`.
