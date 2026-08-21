---
id: mail-workflows
title: Mail workflow YAML reference
icon: ti ti-code
description: Reference for Mail workflow inputs, triggers, actions, conditions, expressions, limits, and examples.
order: 70
---

Mail workflow YAML has three top-level keys: `inputs`, `triggers`, and `steps`. Only `steps` is required. The workflow name, description, priority, effect budget, saved versions, and activation state are edited outside YAML.

Workflow source is limited to 200,000 characters. A saved workflow name accepts 1–160 characters, its optional description at most 2,000 characters, and its priority an integer from -1,000 to 1,000 with a default of 100. Lower priority numbers run first when several Mail workflows accept the same event.

## Start with a received-message workflow {icon="route"}

This workflow adds a portable provider keyword when a received subject contains the text `invoice`:

```yaml
inputs:
  message:
    type: mailMessage
    required: true
  conversation:
    type: mailConversation
    required: true
triggers:
  messageReceived:
    with:
      message: "${{ trigger.message }}"
      conversation: "${{ trigger.conversation }}"
steps:
  - if:
      contains:
        - "${{ inputs.message.subject }}"
        - invoice
    then:
      - addKeyword:
          message: inputs.message
          keyword: Finance
      - setConversationStatus:
          conversation: inputs.conversation
          status: waiting
```

Select **Validate** before saving. Validation checks strict YAML, the Mail vocabulary, value paths, accessible catalog names, and incompatible action combinations.

## Declare inputs {icon="point"}

Mail supports two input types:

| Type | Value |
| --- | --- |
| `mailMessage` | One message in this mailbox |
| `mailConversation` | One conversation in this mailbox |

Each input name must start with a letter or underscore and contain only letters, numbers, and underscores. `required` defaults to `false`; set `required: true` when every caller or trigger must provide the input. A trigger must bind each required input in its `with` block. `steps` must contain at least one step, and unknown root keys or action properties are rejected.

A workflow without `triggers` can be validated and saved as an inactive draft, but it cannot be activated. Mail intentionally has no separate manual-run or target-query API.

Mail accepts at most 20 inputs, 500 steps, 20 nested step levels, 500 conditions, and 20 nested condition levels. These limits apply after parsing the complete workflow, including every branch.

## Use automatic triggers {icon="route"}

### `messageReceived`

`messageReceived` starts once for a stable newly imported message. It exposes:

- `trigger.message`
- `trigger.conversation`
- `trigger.occurredAt`

Bind these values to declared inputs:

```yaml
inputs:
  message:
    type: mailMessage
    required: true
  conversation:
    type: mailConversation
    required: true
triggers:
  messageReceived:
    with:
      message: "${{ trigger.message }}"
      conversation: "${{ trigger.conversation }}"
steps:
  - succeed:
      message: "Received {{ inputs.message.subject }}"
```

### `schedule`

`schedule` starts future slots from a five-field cron expression of at most 120 characters. `timezone` accepts an IANA time zone of at most 80 characters and defaults to UTC. The runtime supplies `trigger.occurredAt` and `trigger.slot`, but the current Mail vocabulary has no generic date-time input that can retain either value for later steps.

```yaml
triggers:
  schedule:
    cron: "0 8 * * 1-5"
    timezone: Europe/Berlin
    with: {}
steps:
  - succeed:
      message: The scheduled mailbox check ran.
```

Trigger values exist only while binding `with`. Scheduled Mail workflows are therefore currently limited to steps that do not require a received message or conversation. `automaticReply` cannot run from a schedule trigger.

Omit `triggers` while drafting reusable YAML that should remain inactive. An empty `triggers: {}` block is invalid, and activation requires at least one trigger.

## Read input and context values {icon="route"}

Message paths:

- `inputs.message.id`, `conversationId`, `subject`, `body`, `bodyText`, `bodyHtml`
- `inputs.message.fromAddress`, `fromDomain`
- `inputs.message.sender.0.role`, `name`, or `email`
- `inputs.message.recipients.0.role`, `name`, or `email`
- `inputs.message.attachments.0.id`, `filename`, `contentType`, `disposition`, `contentId`, or `sizeBytes`
- `inputs.message.hasAttachments`, `folderId`, `flags`, `keywords`, `direction`, `internalDate`, `receivedAt`

Conversation paths:

- `inputs.conversation.id`, `subject`, `summary`, `summaryRevision`, `assigneeUserId`
- `inputs.conversation.workStatus`, `latestMessageAt`

