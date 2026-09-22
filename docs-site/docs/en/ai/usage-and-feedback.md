---
title: Usage and feedback
navTitle: Usage and feedback
section: AI
order: 1065
description: Inspect AI reference costs, configure Assistant budgets and a background emergency stop, and investigate workflow costs.
tags: [ai, usage, feedback, administration]
updated: 2026-09-16
---

# Usage and feedback

Open **Admin → AI → Usage** to see what AI calls cost by period, user, model,
application, internal task, or workflow. The page and its APIs require a platform
administrator. They expose metadata and feedback, not another user's chat content.

## Configure reference prices

In a model's settings, optionally enter **input** and **output** prices per
**one million tokens**. Supply both prices or leave both empty. Zero means an
explicitly free price; missing prices mean unpriced usage. Prices are nonnegative,
with up to six decimal places and a maximum of 1,000,000 per million tokens.

Choose the shared **Accounting unit** on **Assistant limits → Rules**. The default
is `EUR`; a fictional unit is also supported. Use the same unit for every model
price and budget. After the first priced call, the unit cannot change. There is
no currency conversion or automatic provider price lookup.

Reference cost is `(input tokens × input price + output tokens × output price) /
1,000,000`. Each provider call keeps its price snapshot. A later price change
therefore affects only new calls. Costs are calculated centrally with decimal
precision; application authors never calculate charges in individual workflows.

**Unpriced models remain unlimited**, even when a user has exhausted a wildcard
budget or the background emergency stop is active. Active unpriced chat models appear in a warning on
**Rules**; audio and disabled profiles are excluded. Only enabled chat models with
a nonzero input or output price can be selected for a new model-specific rule.
Removing a model's prices makes subsequent calls unlimited; previous costs remain.
Audio prices are not supported yet: the current transcription response does not
supply a reliable billable duration. Audio calls remain visible as unpriced.

These are **reference costs, not a provider invoice**. Coverage is limited to the
input/output tokens the adapter reports. Cache discounts, separately billed
cached input, hidden reasoning, and provider-specific image charges are not
reconstructed. A direct chat with images uses its reported tokens; a separate
image-inspection call belongs to background usage.

## Read the report

Use period, user, model profile, actual provider model, and application filters.
Filters, view, sorting, and pagination are stored in the URL. **Refresh** advances
the period end; pagination retains it. Models are grouped by profile and actual
provider model so editing a profile does not combine different provider models.

- **Overview** shows reference costs, raw tokens, coverage, a UTC timeline,
  applications, internal tasks, workflows, and chat launches. Charts also offer
  a table of exact values and copying.
- **Users & models** compares cost, calls, failures, latency, and feedback. Sort
  by costs or tokens as well as the existing quality metrics.
- **Feedback** shows current ratings and comments on remaining chat messages.
  Negative share is negative ratings divided by all ratings; coverage is rated
  messages divided by stored assistant messages. Read both alongside the counts.
- **Errors & runs** lists individual provider attempts. Details show the model,
  cost, measurement status, task, trace, and workflow/chat references. Workflow
  references open the existing workflow observability page.

Each run keeps its redacted provider or transport error (for example
`SSE stream first byte timeout after 60000ms.`), never request content or
credentials. A run stopped by the user or by the turn's run budget has status
`aborted`, `cancelled: true`, and no error; it is not counted as failed.
Runs also record request milestones measured from the moment the provider
request left Cloud: `headersMs` (response headers), `firstByteMs` (first body
byte), `firstBlockMs` (first text, thinking, or tool-call block), and
`generationMs` (until the call finished). `requestStartedAt` is null for calls
recorded before this instrumentation or that never left admission.

One actual `stream()` or `complete()` attempt produces one record. Structured
output repair and real retries are separate calls. Replaying a completed
workflow step, copying a chat, or reopening a conversation does not call a
provider and adds no cost. Chat compaction has its own background task record.
Capability executions are not inference; inspect them in
[Observability](/en/docs/operations/observability).

Periods use each provider call's start time. Duration covers that call, not the
whole chat turn or workflow. Feedback is counted once per chat turn even when
that turn made several calls. It uses the current rating; editing feedback does
not move the original response to today's period. Switches away compare a chat
turn's model with the next turn in the same conversation.

Unknown costs appear as **—**, not zero. Totals sum known costs; coverage shows
what fraction of calls has known costs. Explicit free pricing records zero even
if token counts are unavailable. Interrupted streams without final usage use a
labelled estimate based on request text, instructions, tool schemas and streamed
output (roughly four characters per token). Binary file data is excluded.
Reported usage takes precedence. Successful calls without usable usage, and
calls orphaned by a process crash, retain unknown costs.

