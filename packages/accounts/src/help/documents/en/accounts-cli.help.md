---
id: accounts-cli
title: CLI
icon: ti ti-terminal-2
description: Agent-friendly account, group, request, audit, and service-account commands.
order: 120
---

The Accounts CLI uses the same APIs as the app, so agents can list, inspect, and update account data without a browser. Linux identities use the dedicated administrator-only API.

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

## Linux identities

Inspect with `cld accounts users linux get <user> --json`. After global setup,
prepare a local full account with `users linux prepare <user> --yes`.
Set both paths with `users linux update <user> --home /home/alice --shell /bin/bash --yes`.
`cld accounts groups make-posix <group> --yes` supports local and FreeIPA groups.

Global configuration and paginated preview live under `cld admin linux`.
Use `config get --json` to export it and
`config set --config-file ./linux.json --range-reserved --yes` to apply an enabled
configuration. Preparation does not enable computer login, sudo or shared storage.