Mail resource IDs exposed to a workflow use the same stable six-character IDs as Mail URLs and capabilities. Provider references and database UUIDs are internal and are not workflow fields.

Execution context paths:

- `context.mailboxId`
- `context.actor.userId`, `context.actor.serviceAccountId`, `context.actor.groupIds`
- `context.occurredAt`

Array indices must be normal decimal indices such as `.0`, not `.00`. A missing or unsupported path is a validation error.

## Write literals, references, and expressions {icon="pencil"}

- A plain value such as `Finance` is literal text.
- A dynamic value uses the whole expression string: `"${{ inputs.message.subject }}"`.
- `${{ now() }}` returns the run clock as an ISO date-time value.
- Text fields such as reply subjects, reply bodies, and `succeed.message` are Liquid templates: `"Re: {{ inputs.message.subject }}"`.
- Reference-only action fields use raw paths such as `message: inputs.message` and `conversation: inputs.conversation`.
- `{{ context.occurredAt }}` contains the workflow occurrence time.
- `setVariable` creates a value for later steps in the same scope.

```yaml
inputs:
  message:
    type: mailMessage
    required: true
steps:
  - setVariable:
      name: senderAddress
      value: "${{ inputs.message.sender.0.email }}"
  - succeed:
      message: "Message from {{ senderAddress }} processed at {{ context.occurredAt }}"
```

Variables created inside a branch do not escape that branch. Defining the same variable name twice in one scope is invalid.

## Use Mail actions {icon="route"}

| Action | Required fields | Consequence |
| --- | --- | --- |
| `addKeyword` | `message`, `keyword` | Adds a portable provider keyword |
| `removeKeyword` | `message`, `keyword` | Removes a portable provider keyword |
| `moveMessage` | `message`, `folder` | Moves the message to an accessible provider folder |
| `copyMessage` | `message`, `folder` | Copies the message to an accessible provider folder |
| `archiveMessage` | `message` | Moves the message to the mailbox archive folder |
| `trashMessage` | `message` | Moves the message to the mailbox trash folder |
| `junkMessage` | `message` | Moves the message to the mailbox junk folder |
| `addFlag` / `removeFlag` | `message`, `flag` | Changes `seen`, `answered`, `flagged`, or `draft` through the provider command journal |
| `assignConversation` | `conversation`, `user` | Assigns by accessible user name or ID; `null` unassigns |
| `setConversationStatus` | `conversation`, `status` | Sets `needs_action`, `waiting`, or `done` |
| `setConversationSummary` | `conversation`, `summary` | Replaces the editable conversation summary |
| `ensureConversationReference` | `conversation`; optional `saveAs` | Allocates or reuses the permanent mailbox reference and optionally stores its result |
| `addLocalTag` / `removeLocalTag` | `conversation`, `tag` | Changes a mailbox-local conversation tag |
| `addComment` | `conversation`, `body` | Adds an internal comment attributed to the workflow version |
| `createDraft` | `sender`, `to`, `subject`, `body`, `saveAs` | Creates a normal-delivery workflow draft for a later step |
| `createReplyDraft` | `message`, `conversation`, `sender`, `body`, `saveAs` | Creates a reviewable reply draft in the source conversation |
| `scheduleDraftSend` | `draft`, `scheduledAt` | Schedules a created normal-delivery draft through the durable outbox |
| `notifyUser` | `user`, `title`, `body` | Sends an internal notification to a current mailbox reader |
| `automaticReply` | `message`, `conversation`, `sender`, `subject`, `body`, `schedule` | Queues one guarded automatic response |
| `aiGenerateText` | `prompt`, `saveAs` | Generates bounded text; `input`, `model`, and `maxOutputChars` are optional |
| `aiClassify` | `input`, `prompt`, `choices`, `saveAs` | Returns exactly one declared choice |
| `aiClassifyMany` | `input`, `prompt`, `choices`, `saveAs` | Returns a unique subset of declared choices |
| `aiExtractData` | `input`, `prompt`, `fields`, `saveAs` | Returns one object validated against declared bounded fields |
| `linkSpaceItem` | `conversation`, `item` | Links a conversation to an existing writable Spaces task or event |
| `createSpaceEvent` | `conversation`, `space`, `column`, `event` | Creates one retry-safe event with a conversation reference |
| `setVariable` | `name`, `value` | Stores a value for later steps |
| `succeed` | `message` | Stops the run successfully |
| `fail` | `message` | Stops the run with a non-retryable workflow error |

