---
title: Structured and background AI
navTitle: Structured and background AI
section: AI
order: 1060
description: Run validated model tasks outside an interactive chat request.
tags: [ai, structured-output, background]
updated: 2026-08-23
---

# Structured and background AI

Use `runAiStructured()` for one schema-valid model result.

It is the right API for classification, extraction, enrichment, and other
bounded tasks that do not need a conversation.

`runAiStructured()` executes a model request. It does not receive an actor or
an access subject.

Cloud does not expose a generic `POST /api/ai/executions` endpoint. Application
workflows authorize their domain input and use the durable shared AI workflow
actions below; bounded server code calls `runAiStructured()` directly. This
keeps arbitrary prompts and domain data out of a new public execution surface.

Authorize the domain read first. Send only the fields required by the task.

## Run a structured task

```ts
import { runAiStructured } from "@valentinkolb/cloud/ai";
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

The function resolves the model, requests structured output, validates the
result, and records a trace span.

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
there is no full custom compaction prompt.

Do not silently turn a failed AI result into application truth. Decide whether
the caller should retry, skip the optional enrichment, or surface the error.

## Add AI to an application workflow

AI is an optional workflow building block. An application enables it by
composing the shared actions into its workflow module:

```ts
import {
  AI_WORKFLOW_ACTIONS,
  defineWorkflowModule,
} from "@valentinkolb/cloud/workflows";

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
`@valentinkolb/cloud/workflows/ai`.

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
historical accounting limits.

Use [Chat runtime and streaming](/en/docs/ai/chat-runtime-and-streaming) when
the user needs an interactive, stored conversation.
