# Administration CLI

## What Administration is

Administration is the operational view of a Cloud instance: gateway state, registered apps, routes, observability, storage diagnostics, notifications, announcements, webhooks, and metrics.

Use `cld admin` when operating a Cloud instance as an administrator. Commands inspect the selected remote Cloud instance and use the permissions of the signed-in administrator.

## Start with health and diagnostics

```bash
cld admin status --json
cld admin apps list --json
cld admin routes list --range 24h --json
cld admin diagnose --since 6h --include health,logs,telemetry,jobs,postgres,redis,metrics,sync,nats --json
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

`postgres summary` includes deadlocks since statistics reset and the ages of the oldest transaction and active query. `postgres tables` includes sequential and index scan counts since reset. These counters describe activity; a sequential scan alone does not prove that an index is missing.

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
cld admin jobs list --type backfill --window 7d --json
cld admin jobs runs --source gateway:telemetry:cleanup --json
cld admin jobs show <traceId>:<spanId> --json
```

Run statistics are scoped to `--window` (10m, 1h, 12h, 24h, 7d, 30d) and exclude schedule-definition spans, which are registration records rather than runs.

Three states are deliberately distinct:

- **running** — open and started recently, genuinely in flight.
- **stuck** — open past the abandonment threshold. Nothing is working on these; a process died mid-run and left the span open. Stuck is counted across all retained spans rather than within the window, because an abandonment is old by definition and a windowed count would hide it.
- **anomalous** — finished, but took longer than that threshold. These come from sweeps closing orphaned spans long after the fact and are excluded from the duration percentiles so those describe real runs.

`--health failed` means the most recent run of a source failed, i.e. it is unhealthy right now — it does not list every source that has ever failed. `--health stuck` lists sources with abandoned spans. Use `jobs runs --source <id>` for run history and `jobs show` for a single run with its recorded events, which is the closest thing a background job has to a log. These commands are read-only; trigger a schedule from the admin UI.

Backfills process existing records. Sync pump runs appear under `--type backfill`;
their source is the pump ID. Inspect the returned source with `jobs runs` and
the returned run ID with `jobs show`. A completed pump does not prove that all
dispatched jobs succeeded; inspect those job sources separately.

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

## Account categories

`admin accounts config get --json` returns the complete policy for `guest`,
`login`, and `freeipa`. Each has independent `enabled` and `visible` booleans;
`login` also has a configurable `label` (default `Login`). Save the complete
object with `admin accounts config set --config-file ./accounts.json --yes`,
or use exactly one of `--config` and `--stdin` instead.

Hiding a category only removes it from the general login selector; allowed
accounts can still use direct login links. Disabling also blocks subsequent
user-bound authentication, including existing sessions and delegated credentials.
Data and credentials are retained. Disabling your own category can prevent your
next CLI request. Emergency recovery requires a valid admin token and explicit
confirmation to re-enable all local Login accounts; visibility is preserved.

## Linux identities

```bash
cld admin linux config get --json > ./linux.json
cld admin linux preview --json
```

Edit the exported configuration's `enabled`, `rangeStart`, `rangeEnd`,
`homeTemplate` and `loginShell` fields. Reserve the numeric range across all
connected systems before enabling identity assignment. Apply the complete file with:

```bash
cld admin linux config set --config-file ./linux.json --range-reserved --yes
```

Use exactly one of `--config`, `--config-file` or `--stdin`. Enabled
configuration always requires `--range-reserved`; disabling with `enabled:false`
requires only `--yes` and retains existing identities. The server checks current
FreeIPA ranges and known identities before accepting the configuration.

While enabled, new local full accounts and local guests promoted to full accounts
receive Linux attributes automatically. Failure rolls back the account change.
Existing accounts require an explicit backfill; enabling does not modify them.
Guests and FreeIPA-managed accounts do not receive local identities.

Preview is read-only and returns up to 50 accounts plus `nextCursor`. Continue
with the same `--search <username>` and `--scope ready|all` filters when used;
the default scope is `all`. Filtering happens before pagination. Continue
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
| Account categories | `accounts config get`, `accounts config set` |
| Webhooks | `webhooks list`, `webhooks get`, `webhooks apply`, `webhooks create`, `webhooks update`, `webhooks test`, `webhooks delete` |
| Metrics | `metrics status`, `metrics read`, `metrics catalogue`, `metrics tokens list`, `metrics tokens create`, `metrics tokens revoke` |
| Agents | `agents create`, `agents ls`, `agents revoke`, `agents rotate-secret` |