Folder, local-tag, user, and sender fields accept an unambiguous accessible name or ID. The saved version binds those catalog values before activation. Response timing is written inline and validated as part of the version.

`linkSpaceItem` and `createSpaceEvent` are emitted by managed incoming automations. They use the encrypted, revocable Spaces delegation stored with that automation and therefore are not available to unrelated hand-written Mail workflows.

### Check fields, defaults, outputs, and budgets

Reference fields named `message`, `conversation`, or `draft` accept a raw value path and are limited to 500 characters. Folder, keyword, tag, sender, and user selectors are also limited to 500 characters. Variable names in `name` and `saveAs` are identifiers of at most 120 characters.

| Actions | Additional fields and defaults | Output | Budget per execution |
| --- | --- | --- | --- |
| `addKeyword`, `removeKeyword` | `keyword`: 1–500 characters | none | 1 `maxKeywordChanges` |
| `moveMessage` | accessible `folder` name or ID | none | 1 `maxMoves` |
| `copyMessage` | accessible `folder` name or ID | none | 1 `maxCopies` |
| `archiveMessage`, `trashMessage`, `junkMessage` | no additional fields | none | 1 `maxMoves` |
| `addFlag`, `removeFlag` | `flag`: `seen`, `answered`, `flagged`, or `draft` | none | 1 `maxFlagChanges` |
| `assignConversation`, `setConversationStatus`, `setConversationSummary`, `ensureConversationReference`, `addLocalTag`, `removeLocalTag`, `addComment` | summary and comment text: at most 50,000 characters | reference only when `saveAs` is set | 1 `maxCollaborationChanges` |
| `createDraft`, `createReplyDraft` | `format`: `markdown` by default or `plain`; subject: at most 998 characters; body: at most 2 MiB; each To, Cc, or Bcc list: at most 200 addresses | required `saveAs` receives `mail.draft` | 1 `maxDrafts` |
| `scheduleDraftSend` | `scheduledAt`: ISO timestamp of at most 100 characters | none | 1 `maxSends` |
| `notifyUser` | title: at most 160 characters; body: at most 2,000 characters | none | 1 `maxNotifications` |
| `automaticReply` | `format`: `plain` by default; `inactiveBehavior`: `defer` by default; `minimumIntervalHours`: 24 by default, from 0 to 8,760 | none | 1 `maxDrafts` and 1 `maxSends` |
| `aiGenerateText` | prompt: 1–20,000 characters; `maxOutputChars`: 4,000 by default, from 1 to 20,000; optional `input` and `model` | required `saveAs` receives `core.text` | 1 `maxAiCalls` for a newly created task |
| `aiClassify` | prompt: 1–20,000 characters; 2–50 unique choices of 1–200 characters; optional `model` | required `saveAs` receives one declared choice as `core.text` | 1 `maxAiCalls` for a newly created task |
| `aiClassifyMany` | same choice limits; `minChoices`: 0 by default; `maxChoices`: all choices by default; both from 0 to 50 | required `saveAs` receives an ordered unique `core.textArray` | 1 `maxAiCalls` for a newly created task |
| `aiExtractData` | 1–40 unique named fields; types are `text`, `number`, `boolean`, `date_time`, or `enum`; enum fields require 1–50 choices; text may set `maxLength` | required `saveAs` receives a strict `core.value` object | 1 `maxAiCalls` for a newly created task |
| `linkSpaceItem`, `createSpaceEvent` | stable six-character Spaces ids; event requires a valid title and ISO start/end range | linked reference or created event | 1 `maxCollaborationChanges`; event also consumes 1 `maxTargets` |
| `setVariable` | any JSON-compatible `value` | `name` receives `core.value` | none |
| `succeed`, `fail` | operator-facing message: at most 1,000 characters | terminal state | none |

`createDraft.to` is required; `cc` and `bcc` are optional. `createReplyDraft` derives recipients and subject from the source message. The `model` field accepts an enabled AI model profile ID of at most 120 characters. AI outputs, draft outputs, reference outputs, and variables are visible only to later steps in the same reachable scope.

One reachable path cannot apply several provider mutations to the same message. For example, adding a keyword and then moving that same message in one branch is rejected. Split those operations into separate workflows when both are required.

`createDraft` and `createReplyDraft` always produce `deliveryClass: normal`. `createReplyDraft` derives the recipient and subject from the source message, preserves reply threading, and stays attached to its conversation. Only `automaticReply` can create `deliveryClass: automatic_reply`; normal workflow sends therefore do not receive automatic-reply headers or a null envelope sender. `scheduleDraftSend` accepts only a `mail.draft` result created earlier in the same reachable scope.

