### Keep imported fixtures independent of retired consumers

- **What happened:** A main sync introduced an integration fixture that could not typecheck on the release branch.
- **Root cause:** A current conversation test still imported a rule snapshot helper removed by the Code cut.
- **Error class:** Semantic merge drift in test dependencies.
- **Guard:** The conversation eligibility integration fixture asserts the retained Mail state directly; the package typecheck catches imports of removed consumers.
