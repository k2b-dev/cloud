---
title: Usage and feedback
navTitle: Usage and feedback
section: AI
order: 1065
description: Filter AI usage, compare users and models, and inspect feedback and failed runs in Admin or the CLI.
tags: [ai, usage, feedback, administration]
updated: 2026-09-08
---

# Usage and feedback

Open **Admin → AI → Usage**. This page and its HTTP endpoints require the
administrator role. They expose usage metadata, feedback comments, and stored
errors, without granting access to another user's private chat content.

## Filter and investigate

The shared filters are period, user, model profile, actual provider model, and
application. Compact filter chips apply selections immediately. Provider-model and application
filters are under **More filters**, which stays open when either is active. Search user and
model selectors by name or identifier. The runs view has a search row; submit
text searches with Enter. **About these data** explains measurement and attribution
limits. Filters, view, sorting,
and pagination are stored in the URL. **Refresh** advances the period end;
pagination retains the end time so new runs do not shift existing pages.

- **Overview** shows inference totals, coverage, timelines, application usage,
  and chat launches. The two compact charts support an exact-value table and
  copying data, with a shared UTC inspection cursor. Chat and background inference count once. Capability calls
  are not inference and are not counted here; the platform records every
  capability execution, from the assistant and from every other surface, at
  [Observability](/en/docs/operations/observability).
- **Users & models** displays one comparison table at a time. Switch between
  users and models to compare volume, costs, failures, latency, throughput,
  switches away, and feedback. Sort by volume, tokens, credits, failures,
  negative count, or negative share. Table headers also select ascending or
  descending ordering. Models are grouped by both profile and
  actual provider model, so editing a profile does not merge different models.
- **Feedback** filters current ratings by positive/negative and reason. The
  totals retain the whole selected user/model cohort, so filtering to negative
  feedback does not turn its denominator into 100%. Details show the full
  stored comment, reasons, timestamps, and identifiers.
- **Errors & runs** filters chat and background events by kind, status,
  task, error code, or literal text in the task/error. **Show error** opens the
  complete stored error plus attribution, duration, usage, and references.
  **Copy details** copies the displayed information.

Click a user or model to narrow the report. Click a failure count to open its
matching runs. Run-specific filters apply only to the run list; rating and
reason apply only to the feedback list.

## Read the numbers correctly

Periods cover the start time of each run. Feedback uses current ratings on
assistant messages belonging to chat turns started in that period, everywhere
in the report. A rating added today to an older response does not move the
response into today's period. Ratings can be edited or cleared; this is not a
history of rating changes.

Negative share is negative ratings divided by all ratings. Rating coverage is
rated assistant messages divided by stored assistant messages in the selected
chat turns. Read both alongside the counts: one negative rating out of one is
not the same evidence as 100 out of 100. Background runs have no message ratings.
The user is the chat owner; the current feedback endpoint only accepts feedback
on the caller's own chats.

Unknown tokens and prices appear as **—**. Coverage reports the fraction of
runs with measurements; partial totals sum only reported values. A reported
zero is retained as zero. No price is inferred for a provider that omits it.
Chat duration is generation time and background duration is elapsed inference
time. Switching away is counted within the selected period before applying
model filters.

Chat accounting survives retry/edit removal of messages. Feedback and its
coverage describe remaining messages; deleting a chat removes its chat turns
and feedback. The standalone background ledger retains metadata and clears
user/chat/turn references when their owners are deleted.

## Background attribution

`runAiStructured()` accepts optional `attribution` metadata with `userId`,
`conversationId`, `turnId`, and `workflowRunId`. Supply existing identifiers only
after authorizing the domain operation. This metadata is not authorization.
When a conversation is supplied without a user, its owner supplies attribution.
Cloud also records the trace ID of the structured attempt.

Built-in enrichment, personalization, image inspection, and compaction forward
available chat/turn references. Workflow AI forwards its workflow run ID and an
existing user from the run's actor snapshot when available. System-owned work
may legitimately have no user. Prompt, input, and output content are not added
to the ledger.

Choose **Unassigned** for records without user attribution. Selecting a user
excludes these records. Stored background errors are limited to 2,000 characters.

## Use the CLI

The same service backs `cld admin ai usage`. Comparison commands also accept
`--direction asc|desc` (descending by default). JSON includes the server-resolved
query, period, total count, page, and page size. List commands also accept
`--jsonl` to emit one complete row per line from the requested page.

```bash
cld admin ai usage facets --field userId --search Ada --json
cld admin ai usage users --range 30d --sort negativeRate --json
cld admin ai usage feedback --user USER_UUID --model MODEL_ID --rating down --json
cld admin ai usage runs --kind background --status failed --search '404' --jsonl
cld admin ai usage get background RUN_UUID --json
cld admin ai usage report --range 7d --json
```