`forEach` is part of the shared workflow grammar but is deliberately unsupported by the Mail vocabulary. Mail workflows operate on one materialized message target at a time.

## Classify mail and create drafts with AI {icon="sparkles"}

Mail explicitly enables the shared AI actions. AI produces only a value; Mail actions still perform tagging, assignment, folder, draft, and send effects under normal mailbox authorization and budgets.

This example classifies one message into several labels, uses exact array membership to tag and assign the conversation, and creates a draft without sending it:

```yaml
inputs:
  message:
    type: mailMessage
    required: true
  conversation:
    type: mailConversation
    required: true
triggers:
  messageReceived:
    with:
      message: "${{ trigger.message }}"
      conversation: "${{ trigger.conversation }}"
steps:
  - aiClassifyMany:
      input:
        subject: "${{ inputs.message.subject }}"
        body: "${{ inputs.message.bodyText }}"
      prompt: Select every matching category.
      choices: [finance, urgent, support]
      maxChoices: 3
      saveAs: categories
  - if:
      includes:
        - "${{ categories }}"
        - finance
    then:
      - addLocalTag:
          conversation: inputs.conversation
          tag: Finance
  - if:
      includes:
        - "${{ categories }}"
        - urgent
    then:
      - addLocalTag:
          conversation: inputs.conversation
          tag: Urgent
      - assignConversation:
          conversation: inputs.conversation
          user: Alice Example
  - aiGenerateText:
      prompt: Write a concise reply draft. Do not invent facts or promise a deadline.
      input:
        subject: "${{ inputs.message.subject }}"
        body: "${{ inputs.message.bodyText }}"
      maxOutputChars: 4000
      saveAs: reply
  - createReplyDraft:
      message: inputs.message
      conversation: inputs.conversation
      sender: Support
      body: "{{ reply }}"
      format: plain
      saveAs: draft
```

Use `aiClassify` when exactly one choice is allowed. Use `aiClassifyMany` when zero or more choices may apply; `minChoices` and `maxChoices` bound the result. Choices are exact values, not free-form model output.

`aiExtractData` declares its complete output contract instead of accepting free-form JSON Schema. This generated managed-automation example extracts event data and creates a linked Spaces event. If the model cannot supply a valid title or time range, structured validation or the `ready` guard stops the create step:

```yaml
inputs:
  message: { type: mailMessage, required: true }
  conversation: { type: mailConversation, required: true }
triggers:
  messageReceived:
    with:
      message: "${{ trigger.message }}"
      conversation: "${{ trigger.conversation }}"
steps:
  - aiExtractData:
      input:
        subject: "${{ inputs.message.subject }}"
        body: "${{ inputs.message.bodyText }}"
        receivedAt: "${{ inputs.message.receivedAt }}"
      prompt: Extract calendar details. Interpret relative dates in Europe/Berlin. Do not invent missing facts.
      fields:
        - { name: ready, type: boolean, description: "True only when title, start, and end are unambiguous." }
        - { name: title, type: text, description: Concise event title., required: false, maxLength: 500 }
        - { name: startsAt, type: date_time, description: ISO start with offset., required: false }
        - { name: endsAt, type: date_time, description: ISO end with offset., required: false }
        - { name: allDay, type: boolean, description: Whether the event is all day. }
      saveAs: eventData
  - createSpaceEvent:
      conversation: inputs.conversation
      space: Space1
      column: Col001
      event: "${{ eventData }}"
```

The generic field types are `text`, `number`, `boolean`, `date_time`, and `enum`. Optional fields may be absent; output rejects undeclared fields. The guided incoming-mail editor supplies the fixed event field contract, an explicit IANA time zone, the message receipt time, and the no-invention guard automatically.

An optional `model` selects an enabled profile for one action. Otherwise Mail uses the platform workflow model, then the background model, then the platform default. Each newly created AI task consumes one `maxAiCalls` budget unit; Mail defaults that budget to 10 per run.

AI tasks survive worker restarts. Canceling the Mail run aborts running inference when supported and discards late output. A dry run cannot predict AI output, so it reports the unavailable value instead of continuing with a fabricated classification or draft.

Prompts, inputs, and outputs are stored with the durable task. Include only message fields needed for the decision. Keep generated replies as drafts when a person should review them; add `scheduleDraftSend` only when unattended sending is intentionally approved.

