### Shared UI theme overrides are not new token owners

- **What happened:** The maps PDF preview and Chat both override a shared text token, so the CSS check rejected their combination.
- **Root cause:** The duplicate-owner check did not distinguish UI-owned theme tokens from application-owned properties.
- **Error class:** A repository guard rejects a supported consumer override.
- **Guard:** `scripts/checks/css.test.ts` permits independent overrides of declared UI tokens and still rejects duplicate application-owned properties and unknown UI tokens.
