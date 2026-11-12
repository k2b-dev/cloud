### Integration setup must follow the owner of each runtime contract

- **What happened:** OAuth token exchanges and Files machine-token integration tests failed after issuer ownership moved to the platform registry.
- **Root cause:** The OAuth fixture still used a broker secret without a signed issuer identity. The Files fixture migrated the private OAuth schema but omitted Core's client registry. Legacy display names and pending notice cleanup also retained assumptions from the previous owner.
- **Error class:** Incomplete migration of consumers and fixtures across a domain boundary.
- **Guard:** OAuth resource-token tests enroll a real issuer key. Files machine-token tests run Core's registry migration without the built-in OAuth schema. Issuer regressions cover service-bound user tokens, 200-character legacy names, notice ownership, expired delivery failures and progress past an older failing page.