To maintain a rolling conversation summary, supply both the current summary and the newly received message to `aiGenerateText`, then pass its normal text output to `setConversationSummary`:

```yaml
inputs:
  message:
    type: mailMessage
    required: true
  conversation:
    type: mailConversation
    required: true
triggers:
  messageReceived:
    with:
      message: "${{ trigger.message }}"
      conversation: "${{ trigger.conversation }}"
steps:
  - aiGenerateText:
      prompt: Update the summary with durable facts and the current next step. Keep it concise.
      input:
        existingSummary: "${{ inputs.conversation.summary }}"
        newMessage:
          sender: "${{ inputs.message.fromAddress }}"
          subject: "${{ inputs.message.subject }}"
          body: "${{ inputs.message.bodyText }}"
      maxOutputChars: 1200
      saveAs: updatedSummary
  - setConversationSummary:
      conversation: inputs.conversation
      summary: "{{ updatedSummary }}"
```

The summary has its own optimistic revision. If a person edits it while AI is still running, the delayed workflow action fails instead of overwriting the newer human edit.

## Allocate a conversation reference {icon="book-2"}

Configure and enable the mailbox reference format under **Automations > Workflows**, or directly inside a Reference acknowledgement editor:

```yaml
inputs:
  conversation:
    type: mailConversation
    required: true
steps:
  - ensureConversationReference:
      conversation: inputs.conversation
      saveAs: reference
  - setConversationStatus:
      conversation: inputs.conversation
      status: waiting
  - succeed:
      message: "Allocated {{ reference.value }}"
```

The action is safe to repeat and does not allocate a second reference for the same conversation. When `saveAs` is present, later steps in the same scope can use:

- `{{ reference.value }}` for the permanent human-facing reference such as `REF-K7M3-P9QX-2F4N`.
- `{{ reference.created }}` to distinguish a new allocation from an existing value.
- `{{ reference.conversationId }}` and `{{ reference.conversationRevision }}` for subsequent workflow logic.

## Send a guarded automatic reply {icon="send"}

`automaticReply` is valid only when every trigger in the workflow is `messageReceived`.

```yaml
inputs:
  message:
    type: mailMessage
    required: true
  conversation:
    type: mailConversation
    required: true
triggers:
  messageReceived:
    with:
      message: "${{ trigger.message }}"
      conversation: "${{ trigger.conversation }}"
steps:
  - automaticReply:
      message: inputs.message
      conversation: inputs.conversation
      sender: Support
      subject: "Re: {{ inputs.message.subject }}"
      body: "Thank you for your message. We will respond during office hours."
      format: markdown
      schedule:
        mode: windows
        timeZone: Europe/Berlin
        activeRanges: []
        weeklyWindows:
          - weekday: 1
            start: "09:00"
            end: "17:00"
          - weekday: 2
            start: "09:00"
            end: "17:00"
          - weekday: 3
            start: "09:00"
            end: "17:00"
          - weekday: 4
            start: "09:00"
            end: "17:00"
          - weekday: 5
            start: "09:00"
            end: "17:00"
        exceptions:
          - date: "2026-12-25"
            closed: true
            windows: []
      inactiveBehavior: defer
      minimumIntervalHours: 24
```

Optional fields and defaults:

- `format`: `plain` by default, or `markdown`
- `inactiveBehavior`: `defer` by default, or `skip`
- `minimumIntervalHours`: `24` by default, from `0` to `8760`

The sender must be verified and enabled for automatic replies. Mail suppresses loops, bulk/list mail, delivery-status messages, repeated responses to one message, and recipients still inside repeat protection.

`schedule` is explicit: use `{ mode: always }` for an always-active reply, or `mode: windows` with `timeZone`, `activeRanges`, `weeklyWindows`, and `exceptions`. A windowed schedule accepts at most 32 active ranges, 64 weekly windows, 366 exceptions, and 32 windows inside one exception. `weekday` uses ISO numbers from `1` for Monday through `7` for Sunday. Times are local `HH:mm` values in the configured IANA timezone. Windows cannot overlap or cross midnight; `24:00` is allowed only as an end. An empty `activeRanges` list repeats weekly without a date limit. Each range uses an inclusive `from` date and an inclusive `to` date or `null`. A date exception overrides normal weekly windows: `closed: true` disables the whole date, while `closed: false` uses only the listed exception windows.

## Add conditions {icon="search"}

