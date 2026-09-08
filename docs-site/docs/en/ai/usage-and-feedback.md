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
application. Compact filter chips apply selections immediately. Search user and
model selectors by name or identifier. The runs view has a search row; submit
text searches with Enter. **About these data** explains measurement and attribution
limits. Filters, view, sorting,
and pagination are stored in the URL. **Refresh** advances the period end;
pagination retains the end time so new runs do not shift existing pages.

- **Overview** shows inference totals, coverage, timelines, application usage,
  chat launches, and tool activity. Chat and background inference count once.
  Tool events have no additional inference charge.
- **Users & models** displays one comparison table at a time. Switch between
  users and models to compare volume, costs, failures, latency, throughput,
  switches away, and feedback. Sort by volume, tokens, credits, failures,
  negative count, or negative share. Models are grouped by both profile and
  actual provider model, so editing a profile does not merge different models.
- **Feedback** filters current ratings by positive/negative and reason. The
  totals retain the whole selected user/model cohort, so filtering to negative
  feedback does not turn its denominator into 100%. Details show the full
  stored comment, reasons, timestamps, and identifiers.
- **Errors & runs** filters chat, background, and tool events by kind, status,
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
Chat duration is generation time; background duration is elapsed inference
time, and tool duration is execution time. Switching away is counted within
the selected period before applying model filters.

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

The same service backs `cld admin ai usage`. JSON includes the server-resolved
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

Other list commands are `models`, `tasks`, `apps`, `launches`, and `capabilities`.
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
- `GET /api/admin/core/ai-usage/runs/{chat|background|tool}/{uuid}`

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
