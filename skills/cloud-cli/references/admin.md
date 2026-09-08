# Administration CLI

## What Administration is

Administration is the operational view of a Cloud instance: gateway state, registered apps, routes, observability, storage diagnostics, notifications, announcements, webhooks, and metrics.

Use `cld admin` when operating a Cloud instance as an administrator. Commands inspect the selected remote Cloud instance and use the permissions of the signed-in administrator.

## Start with health and diagnostics

```bash
cld admin status --json
cld admin apps list --json
cld admin routes list --range 24h --json
cld admin diagnose --since 6h --include health,logs,telemetry,jobs,postgres,redis,metrics --json
```

Route hit and error counts are scoped to `--range` (1h, 6h, 24h, 7d, 30d). They used to be cumulative since the gateway router last restarted, which made a long-lived router look healthy while it was failing every request.

Use `diagnose` for a bounded troubleshooting bundle. Narrow its time window and included sections before requesting more data. Its `telemetry.failingRoutes` and `jobs` sections name the endpoints and background jobs that are actually failing, which is usually the fastest way into a problem.

## Logs and storage diagnostics

```bash
cld admin logs errors --since 24h --search "timeout" --json
cld admin logs list --source gateway --level warn --since 6h --json
cld admin postgres summary --json
cld admin redis summary --json
```

`redis summary` reports memory against `maxmemory`, evicted keys with the active eviction policy, cache hit rate and connected clients alongside the keyspace counts. A rising eviction count or a falling hit rate is the signal that Redis is under pressure; key counts alone will not show it.

Use `cld admin logs show <id> --json` for the full details of a selected log entry, and `cld admin logs explain <id> --json` to get that entry together with nearby context. The `postgres` and `redis` command groups also provide tables, schemas, extensions, and sampled prefix views; read their command help before narrowing a diagnostic.

## Request telemetry

Start with `telemetry routes`, not with individual events. Routes are real route templates such as `/api/mail/mailboxes/:id`, so a failing endpoint is identifiable; an aggregate request count is usually dominated by one busy route and says very little.

```bash
cld admin telemetry routes --sort errorRate --range 24h --json
cld admin telemetry routes --sort requests --range 7d --json
cld admin telemetry overview --range 24h --app mail --json
cld admin telemetry explain "/api/mail/mailboxes/:id" --json
```

Ranges are `1h`, `6h`, `24h`, `7d`, and `30d`. Sort by `errorRate` to find what is broken and by `requests` to find what is popular; `errors`, `slow`, and `duration` are also available. `errorRate` ignores routes below 20 requests so a single failure cannot top the list. Narrow to failing routes with `--errors`, to slow ones with `--slow`.

`telemetry overview` counts server errors (5xx), client errors (4xx), and rate limits (429) separately — a rate-limited caller and a broken endpoint need different responses. `telemetry explain <route>` bundles one route's error breakdown, recent requests, and related error logs. `telemetry timeseries` places when a change started.

The older `telemetry summary`, `telemetry events`, and `telemetry apps` remain for raw event access.

## Background jobs

```bash
cld admin jobs list --json
cld admin jobs list --health stuck --json
cld admin jobs list --health failed --window 7d --json
cld admin jobs runs --source gateway:telemetry:cleanup --json
cld admin jobs show <traceId>:<spanId> --json
```

Run statistics are scoped to `--window` (10m, 1h, 12h, 24h, 7d, 30d) and exclude schedule-definition spans, which are registration records rather than runs.

Three states are deliberately distinct:

- **running** — open and started recently, genuinely in flight.
- **stuck** — open past the abandonment threshold. Nothing is working on these; a process died mid-run and left the span open. Stuck is counted across all retained spans rather than within the window, because an abandonment is old by definition and a windowed count would hide it.
- **anomalous** — finished, but took longer than that threshold. These come from sweeps closing orphaned spans long after the fact and are excluded from the duration percentiles so those describe real runs.