An `if` step takes one condition and a non-empty `then` list. `else` is optional.

Supported comparisons:

- `equals` and `notEquals`
- `textEquals`, `contains`, `startsWith`, and `endsWith` for normalized, case-insensitive text
- `includes` for exact membership in an array such as `aiClassifyMany` output
- `exists` for one raw reference
- recursive `all`, `any`, and `not`

`equals`, `notEquals`, and `includes` compare exact values. `textEquals`, `contains`, `startsWith`, and `endsWith` normalize Unicode text and ignore letter case.

```yaml
inputs:
  message:
    type: mailMessage
    required: true
  conversation:
    type: mailConversation
    required: true
steps:
  - if:
      all:
        - exists: inputs.message.subject
        - any:
            - startsWith:
                - "${{ inputs.message.subject }}"
                - "[Urgent]"
            - contains:
                - "${{ inputs.message.bodyText }}"
                - service unavailable
        - not:
            equals:
              - "${{ inputs.conversation.workStatus }}"
              - done
    then:
      - assignConversation:
          conversation: inputs.conversation
          user: Alice Example
    else:
      - succeed:
          message: No urgent assignment required.
```

## Branch with `switch` {icon="point"}

`switch` compares one value against ordered `cases`. The optional `default` runs when no case matches.

```yaml
inputs:
  conversation:
    type: mailConversation
    required: true
steps:
  - switch: "${{ inputs.conversation.workStatus }}"
    cases:
      - when: needs_action
        do:
          - setVariable:
              name: result
              value: active
      - when: waiting
        do:
          - setVariable:
              name: result
              value: pending
    default:
      - succeed:
          message: Conversation is already done.
```

Values created in a `case` remain inside that case. Use terminal actions inside branches when a later step would need a branch-local value.

## Understand versions and activation {icon="layout-grid"}

Each saved version has an effect budget. `0` disables an effect category except for `maxTargets`, which must be at least 1.

| Budget | Default | Maximum |
| --- | ---: | ---: |
| `maxTargets` | 1,000 | 50,000 |
| `maxMoves`, `maxCopies`, `maxSends`, `maxDrafts`, `maxNotifications` | 1,000 | 50,000 |
| `maxFlagChanges`, `maxKeywordChanges`, `maxCollaborationChanges` | 2,000 | 100,000 |
| `maxAiCalls` | 10 | 1,000 |

The budget belongs to the immutable version and limits one run. The runtime charges the relevant category immediately before starting an effect and fails the run instead of exceeding the limit. Idempotent retries reuse the same effect rather than creating another one.

- **Create workflow** stores version 1 but leaves it inactive.
- **Save version** creates another immutable version. It never edits an older version.
- **Activate** registers the selected current version's triggers.
- **Update available** means the current saved version differs from the active version.
- **Deactivate** stops future automatic trigger materialization. Existing run history remains.

Changing an accessible folder or sender does not rewrite a saved version. The mailbox reference pattern is evaluated when a number is allocated, while existing reference values remain unchanged. Changing response timing means saving and explicitly activating a new workflow version because the schedule is part of the YAML itself.

## Validate and inspect runs {icon="layout-list"}

**Validate** checks source and catalog bindings but does not execute steps. Mail workflows start only from their active `messageReceived` or `schedule` triggers; there is no separate manual-run or backfill path.

Reading and validating workflows requires mailbox Read access. Creating versions, changing metadata, activating, and deactivating require mailbox Admin access. Cross-application run inspection, cancellation, and uncertain-effect resolution require Cloud administrator access.

Every action rechecks the workflow version's pinned mailbox authority. Removing the activating administrator's later personal access does not disable an already accepted run. Deactivation or replacement prevents new runs; request cancellation to stop unfinished effects in an accepted run. Provider commands additionally pin the kernel execution generation, so a worker that lost its lease cannot reach the mail provider.

Administrators inspect runtime history in **Administration > Observability > Workflows**. The shared view shows runs, step outcomes, effects, source events, failures, and items that need attention across all applications. The equivalent CLI commands are:

```bash
cld admin workflows runs --app mail
cld admin workflows show <run-id>
cld admin workflows effects --app mail
cld admin workflows events --app mail
```

`cld admin workflows cancel <run-id> --yes` prevents later effects but does not undo completed work. Resolve an uncertain external outcome only after verifying it at the provider, then record that decision with `cld admin workflows resolve`.

For setup tasks and operational consequences, see [Automate responses and mailbox work](/app/mail/help/mail-automation).