Other list commands are `models`, `tasks`, `apps`, and `launches`.
Use `--provider-model` and `--app` for additional global filtering,
`--reason` for feedback, and `--task` or `--error-code` for run lists.
`--user unassigned` selects events without a user. `--page` and `--per-page`
control pagination; page size is 1–100. Reuse the returned `query.until` via
`--until` when exporting multiple pages. JSONL does not fetch subsequent pages
automatically.

For example, aggregate the negative counts returned for each user with `jq`,
or retain full JSON reports for comparison with a later snapshot. The report
contains user IDs as well as labels, so names do not become grouping keys.

## HTTP and server interfaces

The Core endpoints are:

- `GET /api/admin/core/ai-usage/report`
- `GET /api/admin/core/ai-usage/facets?field=userId&search=...`
- `GET /api/admin/core/ai-usage/runs/{chat|background}/{uuid}`

The report query supports `range` (`24h`, `7d`, `30d`, `90d`), `until` (ISO),
`userId`, `modelProfileId`, `providerModel`, `appId`, `view`, `kind`, `status`,
`task`, `errorCode`, `search`, `rating`, `reason`, `sort`, `page`, and `perPage`.
Invalid values are rejected before querying; unknown API parameters are rejected.
Facet search returns at most the requested page size; refine the search to find
an identifier beyond the suggestion list.

The server-only `@k2b/cloud/ai/admin` export supplies
`aiUsage.report(range, options)`, `aiUsage.detail(kind, id)`, and
`aiUsage.facets(field, search, options)`. Applications using this internal admin
surface must establish the administrator boundary before calling it. Report
collections are paginated `{ items, page, perPage, total }` objects; aggregate
rows share measurement coverage and feedback counts. The browser-safe
`@k2b/cloud/shared` export provides `AiUsageQuerySchema`,
`aiUsageSearchParams`, and `aiUsageHref` for the same URL contract.

## Assistant limits

Open **Admin → AI → Assistant limits** (`/admin/settings?tab=ai-quotas`).
Enforcement is **off by default**. Existing installations continue without a
quota. Direct chat usage is recorded even while enforcement is off; enabling
limits uses the recorded usage in the current window. The runtime sweep removes
at most 1,000 inactive raw calls per pass after 8,760 hours, the maximum supported
quota window. Per-user history covers the retained ledger, not lifetime totals.
Active leased calls are preserved. Reset request IDs remain durable so an old
retry cannot apply a second reset.

Each rule selects a chat model profile or **All chat models**, a reset interval
in hours (1–8,760), and assignments to users, groups, service accounts, or all
signed-in users. Each group member receives a personal allowance. The highest
matching allowance applies; assignments are never added together. No matching
assignment means zero allowance for that rule. An absent rule adds no limit.

**Unlimited on All chat models overrides every model-specific quota.**
Otherwise, both the all-model allowance and any specific model allowance apply.
Unlimited on one model does not remove a finite all-model allowance. Model
permissions remain a separate requirement, including for administrators.

All-model usage combines direct chat calls across model profiles, so changing
models does not refill that allowance. Input and output tokens count once;
cache and reasoning subtotals are not added again. The feature limits usage,
not money. Calls already in progress can exceed an allowance before their
usage is reported.

Only direct interactive Assistant model calls count, including API and CLI
submissions, retries and queued messages. Separate image, audio, transcription,
compaction, enrichment, scheduled and workflow calls do not count. A direct
chat call to a model with image capabilities still counts its reported input
and output tokens.

The default **Users** view is a searchable, sortable account table. It includes
existing direct-chat users and recorded service accounts; search can also find
accounts without usage. Choose a consumption period (24 hours, 7, 30, or 90 days),
model and current allowance status. Counts and charts use the whole filtered
cohort, not just the current page of 25 accounts. The model chart shows the top
20 models by recorded consumption. Switch either chart to its exact-value table
or copy the values. Missing measurements are not zero consumption; estimates
and unmeasured calls are shown separately.

Consumption follows the selected historical period. **Current allowances** use
each rule's own current reset window, even when a past consumption period is
selected. The status reflects disabled enforcement, unlimited access, available
or exhausted allowances, and unknown usage that blocks a finite allowance.
Multiple model rules are summarized separately, never added into a single
percentage. Selecting an account opens its current per-scope balances, grant
sources and reset actions. Closing details preserves filters and pagination.
The link to broader **Usage** includes background inference and can have different
retention and measurement coverage; its totals are not quota balances.

**Rules** shows one compact row per model scope. Use **Add rule** or **Edit rule**
to choose a model, interval, and assignments in a dialog. **Apply to draft** changes
only the local draft; **Save changes** persists the full configuration. Cancelling
a dialog does not save, and leaving with pending changes asks before discarding
them. A conflicting administrator edit requires reloading before saving.
Detailed accounting begins with this feature;
older chat history is not backfilled into quota consumption. Deleting a chat
neither removes these measurements nor restores allowance.

