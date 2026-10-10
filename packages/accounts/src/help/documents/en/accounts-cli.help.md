---
id: accounts-cli
title: CLI
icon: ti ti-terminal-2
description: Use agent-friendly commands for accounts, groups, requests, audit events, and service accounts.
order: 120
---

The Accounts CLI uses the same APIs as the app, so agents can list, inspect, and update account data without a browser. Linux identities use a separate API that only administrators can call.

## Find the right command group {icon="code"}

:::reference
- **users:** List, inspect, create, update, and delete users. Change their provider, profile, or administrator state. Read, set, and remove avatars, reset IPA passwords, create sign-in tokens, and send sign-in links. When the installation allows local accounts without email, `users create` accepts a local full account without `--email`, and `users update --remove-email` removes an address.
- **groups:** List, inspect, create, update, make POSIX, and delete groups. List, add, and remove members and managers.
- **requests:** List, inspect, and deny account requests.
- **audit:** List audit events, filtered by actor, target, action, action group, service account, outcome, provider, and time.
- **service-accounts:** List the API keys of service accounts and revoke active credentials.
:::

:::info Choose the output format
Use JSON output for automation. Table output is for a quick look in the terminal.
:::

## Prepare Linux identities {icon="terminal"}

- Inspect an identity with `cld accounts users linux get <user> --json`.
- After the global setup, `users linux prepare <user> --yes` adds missing attributes to an existing local full account. While assignment is on, new local full accounts and promoted guests get these attributes automatically.
- `users linux update <user> --home /home/alice --shell /bin/bash --yes` sets both paths.
- `cld accounts groups make-posix <group> --yes` works for local and FreeIPA groups.

`cld admin linux` holds the global configuration and a paginated preview. Export the configuration with `config get --json`. Apply an enabled configuration with `config set --config-file ./linux.json --range-reserved --yes`. Preparing an identity does not enable computer sign-in, sudo, or shared storage.

To create a local group with a GID in one step, run `cld accounts groups create team --provider local --posix`. Without `--posix`, the group stays a logical group. Creating or converting a local POSIX group needs enabled local Linux identities. If either fails, no partly created group stays behind.