## AI usage and feedback

Use `cld admin ai usage report --json` for the complete filtered report.
List commands are `users`, `models`, `tasks`, `apps`, `launches`, `capabilities`,
`feedback`, and `runs`. Discover identifiers with
`cld admin ai usage facets --field userId --search <name> --json`.

Shared filters: `--range 24h|7d|30d|90d`, `--user <uuid|unassigned>`,
`--model <profile-id>`, `--provider-model <model>`, and `--app <app-id>`.
Use `--sort negativeRate` or `--sort negative` for user/model comparisons.
Use `--direction asc|desc` to choose the comparison sort direction (default: `desc`).
Feedback accepts `--rating up|down` and `--reason`; runs accept
`--kind chat|background|tool`, `--status`, `--task`, `--error-code`, and `--search`.
These local filters affect only their list, preserving report denominators.

List JSON includes `items`, `total`, `page`, `perPage`, and the resolved query.
Use `--page` and `--per-page` (1–100) and preserve `--until` from the first
response when collecting pages. `--jsonl` emits one full item per line from
that page. `cld admin ai usage get <kind> <uuid> --json` reads a single run,
including its full stored error. No command exposes private chat message text.


## Sync and NATS

`admin sync` inspects application-owned work; `admin nats` reads broker diagnostics.
Both use administrator access; OAuth callers need the `admin` scope.

```bash
cld admin sync status --json
cld admin sync resources list --app mail --problems --json
cld admin sync dead-letters list <app> <queue|job|topic> <store> --limit 20 --json
cld admin sync dead-letters get <app> <queue|job|topic> <store> <message> --sequence <streamSequence> --json
cld admin sync schedules list --app mail --json
cld admin nats status --json
cld admin nats streams list --app mail --namespace dev --problems --limit 20 --json
cld admin nats consumers list <stream> --json
cld admin diagnose --include sync,nats --json
```

Follow `nextCursor` using `--cursor` for Sync stores, or `nextOffset` using
`--offset` for NATS lists. Store pages show oldest retained failures first.
Queue/job details need the list entry's `streamSequence`; topic details do not.
JSON retains completeness and page metadata. JSONL lists start with a typed
`snapshot` record, followed by typed entries. A partial scan is not proof that
unlisted resources are healthy. `diagnose` excludes payload previews.

After inspecting a failure, queue/job `sync dead-letters requeue`, topic
`sync dead-letters replay` (with `--consumer` and `--tenant`), and
`sync dead-letters delete` require `--yes`. Deletion is permanent.
`sync schedules run <app> <scheduler> <schedule> --request-id <stable-id> --yes`
accepts work; reuse the request ID after an uncertain response. Inspect the
returned run with `sync schedules runs get <app> <scheduler> <schedule> <run-id>`;
`--timeout-ms` permits a bounded wait, and `completed: false` means pending.

## App credentials

Use the generic workload administration commands for any owning app:

```bash
cld admin app-credentials apps
cld admin app-credentials list mail --json
(umask 077; cld admin app-credentials create mail --name production --yes > mail-credential.txt)
cld admin app-credentials revoke mail <credential-id> --yes
```

Creation prints the token once; structured output includes token and metadata.
Transfer the token to the deployment secret store, then remove the temporary
file. An optional `--expires-at` takes a future ISO 8601 timestamp. Lists show
metadata only. Configure `CLOUD_APP_CREDENTIAL` only in its owning app and
`CLOUD_CORE_INTERNAL_ORIGIN` with Core's private origin. Mandates still control
the allowed background actions. For rotation, create and deploy a replacement,
verify its calls, then revoke the old credential. The equivalent UI is
**Administration → App credentials**.


## Agents

An agent is a standalone service account of kind `agent` with its own OAuth
client. It appears with a robot icon in pickers, activity, and audit, starts
with no access, and is granted access like a person (Space membership, Notebook
access, and so on).

```bash
cld admin agents create "Release agent" --profile release-agent --yes
cld admin agents ls --json
cld admin agents rotate-secret "Release agent" --profile release-agent --yes
cld admin agents revoke "Release agent" --yes
```

