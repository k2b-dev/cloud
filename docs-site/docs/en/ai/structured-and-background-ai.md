---
title: Structured and background AI
navTitle: Structured and background AI
section: AI
order: 1060
description: Run validated model tasks outside an interactive chat request.
tags: [ai, structured-output, background]
updated: 2026-10-17
---

# Structured and background AI

Use `runAiStructured()` for one schema-valid model result.

It is the right API for classification, extraction, enrichment, and other
bounded tasks that do not need a conversation.

`runAiStructured()` executes a model request. It does not authorize domain access. Optional usage attribution is metadata,
not authorization; an optional trusted `usageSubject` selects personal chat
quota accounting instead of background accounting.



Authorize the domain read first. Send only the fields required by the task.

## Run a structured task

```ts
import { runAiStructured } from "@k2b/cloud/ai";
import { z } from "zod";

const item = await loadItemForAi({
  itemId,
  actor,
  accessSubject,
});
if (!item) throw new Error("Item not found");

const result = await runAiStructured({
  task: "inventory-categorize",
  appId: "inventory",
  input: JSON.stringify({
    name: item.name,
    description: item.description,
  }),
  systemPrompt: "Classify the item using the supplied text only.",
  outputName: "classification",
  output: z.object({
    category: z.enum(["hardware", "office", "other"]),
    confidence: z.number().min(0).max(1),
  }),
  temperature: 0,
  maxOutputTokens: 200,
  signal,
});

console.log(result.output.category);
```

`loadItemForAi()` is the authorization boundary. Its return value is the
redacted model input.

The returned value includes the parsed output, model profile ID, usage, and
structured-output metadata.

