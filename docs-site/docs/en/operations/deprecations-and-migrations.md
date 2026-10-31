---
title: Migrate environment-backed settings
navTitle: Environment migrations
section: Operations
order: 1251
description: Import legacy network and AI environment values into administrator settings and verify the upgrade.
tags: [operations, configuration, migrations]
updated: 2026-10-30
---

# Migrate environment-backed settings

This release imports the network lists and AI limits below into administrator
settings at startup. An existing stored row always wins. Import runs only when
no row exists; it never replaces an unreadable or invalid row. Invalid
environment values produce a startup warning and are ignored. For trusted proxies, an invalid bootstrap value with no stored row stops gateway startup; correct or remove it before restarting.

## Upgrade an installation

1. Upgrade Core, the gateway, applications, and the `admin` CLI plugin together.
   Keep the existing environment values for this rollout. The gateway now needs
   the same `APP_SECRET`, Postgres settings database, and Valkey connection as
   Core. The supplied Compose files already pass them.
2. Run `cld --profile <installation> admin settings status --env --json`.
   Exit code **0** means the reported processes need no attention. Exit code
   **1** means at least one conflict, unreadable row, invalid environment value,
   pending import, or unavailable process needs attention. Authentication and
   transport failures also exit nonzero.
3. Resolve each reported problem. To keep a stored value, remove the obsolete
   environment value from that process. To replace a stored value, use
   `cld --profile <installation> admin settings set <key> --value '<JSON>' --yes`.
   For application-owned settings, also pass `--app <owner>` from the table.
   Replacing an unreadable row requires `--replace-unreadable` and an explicit
   whole value. Keep `APP_SECRET` consistent across the installation.
4. Once the check exits 0, remove the deprecated variables from every deployment
   environment and restart the affected processes. Run the check again.

The status response contains `needsAttention` and `processes`. Each process has
`appId`, `status` (`ok` or `unavailable`), and `settings`. Each setting reports
`key`, `envVariable`, `storedValuePresent`, `envValuePresent`, `conflict`
(`none`, `differs`, or `unknown`), `unreadableStoredValue`, `invalidEnvValue`,
and `needsAttention`. It never returns setting values, including secrets.
`APP_URL` is also checked because it bootstraps `app.url`. It is retained for first-start configuration; if its value differs from a deliberately changed `app.url`, update or remove `APP_URL` in each process before requiring exit 0.
An uncomparable pair reports `unknown` and requires attention.

The check reads Core and the currently registered applications. An unreachable
or older application that lacks diagnostics reports `unavailable`. Gateway
records also include `instanceId` and `sampledAt`; they come from its expiring
operations snapshot, refreshed every five seconds. A missing gateway snapshot
requires attention. Start applications that are stopped before verifying their
environment. Application diagnostics use the service address; operators with
replicas must ensure the same environment reaches every replica.

## Environment replacements

| Deprecated variable | Setting key | Owner | Changes take effect |
| --- | --- | --- | --- |
| `OUTGOING_MAIL_ALLOWED_TARGETS` | `outgoing_mail.allowed_targets` | Platform / Core | New SMTP and IMAP connections |
| `GATEWAY_TRUSTED_PROXIES` | `gateway.trusted_proxies` | Platform / Core | After gateway restart |
| `GATEWAY_OPS_WEBHOOK_ALLOWED_TARGETS` | `gateway.webhook_allowed_targets` | `gateway-ops` | New webhook deliveries |
| `ASSISTANT_RSQL_ALLOWED_TARGETS` | `assistant.rsql_allowed_targets` | `assistant` | New rsql requests |
| `NOTEBOOKS_SNAPSHOT_ALLOWED_TARGETS` | `notebooks.snapshot_allowed_targets` | `notebooks` | New snapshot requests |
| `WORKFLOW_AI_BUDGET` | `ai.workflow_budget` | Platform / Core | New work; restart all AI workers for `globalConcurrent` |
| `WORKFLOW_AI_ATTEMPT_TIMEOUT_MS` | `ai.workflow_attempt_timeout_ms` | Platform / Core | New attempts |
| `WORKFLOW_AI_QUEUE_TIMEOUT_MS` | `ai.workflow_queue_timeout_ms` | Platform / Core | New requests and the next recovery scan |
| `MAIL_WORKFLOW_AI_BODY_MAX_CHARS` | `mail.workflow_ai_body_max_chars` | `mail` | New AI work |
| `GOTENBERG_URL` | `gotenberg.url` | Platform / Core | New PDF requests |

Administrators edit the application-owned settings in Administration:
`gateway.webhook_allowed_targets` under **Observability → Health check**,
`assistant.rsql_allowed_targets` in **Database settings** on the Studio
administration page (`/admin/assistant`), `notebooks.snapshot_allowed_targets`
under **Settings** on `/admin/notebooks`, and `mail.workflow_ai_body_max_chars`
on `/admin/mail`. A refused value shows its reason at the field. With `cld`, use
`settings set --app <app>` for these keys.

Network settings accept comma-separated or newline-separated strings and JSON
string arrays. Existing exact-host, IP, CIDR and port rules remain in force;
`/0` is rejected, including in trusted-proxy lists. Trusted proxies accept only IPs and CIDRs. The gateway reads
and validates its stored list before serving HTTP. An unreadable or invalid
row stops startup and names the repair command. On a fresh installation, the gateway waits up to five minutes for Core to create the settings table, keeping HTTP closed. When no stored list exists, the
existing loopback and private-network default applies.

If the gateway cannot start, run the repair command with a CLI profile
configured and authenticated for Core's private listener. This lets Core save
the corrected list while gateway HTTP remains closed. Restart the gateway
after the repair.

`ai.workflow_budget` is a JSON object encoded as text, with the same six
positive whole-number fields as `WORKFLOW_AI_BUDGET`. For example, pass
`--value '"{\"maxStepsPerSource\":2,\"tasksPerMinute\":10,\"burst\":20,\"sourcesPer24Hours\":2000,\"scopeConcurrent\":1,\"globalConcurrent\":4}"'`.
The worker capacity is established at startup; changing `globalConcurrent`
requires a coordinated restart of all AI workers.

The nine migrated settings use the environment only for bootstrap. Removing a
stored row restores its code default until the next startup; a still-present
legacy variable can import again at that startup. `GOTENBERG_URL` now also only
bootstraps, and no longer supplies a read-time fallback. Retain the settings
database and `APP_SECRET` when rolling back during this parallel release.
These bootstrap variables are scheduled for removal in the next major step.

## Other deprecated variables

- `CLOUD_IDENTITY_JWKS_ORIGIN`: replace with `CLOUD_CORE_INTERNAL_ORIGIN`.
  The explicit legacy value still wins during this release and logs a startup
  warning. Without either variable, JWKS resolution still uses the issuer.
- `GATEWAY_INSTANCE_ID`: remove it. The gateway uses a random per-process ID.
  An explicit legacy ID is still honored during this release with a startup
  warning.
- `GOTENBERG_URL`: migrate using the table above. A startup warning reminds
  operators to remove it after verification.

See [Runtime configuration](/en/docs/operations/runtime-configuration) for the
remaining process environment and [Settings kinds and environment](/en/docs/reference/settings-kinds-and-environment)
for setting resolution and validation.