`create` creates the account and a confidential OAuth client with the scopes of
a `cld login` session (`openid profile email offline_access read write`), then
writes the client ID and secret into the local `cld` profile named by
`--profile`. The secret is never printed, also not with `--json`; add `--fd0`
to keep it in fd0 instead of the config file, and `--server` when the profile
should target another origin than the administrator's. If the client or the
profile cannot be created, the new account is disabled again. Afterwards the
agent runs `cld --profile release-agent …` and `cld` obtains and renews its
access tokens itself.

`revoke` disables the account: its tokens, secret, and API keys stop working
at once. `rotate-secret` regenerates the client secret and updates the local
profile; an agent addressed by name must match exactly one account. The same
accounts are visible in the Accounts app and through
`cld accounts service-accounts list --kind agent`.

## Built-in Assistant Skills

Use `cld admin ai skills list --json` for exact Skill IDs, revisions, template
origin and status, and `cld admin ai skills templates --json` for the current
trusted template IDs and versions. These commands require platform-admin access.

For an existing installation, `ai skills associate <skill-id> --template <id>
--template-version <version> --revision <revision> --yes` explicitly links a Skill
and preserves its content. Never infer authorization from a matching name.
`ai skills reset` takes the same flags and replaces all content and references.
Export customized content in Assistant settings first when a copy is needed.
Read again after a revision or template conflict; do not retry with guessed values.

Unmodified linked Skills receive newer templates automatically. Customized Skills
stay intact. Identity, grants, personal activation, and loaded turn snapshots are
preserved. Deleted linked Skills stay deleted; there is no automatic recreation,
merge, or version history.

## AI prices, Assistant cost budgets, and background stop

Use `cld admin ai quotas` for the same controls as **Admin → AI → Assistant limits**.
All commands require a platform administrator. These limits apply only to direct
Assistant reference costs calculated from model input/output prices. They exclude workflows, background AI,
and separate image or audio model calls. Enforcement is off by default.

```bash
cld admin ai quotas config get --json > quotas.json
cld admin ai quotas models --json
cld admin ai quotas users --search "Alex" --page 1 --json
cld admin ai quotas report --range 7d --sort cost --status exhausted --json
cld admin ai quotas balance --type user --id <user-uuid> --json
```

`report` returns period costs, charts, and current per-model balances from the
same report as the GUI. Filters: `--range` (`24h`, `7d`, `30d`, `90d`), `--search`,
`--model`, `--status` (`all`, `available`, `exhausted`, `unknown`, `unlimited`,
`disabled`), `--sort` (`label`, `cost`, `lastUsed`), `--direction` (`asc`, `desc`),
`--page`, and optional `--identity` plus `--identity-type` (`user`,
`service_account`). Reuse the returned `query.until` with `--until` for subsequent
pages. Unlike `users`, this report includes costs and effective allowances.

Without a search, `users` lists identities with direct chat activity, including
service accounts. `--search` also finds identities that have not used chat yet.
Follow `page`, `perPage`, and `total` to read further pages. Use `--type service_account`
for a service account's balance or reset. Resolve grant identities using
`cld accounts users list`, `cld accounts groups list`, or
`cld accounts service-accounts list`; inspect their help for search options.

Edit the exported `quotas.json`, preserving its `revision`, then save it:

```bash
cld admin ai quotas config set --config-file quotas.json --yes --json
# Alternatively, provide the same complete document through stdin:
cat quotas.json | cld admin ai quotas config set --stdin --yes --json
```

This replaces the entire configuration, including `enabled` and all rules.
To disable enforcement, set `enabled` to `false` and keep the rules. To remove a
rule or grant, omit it from the edited document. A stale revision fails with a
conflict: fetch again, reconcile the edits, and deliberately resubmit. Do not
retry a write by silently replacing its revision.

Each rule has this shape (the exported configuration wraps rules in
`{"enabled":false,"revision":0,"rules":[]}`; use the actual revision):

```json
{
  "scope": "*",
  "hours": 24,
  "anchor": "2026-09-14T00:00:00Z",
  "grants": [
    { "principal": { "type": "authenticated" }, "limit": 10 },
    {
      "principal": { "type": "group", "groupId": "00000000-0000-4000-8000-000000000001" },
      "limit": null
    }
  ]
}
```