`--health failed` means the most recent run of a source failed, i.e. it is unhealthy right now — it does not list every source that has ever failed. `--health stuck` lists sources with abandoned spans. Use `jobs runs --source <id>` for run history and `jobs show` for a single run with its recorded events, which is the closest thing a background job has to a log. These commands are read-only; trigger a schedule from the admin UI.

## Workflows

```bash
cld admin workflows health --json
cld admin workflows runs --state failed --json
cld admin workflows runs --state needs_attention --window 7d --json
cld admin workflows show <run-id> --json
cld admin workflows effects --json
cld admin workflows events --json
cld admin workflows cancel <run-id> --yes
cld admin workflows resolve <run-id> <step-key> --decision failed --message "provider rejected it" --yes
```

Every app's workflow runs live in one schema, so these read across all of them; `--app` narrows `runs`, `effects`, and `events` to one. Start with `workflows health`, which is one row per app and takes only `--window`. Windows here are `1h`, `24h`, `7d`, and `30d` — a narrower set than the background-job windows above.

Four columns there are the ones worth acting on:

- **stranded** — effects that left the process and never reported back. A replay refuses to repeat them, because repeating is how the same message goes out twice, so each is a run that cannot continue until a human decides. `workflows effects` lists them.
- **undispatched** — events that never turned into runs, either matching no activation or failing to dispatch. This is what a workflow that silently stopped firing looks like: the occurrence happened, nothing ran, and nothing errored anywhere visible. `workflows events` lists them with `attempts` and the last error.
- **attention** — runs that need a decision rather than a retry.
- **worst lag** — the gap between the occurrence that caused a run and the run actually starting. A growing lag means the workers are behind, not that anything failed.

`workflows runs` hides the child runs of a fan-out unless `--children` is passed; use `--parent <run-id>` to list one fan-out's direct children. A bulk operation over ten thousand records would otherwise bury everything else. `workflows show` gives one run with its steps, the event that caused it, and its effect budget as `used/limit`. `runs`, `effects`, and `events` page with `--page` and `--limit`.

Two deliberate mutations mirror the admin UI. Both require `--yes`: `workflows cancel` requests cooperative cancellation without undoing completed effects, while `workflows resolve` records external evidence for a stranded effect without repeating it.

Mind the vocabulary in these outputs. A **run** is `queued`, `running`, `waiting`, `succeeded`, `failed`, `canceled`, or `needs_attention`, and `--state` accepts exactly those. A **step** in `workflows show` has its own set — `running`, `completed`, `waiting`, `failed`, `needs_attention`, `terminal`, `planned`, `unsupported`, `indeterminate`, `canceled` — so a finished step reads `completed`, never `succeeded`. The `Effect` column beside it is the effect journal's state, not the step's.

The same runs are visible in the browser at `/admin/observability/workflows`. Apps do not keep their own run tables, so there is no per-app equivalent of these commands; an app CLI only reads its own scope, as `cld grids workflow-runs` does for one base.

## Notifications and announcements

```bash
cld admin notifications list --status error --json
cld admin notifications summary --json
cld admin announcements list --json
cld admin announcements create --title "Maintenance" --body-file ./maintenance.md --tone warning
```

Notification batches are drafts until explicitly finalized. Create them with a Markdown body and an audience-selection JSON file, inspect the resulting draft, then finalize only after the intended recipients are confirmed:

```bash
cld admin notification-batches create --subject "Maintenance" --body-file ./maintenance.md --selection-file ./audience.json
cld admin notification-batches get <batch-id> --json
cld admin notification-batches finalize <batch-id> --yes
```

Use the exact command help to prepare the audience-selection JSON and to retry failed recipients. Deleting a draft cannot be undone.

## Legal documents

Terms, Privacy, and Imprint can use local Markdown or redirect to an external
URL. Inspect the effective source before changing it:

```bash
cld admin legal list
cld admin legal get terms --json
cld admin legal set terms --content-file ./terms.md
cld admin legal set privacy --url https://example.org/privacy
cld admin legal reset imprint --yes
```

`set` accepts exactly one content source or URL. Local Markdown can be passed
directly, from a file, or through standard input. `reset` clears the complete
document configuration and requires confirmation.

## Linux identities

```bash
cld admin linux config get --json > ./linux.json
cld admin linux preview --json
```

Edit the exported configuration's `enabled`, `rangeStart`, `rangeEnd`,
`homeTemplate` and `loginShell` fields. Reserve the numeric range across all
connected systems before enabling preparation. Apply the complete file with:

```bash
cld admin linux config set --config-file ./linux.json --range-reserved --yes
```

Use exactly one of `--config`, `--config-file` or `--stdin`. Enabled
configuration always requires `--range-reserved`; disabling with `enabled:false`
requires only `--yes` and retains existing identities. The server checks current
FreeIPA ranges and known identities before accepting the configuration.

Preview is read-only and returns up to 50 accounts plus `nextCursor`. Continue
with `preview --after <nextCursor> --json` until the cursor is null. Individual
preparation and home/shell changes live under `cld accounts users linux`;
`cld accounts groups make-posix` also supports local groups. No command here
enables computer login, sudo or shared storage.

## Webhooks and metrics

```bash
cld admin webhooks list --json
cld admin webhooks create --name "Ops alert" --url https://example.org/webhook --min-status error
cld admin metrics status --json
cld admin metrics catalogue --category postgres --json
cld admin metrics read
```

Webhook changes affect health notifications. Test a webhook with `cld admin webhooks test --help` before relying on it. Metrics tokens are secrets: creating one prints the token once, and revocation requires `--yes`.

## Complete command catalogue

Run `cld admin <command> --help` for flags, filters, pagination, and confirmation requirements.

| Area | Commands |
| --- | --- |
| Instance | `status`, `diagnose` |
| App registry | `apps list`, `apps get`, `apps remove` |
| Routes | `routes list` (windowed via `--range`) |
| Logs | `logs list`, `logs summary`, `logs stats`, `logs errors`, `logs problems`, `logs show`, `logs explain`, `logs tail`, `logs sources`, `logs cleanup` |
| Telemetry | `telemetry routes`, `telemetry overview`, `telemetry timeseries`, `telemetry explain`, `telemetry summary`, `telemetry events`, `telemetry apps` |
| Background jobs | `jobs list`, `jobs stats`, `jobs runs`, `jobs show` |
| Workflows | `workflows health`, `workflows runs`, `workflows show`, `workflows cancel`, `workflows effects`, `workflows resolve`, `workflows events` |
| Postgres diagnostics | `postgres summary`, `postgres tables`, `postgres schemas`, `postgres extensions`, `postgres indexes`, `postgres sessions` |
| Redis diagnostics | `redis summary`, `redis prefixes` |
| Notifications | `notifications list`, `notifications summary`, `notifications get`, `notifications resend`, `notifications pending-system`, `notifications send-pending-system` |
| Notification batches | `notification-batches list`, `notification-batches preview`, `notification-batches create`, `notification-batches get`, `notification-batches finalize`, `notification-batches recipients`, `notification-batches retry-failed`, `notification-batches retry-recipient`, `notification-batches delete-draft` |
| Announcements | `announcements list`, `announcements create`, `announcements update`, `announcements delete` |
| Legal documents | `legal list`, `legal get`, `legal set`, `legal reset` |
| Linux identities | `linux preview`, `linux config get`, `linux config set` |
| Webhooks | `webhooks list`, `webhooks get`, `webhooks apply`, `webhooks create`, `webhooks update`, `webhooks test`, `webhooks delete` |
| Metrics | `metrics status`, `metrics read`, `metrics catalogue`, `metrics tokens list`, `metrics tokens create`, `metrics tokens revoke` |
