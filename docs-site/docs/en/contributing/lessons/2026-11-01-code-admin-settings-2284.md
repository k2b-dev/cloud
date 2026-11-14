### Core-owned Code limits need a declared CLI write path

- **What happened:** The administrator CLI coverage check rejected all six Code storage settings after the integration branch gained the new rule.
- **Root cause:** Core declares these settings outside `services/settings/core-settings.ts`, the only Core declaration file that the rule automatically associates with the generic CLI setter. Their existing bulk write path had no explicit mapping.
- **Error class:** Missing CLI ownership metadata for application settings.
- **Guard:** The `admin-cli-settings` rule rejects declared settings without a CLI write path; all six keys now map to `cld admin settings apply`. The administration CLI test checks confirmation, file input and dispatch to Core's validated, transactional settings API.