**Reset allowance** restores one account's allowance for one scope until its
regular reset. Other scopes and historical usage are unchanged. The reset is
recorded with its administrator and timestamp. Calls started before the reset
remain in the old allowance even if their usage arrives afterward. Changing a
rule's interval starts a new period after confirmation; changing assignments
or token amounts does not reset consumption.

Interrupted streams (Stop, timeout, shutdown, or provider errors) often omit
final provider usage. When that happens, quota accounting records an explicitly
labelled estimate from the request text, system prompt, tool schemas, and streamed
text/thinking/tool arguments (roughly four characters per token). Binary file
data is excluded; hidden reasoning and provider-specific image costs cannot be
reconstructed. Estimates are approximate, not provider billing measurements,
and count against the allowance without an unknown-usage lockout. Reported
usage always takes precedence. A normal completed stream without valid usage,
or an orphaned call after a process crash, remains unknown and blocks finite
limits until reset or the next window. Existing unknown historical rows cannot
be reconstructed and may still require an administrator reset. Disabled or unlimited quotas do not block chats for a usage
booking failure. A known context-size rejection before generation counts zero
so the normal compaction/retry path can continue.

Quotas preserve blocked queued messages. The existing queue recovery checks
again after a reset or window change; it does not change models automatically.
The Assistant shows the remaining allowance beside its model selector. Open
the indicator for all-model and selected-model balances, reset times, and
unlimited access. The tighter effective allowance determines the indicator;
unmeasured usage is shown separately. Disabled limits remain invisible.

The page seeds this view on the server and refreshes it after chat activity,
on focus, and every 30 seconds while visible. The popup also has a refresh
action. Loading errors hide cached percentages and do not disable sending;
the server remains authoritative and a rejected submission preserves the draft.

`getAiChatQuotas(accessSubject)` from `@k2b/cloud/ai` and authenticated
`GET /api/ai/quotas` return the caller's allowances. The browser-safe
`AiChatQuotaSnapshot` type is exported from `@k2b/cloud/shared`. The view omits
grant identities, historical usage, and specific model profiles the caller
cannot use. The endpoint takes no target-user parameter and uses `no-store`.

### Manage Assistant limits with the CLI

Administrators can use `cld admin ai quotas` instead of the Admin page:

```sh
cld admin ai quotas config get --json > quotas.json
cld admin ai quotas models --json
cld admin ai quotas users --page 1 --json
cld admin ai quotas balance --type user --id <user-uuid> --json
cld admin ai quotas config set --config-file quotas.json --yes --json
cld admin ai quotas reset --type user --id <user-uuid> --scope '*' \
  --request-id <reset-operation-uuid> --yes --json
```

Edit the exported configuration before saving. `config set` replaces the whole
configuration and requires the current `revision`; conflicts require a fresh
read and deliberate reconciliation. `--stdin` accepts the same JSON document.
Set `enabled: false` to disable enforcement without removing rules. Rules carry
`scope`, reset `hours` and `anchor`, and permission principals with token `limit`
(`null` means unlimited). The CLI uses the same validated Admin API and quota
semantics as the GUI; it does not calculate grants locally. Changing `hours`
retains the submitted `anchor`. Also update `anchor` when deliberately starting
a new reset period, as the GUI does for interval changes.

The users response includes pagination and identities with direct chat activity;
`--search` also finds identities that have not used chat yet.
Use `--type service_account` for a service account. Retain the reset operation's
UUID and reuse it when retrying an uncertain response. A new reset requires a
new UUID. Reset applies only to the selected identity and scope; historical
usage remains available. All commands support JSON and JSONL output.

The `authenticated` quota principal includes signed-in users and service accounts,
consistent with Cloud access rules. Their usage is still accounted separately.
The quota PostgreSQL regression suite runs in the dedicated **Assistant quotas**
CI workflow against a disposable `cloud_ai_quota_verify_ci` database.


### Admin quota reporting

`GET /api/admin/core/ai-quotas/report` uses the same administrator authorization as
quota configuration. Its query accepts `range`, `until`, `search`, `model`,
`status`, `sort` (`label`, `tokens`, `lastUsed`), `direction` (`asc`, `desc`) and
`page`. `view` is `users` by default or `rules`; the rules view needs no consumption
report. `identity` and `identityType` select an optional account for the UI.
The report returns period aggregates, a UTC timeline, up to 20 model groups,
a paginated account table and current allowance summaries. It does not expose
private chat content. `until` fixes the historical period end; `asOf` identifies
when current allowances were evaluated. Refresh advances the period end.

Filters, sorting, pagination, and account selection are stored in the Admin URL.
Consumption remains visible when enforcement is disabled. Existing configuration,
balance, and reset CLI commands continue to use the same quota policy and APIs.