Accounting survives retry/edit truncation and chat deletion. Deleting a user
clears the user reference; workflow names, application, and version are captured
at call time. Raw call records are retained for 8,760 hours with bounded cleanup;
active calls are preserved. This is retained history, not a lifetime total.

## Attribute background work

`runAiStructured()` accepts `attribution` with `userId`, `conversationId`,
`turnId`, `workflowRunId`, and `stepKey`. Authorize the domain operation before
supplying existing IDs; attribution does not grant permission. A conversation
can supply its owner's identity and launching application when not specified.

Workflow AI supplies its run and step automatically. Cloud resolves the workflow
ID, name, version, and application from the workflow store. The workflow table
groups all calls for one definition, including after a rename. Click its name
to open its runs in workflow observability. Filter usage by `workflowId` or
`workflowRunId` to inspect costs for a definition or one execution.

Compaction, enrichment, memory learning and image inspection appear under their
own internal task names with available chat/turn references. They do not invent
workflow references. System-owned tasks can have no user; choose **Unassigned**
to inspect those calls. No prompts, source files or generated content are stored
in the cost ledger.

## Set Assistant budgets

Open **Admin → AI → Assistant limits → Rules**. Enforcement is **off by default**.
Priced usage is recorded while enforcement is off, so enabling budgets uses
already-recorded consumption in the current window.

Each rule selects a priced model profile or **All chat models**, a reset interval
of 1–8,760 hours (new rules default to **24**), and assignments to users, groups,
service accounts or all signed-in identities. An assignment gives a personal
cost allowance, not a shared group pot. The largest matching allowance applies;
assignments are never added together. No matching assignment means zero for that
rule; no applicable rule means no limit.

**Unlimited on All chat models overrides all model-specific budgets.** Otherwise
both a finite wildcard and a finite model budget apply. Model-specific unlimited
does not override a finite wildcard. Unpriced models are exempt from both.
Model permissions remain separate, including for administrators.

These budgets cover only direct Assistant calls, including API/CLI submissions,
queued messages and retries. Compaction, enrichment, image inspection, audio,
scheduled tasks and workflows are excluded. Switching chat models does not
refill the shared wildcard allowance.

Admission reserves estimated input and an affordable maximum output atomically
across workers. The provider receives that output limit; completion replaces
the reservation with actual reported costs. Estimates and provider-specific
charges can still differ, so this is not an exact invoice ceiling. An unknown
priced call blocks a finite budget until reset or the next window. Unlimited and
disabled budgets do not block on unknown usage.

**Users** lists accounts with direct-chat activity and their per-model balances.
Search also finds accounts without usage. The eye button opens a modal with
current allowances, matching grant identities, reset times and manual resets.
Historical consumption follows the selected report period; current balances
always follow each rule's current window. Percentages across model rules are
never added together.

**Reset allowance** resets one identity and one scope without deleting cost
history or changing other scopes. Calls started before the reset stay in the
old allowance even if they finish afterward. The action records its administrator
and timestamp. Changing assignments or amounts does not reset usage. Changing
an interval in the GUI starts a new period after confirmation.

Rule dialogs edit a draft. **Save changes** persists the complete configuration;
stale revisions require reloading and reconciling. Blocked queued messages are
retained and checked again after a reset or window change. The Assistant's
indicator shows cost allowances and refreshes after activity, on focus, and every
30 seconds while visible. Disabled limits are invisible. Server admission remains
authoritative and rejected submissions preserve the user's draft.

## Set a background emergency stop

On **Rules**, optionally enable **Background AI emergency stop**. Set a positive
stop threshold and, optionally, a lower warning threshold in the shared unit.
It covers combined priced background calls over the **rolling last 24 hours**:
workflows, internal tasks, image inspection and compaction. It is independent of
Assistant budgets and is off by default.

Crossing a threshold creates a durable alert for platform administrators through
Cloud notifications. Delivery uses existing notification preferences and the
recovery worker. A stop prevents new priced background calls, while calls already
running can finish and are still accounted. Reservations prevent parallel workers
from spending the same remaining estimate. Unknown priced background costs also
trip the stop rather than appearing free.

A budget held by running calls does not trigger the emergency stop. Background
calls wait, with cancellation support, for up to two minutes for a reservation
to settle. If the budget remains reserved, the caller can retry; workflow AI uses
its existing bounded retry policy. A call whose estimated input and one output
token cannot fit even without pending reservations is rejected without latching
the stop.

Set **Advanced → Default output limit (tokens)** in the provider dialog to bound
response length and reservations. Tasks can supply their own output limit.
Leaving it empty preserves provider defaults; admission uses the provider's
context window as a conservative bound when no output maximum is known.