Structured tasks and context compaction keep their previous reasoning requests:
`low` for OpenAI, OpenRouter, vLLM and OpenAI-compatible profiles, a zero thinking
budget for Gemini, and no thinking field for Anthropic, Mistral and Ollama, which
keep their model defaults. The profile thinking level does not apply. Profile
`extraBody` still applies and can override nested provider parameters; see
[Thinking level](/en/docs/ai/models-and-providers#set-the-thinking-level).

## Set the task fields

| Field | Purpose |
| --- | --- |
| `task` | Short stable name used in tracing |
| `input` | User or application input |
| `output` | Zod schema for the result |
| `outputName` | Optional provider-facing schema name |
| `systemPrompt` | Optional task instructions |
| `requestedModelId` | Optional explicit profile |
| `temperature` | Task-level override |
| `maxOutputTokens` | Task-level output limit |
| `signal` | Cancellation |
| `traceParent` | Parent span for existing background work |
| `appId` | Application attribution |
| `attribution` | Optional authorized user, conversation, turn, and workflow-run identifiers for usage analysis |

The function resolves the model, requests structured output, validates the
result, and records a trace span.

Cloud streams the answer from the model provider. A model that sends nothing
for 60 seconds, before or during its answer, fails the call. A slow model that
keeps answering can take as long as it needs.

Prompts and model output are not written to the trace. Metadata includes the
model, duration, token counts, output mode, repair state, and attempts.

## Choose the background model

Model resolution follows this order:

1. `requestedModelId`;
2. the `ai.background_model_id` setting;
3. the platform default.

Resolution fails when AI is disabled or the model is unavailable.

Cloud's built-in chat enrichment, personalization learning, and long-chat
compaction use one prompt model: a code-owned task, optional administrator
guidance, and a final code-owned output and safety contract. Administrators
configure the shared background model, chat enrichment schedule,
personalization learning schedule, and each task's additional instructions in
**Settings → AI → Background jobs**. Additional instructions can supply local
terminology or conventions; they cannot replace the task, loosen privacy
rules, or change the output schema. Compaction uses this same additive model;
there is no full custom compaction prompt. All three additional-instruction fields
default to empty; their placeholders are examples, not active instructions.
**View built-in prompts** opens the original task instructions and output rules
in a read-only dialog. Personalization shows both turn learning and workflow
pattern learning; the user locale is supplied separately at runtime. The viewer
excludes organization additions and conversation content.

Administrators can open **AI → Usage** for token usage and reference costs, model
performance, user activity, quality feedback, and background failures over
24-hour, 7-day, 30-day, or 90-day ranges.



Do not silently turn a failed AI result into application truth. Decide whether
the caller should retry, skip the optional enrichment, or surface the error.

## Keep routine run history for 90 days

The Assistant calls scheduled chat tasks routines in its interface, help, and
notifications, while the API, capability IDs (`core.ai.task.*`), routes, tables,
and CLI (`cld assistant tasks`) keep `task`.

Core deletes a routine's finished run (completed or failed) 90 days
after it finished, together with its background turn, tool calls, and run
transcript. Queued and running runs stay, as does the result message the run
delivered into its chat. A finished run also stays while its turn is still active.
The run holding a one-off routine's scheduled time keeps its row, even after
completion, until the routine gets a new time or is deleted, so that time never
runs twice; its background turn and transcript still expire after 90 days.
Memory learning runs that used an expired turn as evidence stay without it.
If the routine was deleted, its runs' background turns, tool calls, and transcripts
expire on the same 90-day clock, measured from when each turn finished.

This window is fixed, not configurable. Core removes up to 100 runs per minute
on the routine recovery tick. See
[Assistant routines](/en/docs/ai/chat-runtime-and-streaming#assistant-routines)
for the execution and access rules.

## Add AI to an application workflow

AI is an optional workflow building block. An application enables it by
composing the shared actions into its workflow module:

```ts
import {
  AI_WORKFLOW_ACTIONS,
  defineWorkflowModule,
} from "@k2b/cloud/workflows";

export const inventoryWorkflows = defineWorkflowModule({
  id: "inventory",
  version: 1,
  inputs: INVENTORY_INPUTS,
  triggers: INVENTORY_TRIGGERS,
  actions: {
    ...INVENTORY_WORKFLOW_ACTIONS,
    ...AI_WORKFLOW_ACTIONS,
  },
});
```

The shared vocabulary contains four data-only actions:

| Action | Result |
| --- | --- |
| `aiGenerateText` | One bounded text value |
| `aiClassify` | Exactly one declared choice |
| `aiClassifyMany` | A unique subset of the declared choices, in declaration order |
| `aiExtractData` | One strict object validated against declared fields |

Each action requires `saveAs`. Later steps consume the stored value through the
normal workflow expression and template syntax. `aiClassifyMany` output works
with the exact array-membership condition `includes`.

`aiExtractData` accepts 1–40 unique fields. Each field declares a `name`,
`description`, and `type`: `text`, `number`, `boolean`, `date_time`, or `enum`.
Fields are required by default; text fields may set `maxLength`, and enum fields
must declare 1–50 `choices`. Undeclared properties and values that do not match
the field contract fail validation instead of reaching later steps.

The actions do not tag records, send mail, or perform another domain effect.
Compose their output with application actions that retain their own
authorization and effect budgets.

An opted-in server must also:

1. run `migrateWorkflowAi()` with its migrations;
2. start and stop the shared runtime with the application lifecycle;
3. apply the application's current authorization before an AI task is created;
4. expose a `maxAiCalls` run budget.

The server-only lifecycle exports are available from
`@k2b/cloud/workflows/ai`.

### Choose the workflow model

Workflow model resolution follows this order:

1. the action's optional `model` profile ID;
2. the `ai.workflow_model_id` platform setting;
3. `ai.background_model_id`;
4. the platform default.

The resolved profile ID is pinned when the durable task is created. A later
settings change does not alter an in-flight or replayed task.

### Understand durable execution

Postgres stores the task request, pinned model, state, attempts, output, and
usage. The Sync job carries only the task ID. The workflow parks on a durable
dependency and resumes when the task becomes terminal.

An effect key prevents a replay from creating or charging the same task twice.
Transient failures retry with bounded backoff for at most three attempts.
Canceling the workflow cancels queued work, aborts running inference, and
discards a provider result that arrives after cancellation.

Provider calls are at least once around a hard process crash: if the provider
completed but the process stopped before Postgres stored the result, recovery
may repeat that call. The stored task still exposes only one terminal output to
later workflow steps. Missing models and invalid structured output fail the
task instead of being retried indefinitely.

An enabled chat model is not a guarantee of valid structured workflow output.
Before publishing, test the selected profile with representative inputs and the
workflow's actual output schema. A successful smoke test proves that request,
not every future response. If a run reports `WORKFLOW_AI_INVALID_OUTPUT`,
inspect the failed step and its selected model in the run details, check the
output constraints, and test a corrected configuration before rerunning.
Cloud keeps the selected model pinned; it does not silently switch providers.

A dry run reports that AI output is unavailable instead of inventing a value.
It charges one `maxAiCalls` unit only when that effect does not already have a
durable task.

Prompts, inputs, and outputs are durable application data. Authorize first and
send only the fields the task needs.

## Run it from durable work

An HTTP request may end before a slow model call does.

For important background work, call `runAiStructured()` from a
[job or queue worker](/en/docs/automation/jobs-and-queues). Pass the job abort
signal and a parent trace.

Keep retries around the whole task. Do not retry a schema failure forever.

Every `runAiStructured()` attempt writes one metadata-only terminal accounting
record for **Admin > AI > AI Usage**. The record contains the task and optional
application id, resolved model, duration, usage, structured-output mode and
repair state, attempts, and a bounded error. It never stores the input, prompt,
or output. Domain-owned run tables and traces remain the detailed operational
source. Workflow inference uses this same accounting record, so task records
do not add a second charge. Each retry that calls the model has its own record.
See [Observability](/en/docs/operations/observability) for pricing coverage and
historical accounting limits. See [Usage and feedback](/en/docs/ai/usage-and-feedback)
for filters, error details, attribution, and the matching CLI commands.

Use [Chat runtime and streaming](/en/docs/ai/chat-runtime-and-streaming) when
the user needs an interactive, stored conversation.

## Transcribe an audio file

Use `runAiTranscription()` from `@k2b/cloud/ai` in an authorized server-side
service. It uses the configured audio model or an explicit transcription
profile and returns text without starting a conversation.

```ts
import { runAiTranscription } from "@k2b/cloud/ai";

const result = await runAiTranscription({
  task: "transcribe-memo",
  file: authorizedAudioBlob,
  filename: "memo.wav",
  language: "de",
  allowedDataBoundaries: ["private"],
  signal,
});
// Persist result.text in the application's own authorized service.
```

The caller owns source authorization, durable input storage, retries, and
result persistence. This function makes one provider call with a ten-minute
upper timeout and respects the caller's abort signal. Empty text is a valid
result when no speech was recognized. It performs no translation, format
conversion, splitting, or automatic retry.

Each attempt records model, task, duration, status, and optional attribution in
the metadata-only AI usage ledger. Audio and transcripts are excluded, and
unknown provider usage or costs remain unknown. See
[Models and providers](/en/docs/ai/models-and-providers#configure-audio-transcription)
for configuration and file limits.


## Background costs and emergency stop

Cloud records every actual provider attempt centrally, including structured
output repair. Replay of a completed workflow step does not repeat inference;
a real retry produces another cost record. Model price snapshots and token
measurements determine reference costs. Applications must not calculate or
record a second charge.

Workflow AI forwards the run and step. Cloud resolves the definition ID, name,
version, and application from the workflow store. Other internal operations use
honest task names, such as compaction or enrichment, with available chat IDs.
An `attribution.stepKey` can identify an existing step; metadata never grants
permission. The usage report can group by workflow and link to its runs.

Operators may enable a shared rolling 24-hour background cost stop on
**Assistant limits → Rules**. A triggered stop rejects new priced background
calls with `ai_background_cost_stop`; the workflow runtime treats this as a
terminal failure rather than retrying automatically. Calls in progress finish
and remain accounted. After reviewing costs, an administrator explicitly
releases the stop and decides which workflows to retry. Unpriced models are
exempt. This stop is independent of direct Assistant budgets.

See [Usage and feedback](/en/docs/ai/usage-and-feedback) for the accounting limits,
price configuration and CLI operations. Audio transcription remains unpriced
because the current provider result contains no billable duration.

## Shared text, classification and extraction tasks

`AiTaskRequestSchema` and its `AiTaskRequestInput`/`AiTaskRequest` types are
available from `@k2b/cloud/ai` and the browser-safe `@k2b/cloud/ai/browser`.
They describe `generate_text`, `classify`, `classify_many` and `extract_data`.
Workflow AI actions and Assistant Code Mode use the same schemas and
`executeAiTask(request, options)` implementation. The executor returns
`{ output, usage }`; it does not create a workflow or grant domain access.

Server callers supply `taskPrefix`, `appId`, `signal`, and trusted attribution.
For interactive, user-owned calculations, pass the authenticated `usageSubject`
to charge the personal chat allowance. Without it, `runAiStructured` keeps its
background-budget behavior. Attribution alone never selects a budget or grants
model access. `AiQuotaError` exposes allowance failures to server callers.

Authorize the resource before inference. Use `selectAssistantAiModelId(subject,
requestedModelId)` for Assistant model grants and `resolveAiModel` with
`personalAiModelPolicy` for the matching data-boundary policy; pass that resolver
through `resolveModel`. Supply only verified server-side identities, not IDs from
the calculation's input. The calculations receive only the supplied prompt and
input, with no tools or implicit conversation context.

## Routine names and stop reasons

A routine can have a short `title` in the user's language, up to 80 characters.
Its `name` uses that title, then the chat title, then the first prompt line
(up to 80 characters). Lists, action reviews and notifications use this name.

A stopped routine has one `reason_code` and a `reason_at` timestamp. The code
determines its state. A database CHECK enforces this relation.

| Code | State | English sentence |
| --- | --- | --- |
| `paused` | `paused` | Paused by you on {time}. What happens meanwhile is not caught up automatically. |
| `chat_archived` | `paused` | Paused because the chat is archived. |
| `owner_inactive` | `paused` | Paused because the account is inactive. |
| `failed` | `needs_attention` | The last run failed. |
| `rights_changed` | `needs_attention` | What it may do changed. Please confirm again. |
| `needs_approval` | `needs_attention` | Tried to {action}. That needs your approval every time, and routines never ask. |

Without an action, `needs_approval` shows only its second sentence. No writer
sets this code yet. The pause time uses `reason_at`, the reader's locale and
the routine's timezone. `chatTaskReasonSentence` from `@k2b/cloud/ai` renders
these sentences in English and German. Browser code imports it from
`@k2b/cloud/ai/browser`.

Raw errors remain technical details. They are not the reason sentence.
A failed run keeps its last model response when available and adds reason
metadata. Without a response, the chat line uses the reason sentence.

A needs-attention notification has the title **“{name}” needs you** and the
reason sentence as its body. Paused routines do not send this notification.
The key `routine:{task uuid}:{code}:{reason_at epoch ms}` permits one notice
per routine and reason until the state changes. Recovery uses the newest
failed occurrence after the notification definition was registered. It also
recognizes legacy `occurrence:{id}` keys, so an upgrade does not resend them.

Creation stores the request locale on the routine. Runs, delivered chat lines
and notifications use that locale, then the instance setting `app.locale`,
then `en`. Existing routines get the locale of the newest personal chat turn
at or before creation, else the newest personal chat turn in that chat.
Background turns do not supply this value. This backfill runs only when the
locale column is first added. Cloud has no stored per-user locale setting.

Archiving a chat through the AI routes pauses its active routines with
`chat_archived`. Admission checks what a routine may do before it checks the
archive, so a routine whose mandate was paused or changed keeps `paused` or
`rights_changed` instead. Admission also pauses a routine whose chat was
archived another way. Restoring the chat resumes only routines paused with
`chat_archived`, and only when their mandate revision is still the one the
archive paused. Otherwise they need attention with `rights_changed`.

A one-time routine resumes only before its time. Once its time has passed, a
run at that time already happened or was stopped, so it needs a new time
first.

Pause and delete request an immediate abort of a running turn. The occurrence
ends as `stopped`. The chat receives one line:

> Stopped while the routine was running. Already done: {list}. Nothing was undone.

With no write call it can name, the line leaves the list out:

> Stopped while the routine was running. Nothing was undone.

It does not claim that nothing changed, because a call without wording can
still have changed something. The list comes from stored successful calls that
the chat words as changes: app Actions with their done sentence, or their title
when the Action has none, and Cloud tools with a done sentence. It never comes
from the model's prose. Reads, failed calls and rejected calls are excluded. The line's metadata stores the stop cause and the done list.
Deleting the routine does not delete this receipt. Recovery can deliver the
line once from a terminal deleted-routine turn completed within the last day.
It does not deliver into an archived chat.
