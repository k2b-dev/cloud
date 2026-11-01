# Administrator operations

Use the selected person's `cld login` profile. With their current administrator
role, the default `read write` scopes cover diagnostics and routine settings.
Cloud rechecks that role per request. Scopes alone never make a standalone
OAuth client an administrator.

Read `cld admin reference` first. Start with `admin diagnose --json`, then
inspect the relevant `nats`, `sync`, `apps status`, `capabilities`, `telemetry
browser`, `retention show`, or app plugin command. Existing resource
permissions still apply. No separate diagnostics grant is required.

## Settings and secrets

```bash
cld admin settings list --json
cld admin settings list --app gateway-ops --json
cld admin settings show gateway.nats_admin_access --app gateway-ops --json
cld admin settings set gateway.webhook_allowed_targets --app gateway-ops \
  --value '["monitoring.example"]' --yes
cld admin settings set gateway.nats_admin_access --app gateway-ops \
  --from ./private-access.json --yes
```

`list` and `show` print types and presence, never values. `--value` accepts
non-secret JSON. Secret settings require JSON in a private file or stdin
(`--from -`). Never put a secret in an argument. Confirm the exact key and
owner before `--yes`; use `--replace-unreadable` only for an approved whole
replacement. NATS server changes discard the old broker access.

Use the owning structured commands for Navigation (`admin rail`), Geo
(`admin geo`), AI projects (`admin ai projects`), retention (`admin logs
retention`), Weather (`admin weather config`), Files (`filesv2 admin configuration`),
Proxy Auth (`admin proxy-auth`), Pulse (`pulse admin`), and Assistant
(`assistant studio-admin`). New named JSON setters take `--from <file|->`
and `--yes`; Assistant uses `--input-file` or `--stdin`. Check command help
and the module reference before writing. Existing outgoing-mail, AI, OAuth,
app key/domain, account and network settings keep their own documented flags.

## Explicit approval for dangerous actions

App access repair, unredacted Sync payload/error content and recovery, app-event mutations, Pulse store backend
operations and base recovery/deletion, Studio machine servers/secrets, and
Files machine provisioning/grants still need explicit `admin` scope. Only
obtain it for an action the user authorized:

```bash
cld login admin-step-up --server https://cloud.example --device --ttl 15m \
  --scope 'openid profile email offline_access read write admin'
cld --profile admin-step-up admin sync --help
cld logout admin-step-up
```

Relay the printed code and approval URL to the user. They approve it in their
own browser. `--user` cannot issue `admin`; never request a password or token.
Explicitly select the temporary profile for the approved action, keep its
normal `--yes` confirmation, then log out the temporary profile.
