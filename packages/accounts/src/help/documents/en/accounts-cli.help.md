---
id: accounts-cli
title: CLI
icon: ti ti-terminal-2
description: Agent-friendly account, group, request, audit, and service-account commands.
order: 120
---

The Accounts CLI uses the same `/api/accounts` API as the app, so agents can list, inspect, and update account data without a browser.

## Command groups {icon="code"}

:::reference
- **users:** List, inspect, create, update, delete, change provider/profile/admin state, manage avatars, reset IPA passwords, and send login links.
- **groups:** List, inspect, create, update, make POSIX, delete, and manage members or managers.
- **requests:** List, inspect, and deny account requests.
- **audit:** List audit events with actor, target, action, action group, service-account, outcome, provider, and time filters.
- **service-accounts:** List service-account API keys and revoke active credentials.
:::

:::info Reference output
Use JSON output for automation. Table output is intended for quick terminal inspection.
:::