Once triggered, the stop **stays active until explicitly released**; the next day
does not automatically restart work. Review Usage, then wait for costs to leave
the rolling window, raise the threshold, or disable the stop. Save configuration
changes before choosing **Release stop**. Release is rejected while known costs
are still at/above the threshold or unknown costs remain in the window. There is
no bulk restart of failed workflows: an operator decides which work to retry.
Releasing a latched stop advances the configuration revision. Export the
configuration again before the next CLI update. Unpriced models and direct
Assistant calls remain unaffected.

## Operate through the CLI

All administration uses the same APIs and authorization as the GUI:

```bash
cld admin ai models pricing get --json
cld admin ai models pricing set --id MODEL_ID --pricing-file prices.json --yes --json
cld admin ai quotas config get --json > quotas.json
cld admin ai quotas config set --config-file quotas.json --yes --json
cld admin ai quotas background status --json
cld admin ai quotas background release --yes --json
cld admin ai quotas users --search Alex --json
cld admin ai quotas report --range 7d --sort cost --status exhausted --json
cld admin ai quotas balance --type user --id USER_UUID --json
cld admin ai quotas reset --type user --id USER_UUID --scope '*' \
  --request-id RESET_UUID --yes --json
cld admin ai usage workflows --range 30d --sort cost --json
cld admin ai usage runs --workflow WORKFLOW_UUID --workflow-run RUN_UUID --json
cld admin ai usage report --range 7d --json
```

`prices.json` is `{"inputPerMillion":0.5,"outputPerMillion":2}`; JSON `null` removes
prices. The command reads current prices and sends them as an optimistic update
precondition. It never replaces credentials or access grants. Configuration export
includes `enabled`, `revision`, `unit`, `background` and `rules`. Preserve its
revision and save the full edited document; `--stdin` is also supported.
`background` is `{ "enabled": true, "warnAt": 5, "stopAt": 10 }`; `warnAt: null`
disables the warning. Limits and thresholds accept up to six decimal places.

Rules carry `scope`, `hours`, `anchor` and `grants` with a cost `limit` (`null`
means unlimited). `authenticated` matches signed-in users and service accounts.
Use `user`/`userId`, `group`/`groupId`, or `service_account`/`serviceAccountId` for
specific identities. Group membership follows the normal permission rules.

Resets are idempotent by request UUID. Reuse the UUID after an uncertain response;
a new intentional reset needs a new UUID. Quote `*` to avoid shell expansion.
Changing `hours` through the CLI keeps the submitted `anchor`; also change the
anchor when intentionally starting a new window.

`ai quotas report` returns the same chat cost report and current balances as the
Assistant limits page. It supports `--range`, `--until`, `--search`, `--model`,
`--status`, `--sort`, `--direction`, `--page`, `--identity` and `--identity-type`.
Reuse `query.until` when fetching subsequent pages.

Usage list commands are `users`, `models`, `tasks`, `apps`, `workflows`, `launches`,
`feedback` and `runs`. Use `--json` for the envelope including unit and pagination,
or `--jsonl` for rows of one page. `--page` and `--per-page` (1–100) paginate;
reuse the returned `query.until` as `--until` for consistent multipage exports.
The CLI does not fetch later pages automatically.

## HTTP and server interfaces

Administrator endpoints:

- `GET /api/admin/core/ai-usage/report` and `/facets`
- `GET /api/admin/core/ai-usage/runs/{chat|background}/{callUuid}`
- `GET|PUT /api/admin/core/ai-quotas`
- `GET /api/admin/core/ai-quotas/models`, `/users`, `/balance`, `/report`
- `PUT /api/admin/core/ai-quotas/models/{id}/pricing` with `{pricing,expected}`
- `POST /api/admin/core/ai-quotas/reset`
- `GET /api/admin/core/ai-quotas/background`
- `POST /api/admin/core/ai-quotas/background/release`

Report periods are `24h`, `7d`, `30d`, `90d`. Usage uses `AiUsageQuerySchema` from
`@k2b/cloud/shared`, including `workflowId` and `workflowRunId`. Quota reports sort
by `label`, `cost` or `lastUsed`; they show period totals and current balances.
Server administration is exported from `@k2b/cloud/ai/admin` and requires the
caller to establish the administrator boundary.

`getAiChatQuotas(accessSubject)` and authenticated `GET /api/ai/quotas` return
only the caller's allowances, unit, and accessible unpriced or free model IDs. They omit
grant identities and inaccessible models, take no target-user parameter, and use
`no-store`. `AiChatQuotaSnapshot` is browser-safe.

This alpha cut starts a fresh cost ledger and budget configuration. Previous
credits and token limits are not converted or backfilled. Configure prices and
cost allowances explicitly; the default remains unlimited.