Replace sample UUIDs with real IDs. `scope` is a model profile ID from `models`,
or `*` for all direct chat models. `hours` is an integer from 1 to 8760;
`anchor` is a UTC ISO timestamp defining fixed reset windows. Changing `hours`
alone keeps that anchor and recalculates the periods from it. To begin a new
period when changing the interval, also set `anchor` to the intended start time
(the GUI uses the current time for this change). One rule per scope
is allowed. Each grant has a nonnegative cost `limit` (up to six decimal places), or `null` for
unlimited. Supported principals are `authenticated`, `user` with `userId`,
`group` with `groupId`, and `service_account` with `serviceAccountId`.
An optional `displayName` labels the grant; it does not determine identity.
Public grants are not supported.

Matching grants use the maximum allowance, not the sum. An unlimited wildcard
grant overrides all model limits. Finite wildcard and model limits both apply;
a model-specific unlimited grant does not remove a finite wildcard limit.
A configured scope with no matching grant has a zero allowance. An absent scope
imposes no limit. Quotas do not grant model
access, and saving configuration does not reset recorded usage.

To reset one identity and scope, create a UUID for that operation and retain it:

```bash
cld admin ai quotas reset --type user --id <user-uuid> --scope '*' \
  --request-id <reset-operation-uuid> --yes --json
```

Reuse that request ID after a timeout or uncertain response. A later, distinct
reset needs a new UUID. Quote `*` to prevent shell expansion. Resetting one scope
does not reset the other scopes or delete usage history. The response contains
the updated balance. Reads and writes also support `--jsonl`; list responses
retain their response envelope and pagination fields.

Interrupted-call token amounts can be estimates; balances expose the number of
`estimated` calls separately from `unknown`. Estimates count toward limits.
The `authenticated` principal also matches service accounts. Raw call history
is retained for 8,760 hours (the maximum quota window), with bounded cleanup;
usage history in balances is not a lifetime total. Reset IDs remain durable.


Set reference prices before creating model-specific budgets:

```bash
cld admin ai models pricing get --json
cld admin ai models pricing set --id MODEL_ID --pricing-file prices.json --yes --json
```

The file contains `{"inputPerMillion":0.5,"outputPerMillion":2}` or JSON `null`
to remove pricing. Both prices are required, nonnegative, with up to six decimal
places and a maximum of 1,000,000. Zero is explicitly free. Missing prices mean
unpriced usage: these models bypass all cost budgets, including wildcard rules
and the background stop. Audio pricing is not supported. The command reads
current prices and submits an optimistic precondition; it does not touch
credentials or grants. Re-read and reconcile on conflict.

Configuration additionally includes `unit` (default `EUR`, maximum 16 characters)
and optional `background: {"enabled":true,"warnAt":5,"stopAt":10}`. All model
prices, budgets and reports use the same unit; fictional units are allowed.
Changing the unit after priced usage is rejected. `warnAt` can be `null` or a
nonnegative amount below positive `stopAt`. Both accept six decimal places.
The background stop is off by default and independent of chat enforcement.

```bash
cld admin ai quotas background status --json
cld admin ai quotas background release --yes --json
```

This is a global rolling 24-hour stop for priced background tasks and workflows.
Warnings/stops notify platform administrators through Cloud notifications.
Existing calls can finish. Once triggered, the stop latches until explicit
release; it does not reset the next day. Release requires usage below the saved
threshold and no unknown priced costs in the window, or disabled enforcement.
Releasing a latched stop advances the configuration revision: run
`cld admin ai quotas config get --json` again before the next configuration write.
Pending reservations alone do not latch the stop. Calls wait for capacity for up
to two minutes, then follow the caller's retry policy if still blocked.
Raise the threshold or disable it through `config set` before releasing when
needed. The operator separately chooses which failed workflows to retry.

Investigate costs without changing configuration:

```bash
cld admin ai usage report --range 7d --json
cld admin ai usage workflows --range 30d --sort cost --json
cld admin ai usage runs --workflow WORKFLOW_UUID --workflow-run RUN_UUID --json
cld admin ai usage models --sort cost --json
cld admin ai usage tasks --sort cost --json
```

Usage is one row per actual provider attempt, including repair/retry; copies and
replays add no cost. Section JSON includes the unit and paginated items. Unknown
costs are `null`, explicit free costs are zero, and coverage explains incomplete
totals. Costs use price snapshots and reported tokens, not provider invoices.
Cached-token discounts and separately billed modalities are not reconstructed.
Raw tokens remain available for diagnosis. Historical data survives chat deletion.
This alpha cut does not migrate old token quotas or credits; configure prices
and cost limits explicitly, with unlimited usage as the default.
