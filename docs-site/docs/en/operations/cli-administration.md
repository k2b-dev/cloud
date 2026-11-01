---
title: Administer Cloud through the CLI
navTitle: CLI administration
section: Operations
order: 1166
description: Read administrator diagnostics, configure settings, and approve dangerous actions through cld.
tags: [cli, administration, security, operations]
updated: 2026-10-31
---

# Administer Cloud through the CLI

Use a person's normal `cld login` profile to administer Cloud. The default
OAuth scopes are `read write`. The person must currently have the administrator
role: Cloud checks it for each request, including forwarded app operations.
An agent using that profile has the same authority as the person. Standalone
OAuth clients do not acquire the administrator role through scopes.

## Read diagnostics

```bash
cld admin diagnose --json
cld admin apps status pulse --json
cld admin settings status --env --json
cld admin capabilities executions list --query 'window=24h&limit=20' --json
cld admin telemetry browser --json
cld admin retention show --json
cld pulse admin policy get --json
```

NATS, Sync, app events, Core app status, environment status and Pulse admin
reads accept `read` or `admin` scope plus the current role. Sync dead-letter
OAuth reads redact payload previews, reasons and raw errors without explicit `admin`
scope. Schedule error text and metadata follow the same rule. Existing app and
resource restrictions remain. Read the selected module's reference before
using its commands: `cld admin reference` and `cld pulse reference`.

## Discover and configure settings

```bash
cld admin settings list --json
cld admin settings list --app gateway-ops --json
cld admin settings show gateway.nats_admin_access --app gateway-ops --json
cld admin settings set gateway.webhook_allowed_targets --app gateway-ops \
  --value '["monitoring.example"]' --yes
cld admin settings set gateway.nats_admin_access --app gateway-ops \
  --from ./private-access.json --yes
```

The inventory and `settings show` return type, presence and readability, never
stored, default or effective values. `--value` accepts non-secret JSON only.
Write a secret as a JSON string in a private file, or pass JSON on stdin with
`--from -`; never put it in an argument. Use `--replace-unreadable` only when
explicitly replacing the whole unreadable value.

Core settings include AI execution limits and network allowlists. For app
settings, select the owner with `--app`. Gateway Ops, Notebooks, Grids and
Chat use their owning setting APIs. Environment-backed app settings use the
authenticated owner process. Settings that require a custom write path use
the owner’s named command; for example, Assistant’s rsql allowlist uses
`assistant studio-admin configure` with connection preflight. NATS server changes still discard saved broker
access; configure the matching access again afterward.

Use `admin settings apply --from <file|-> --yes` for a validated Core bulk
update, and `admin settings reset <key> --yes` to restore a default. The
`admin settings legacy list|delete` commands inspect and remove obsolete
entries. Connection checks use `admin settings test pdf|storage|freeipa --yes`;
`admin ai enrichment run --yes` starts enrichment. Checks and triggers have
effects and require confirmation.

Structured configuration uses named commands so the same validation and
side effects as the UI run:

| Area | Command group |
| --- | --- |
| Navigation | `admin rail show\|set` |
| Geo | `admin geo status\|usage`, `geo key set\|remove`, `geo budget set` |
| AI projects and grants | `admin ai projects` |
| Log retention | `admin logs retention show\|set` |
| Weather | `admin weather config set\|reset` |
| Files | `filesv2 admin configuration get\|set\|reset` |
| Files machine storage and grants | `admin files machines list\|create`, `machines grants list\|grant\|revoke` |
| Studio machine access and secret metadata | `admin studio machines access list\|set`, `machines secrets list\|set\|delete` |
| Contacts administration and recovery | `admin contacts list`, `contacts access list\|grant\|set\|revoke` |
| Spaces administration and recovery | `admin spaces list`, `spaces access list\|grant\|set\|revoke`, `spaces delete` |
| Chat health | `admin chat status` |
| Proxy Auth | `admin proxy-auth` |
| Pulse policy, limits and targets | `pulse admin` |
| Assistant Studio database/storage | `assistant studio-admin` |

The new named JSON setters use `--from <file|-> --yes`; Assistant uses
`--input-file` or `--stdin` with `--yes`. Read `--help` for arguments and
`cld api-docs` for the owning API's input fields. Existing outgoing-mail,
AI model/quota, OAuth client, app key/domain and account commands continue
to use their documented input flags. Configuration changes are audited
without recording submitted secret values.

## Approve a dangerous action

Explicit `admin` scope is still required for app access repair, Sync recovery
and unredacted dead-letter content,
app-event mutations, Pulse store credentials/check/setup SQL, Pulse base
recovery and orphan deletion, Studio machine server/secret operations, and
Files machine provisioning/grants. These can change authority, recover or
delete work, contact privileged backends, or expose sensitive setup material.

For an authorized action, create a short-lived profile using browser or device
approval. Keep your usual profile for normal work:

```bash
cld login admin-step-up --server https://cloud.example --device --ttl 15m \
  --scope 'openid profile email offline_access read write admin'
cld --profile admin-step-up admin sync --help
cld logout admin-step-up
```

Approve the displayed code as the administrator. `--user` (Cloud Login)
refuses `admin` scope. Scope approval never replaces a current role or resource
permission, and actions still require their normal CLI confirmation.

## Upgrade note

Update Core, OAuth, Gateway Ops and the affected applications together, then
update the installed CLI modules with `cld plugins update --all`. Existing
normal logins retain their scopes and gain the corrected administrator read
and routine configuration behavior. OAuth's migration allows the first-party
Cloud CLI to request `admin` explicitly; it does not add it to default logins.
Custom OAuth clients keep their own approved scope ceiling.

Update scripts to pass `--yes` for domain add/set/check, Files configuration
set, Pulse store set/check/setup-sql, policy set, base limits and target changes,
and Assistant Studio configure/storage-configure/grant/change-grant. AI provider
add/update and Studio configure now reject inline `--input`; use a file or stdin.
Secret inputs must never be copied into arguments.

Application authors must expose every administrator setting through a CLI
command using the owning service. The repository's `admin-cli-settings` check
guards declared settings, including custom setters; a new setting without
CLI coverage fails the gate.
