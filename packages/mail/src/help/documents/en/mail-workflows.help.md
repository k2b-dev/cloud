---
id: mail-workflows
title: Mail workflow YAML reference
icon: ti ti-code
description: Reference for Mail workflow inputs, triggers, actions, conditions, expressions, limits, and examples.
order: 70
---

Mail workflow YAML has three top-level keys: `inputs`, `triggers`, and `steps`. Only `steps` is required. You edit the workflow name, description, priority, effect budget, saved versions, and activation state outside YAML.

Workflow source is limited to 200,000 characters.

:::reference
- **Name:** 1–160 characters.
- **Description:** Optional, at most 2,000 characters.
- **Priority:** An integer from -1,000 to 1,000, default 100. When several Mail workflows accept the same event, lower numbers run first.
:::

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

Choose **Validate** before saving. Validation checks strict YAML, the Mail vocabulary, value paths, accessible catalog names, and incompatible action combinations.

## Declare inputs {icon="point"}

Mail supports two input types:

| Type | Value |
| --- | --- |
| `mailMessage` | One message in this mailbox |
| `mailConversation` | One conversation in this mailbox |

Each input name must start with a letter or underscore and contain only letters, numbers, and underscores. `required` defaults to `false`. Set `required: true` when every caller or trigger must provide the input. A trigger must bind each required input in its `with` block. `steps` must contain at least one step. Mail rejects unknown root keys and action properties.

You can validate a workflow without `triggers` and save it as an inactive draft, but you cannot activate it. Mail has no separate API for manual runs or target queries, on purpose.

Mail accepts at most 20 inputs, 500 steps, 20 nested step levels, 500 conditions, and 20 nested condition levels. These limits apply after parsing the complete workflow, including every branch.

## Use automatic triggers {icon="route"}

### `messageReceived`

`messageReceived` starts once for a stable newly imported message. It does not start for mail that the provider delivers straight to Trash or Junk. It does not start again when another email client moves or copies a message to another folder. It also does not start for a copy of a message that the mailbox already holds. It exposes:

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

`schedule` starts future slots from a five-field cron expression of at most 120 characters. `timezone` accepts an IANA time zone of at most 80 characters and defaults to UTC. The runtime supplies `trigger.occurredAt` and `trigger.slot`. The current Mail vocabulary has no generic date-time input that can keep either value for later steps.

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

Trigger values exist only while Mail binds `with`. Scheduled Mail workflows can therefore currently use only steps that do not require a received message or conversation. `automaticReply` cannot run from a schedule trigger.

Leave out `triggers` while you draft reusable YAML that stays inactive. An empty `triggers: {}` block is invalid, and activation requires at least one trigger.

## Read input and context values {icon="route"}

Message paths:

- `inputs.message.id`, `conversationId`, `subject`, `body`, `bodyText`, `bodyHtml`
- `inputs.message.fromAddress`, `fromDomain`
- `inputs.message.sender.0.role`, `name`, or `email`
- `inputs.message.recipients.0.role`, `name`, or `email`
- `inputs.message.attachments.0.id`, `filename`, `contentType`, `disposition`, `contentId`, or `sizeBytes`
- `inputs.message.hasAttachments`, `folderId`, `flags`, `keywords`, `direction`, `internalDate`, `receivedAt`

Conversation paths:

- `inputs.conversation.id`, `subject`, `summary`, `summaryRevision`, `assigneeUserIds`
- `inputs.conversation.workStatus`, `latestMessageAt`

Mail resource IDs in a workflow are the same stable six-character IDs as in Mail URLs and capabilities. Provider references and database UUIDs are internal and are not workflow fields.

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
| `archiveMessage` | `message` | Moves the message to the mailbox archive folder; on Gmail without a mapped archive folder, to **All Mail**, like the Archive action |
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

Folder, local tag, user, and sender fields accept an accessible name or ID that is not ambiguous. The saved version binds these catalog values before activation. You write the response timing inline, and Mail validates it as part of the version.

Managed incoming automations emit `linkSpaceItem` and `createSpaceEvent`. They use the encrypted, revocable Spaces delegation stored with that automation. Unrelated hand-written Mail workflows therefore cannot use them.

### Check fields, defaults, outputs, and budgets

Reference fields named `message`, `conversation`, or `draft` accept a raw value path of at most 500 characters. Folder, keyword, tag, sender, and user selectors also have at most 500 characters. Variable names in `name` and `saveAs` are identifiers of at most 120 characters.

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
| `automaticReply` | `format`: `plain` by default; `inactiveBehavior`: `defer` by default; `minimumIntervalHours`: 24 by default, from 1 to 8,760 | none | 1 `maxDrafts` and 1 `maxSends` |
| `aiGenerateText` | prompt: 1–20,000 characters; `maxOutputChars`: 4,000 by default, from 1 to 20,000; optional `input` and `model` | required `saveAs` receives `core.text` | 1 `maxAiCalls` for a newly created task |
| `aiClassify` | prompt: 1–20,000 characters; 2–50 unique choices of 1–200 characters; optional `model` | required `saveAs` receives one declared choice as `core.text` | 1 `maxAiCalls` for a newly created task |
| `aiClassifyMany` | same choice limits; `minChoices`: 0 by default; `maxChoices`: all choices by default; both from 0 to 50 | required `saveAs` receives an ordered unique `core.textArray` | 1 `maxAiCalls` for a newly created task |
| `aiExtractData` | 1–40 unique named fields; types are `text`, `number`, `boolean`, `date_time`, or `enum`; enum fields require 1–50 choices; text may set `maxLength` | required `saveAs` receives a strict `core.value` object | 1 `maxAiCalls` for a newly created task |
| `linkSpaceItem`, `createSpaceEvent` | stable six-character Spaces ids; event requires a valid title and ISO start/end range | linked reference or created event | 1 `maxCollaborationChanges`; event also consumes 1 `maxTargets` |
| `setVariable` | any JSON-compatible `value` | `name` receives `core.value` | none |
| `succeed`, `fail` | operator-facing message: at most 1,000 characters | terminal state | none |

`createDraft.to` is required. `cc` and `bcc` are optional. `createReplyDraft` takes recipients and subject from the source message. The `model` field accepts the ID of an enabled AI model profile, at most 120 characters. AI outputs, draft outputs, reference outputs, and variables are visible only to later steps in the same reachable scope.

One reachable path cannot apply several provider changes to the same message. For example, Mail rejects a branch that adds a keyword and then moves the same message. When you need both, split them into separate workflows.

`createDraft` and `createReplyDraft` always produce `deliveryClass: normal`. `createReplyDraft` takes the recipient and subject from the source message, keeps reply threading, and stays attached to its conversation. Only `automaticReply` can create `deliveryClass: automatic_reply`. Normal workflow sends therefore get no automatic-reply headers and no null envelope sender. `scheduleDraftSend` accepts only a `mail.draft` result created earlier in the same reachable scope.

`forEach` is part of the shared workflow grammar, but the Mail vocabulary does not support it on purpose. Mail workflows work on one materialized message target at a time.

## Classify mail and create drafts with AI {icon="sparkles"}

Mail explicitly enables the shared AI actions. AI produces only a value. Mail actions still perform tagging, assignment, folder, draft, and send effects, with the normal mailbox access and budgets.

This example classifies one message into several labels. It uses exact array membership to tag and assign the conversation, and it creates a draft without sending it:

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

Use `aiClassify` when exactly one choice is allowed. Use `aiClassifyMany` when zero or more choices can apply. `minChoices` and `maxChoices` limit the result. Choices are exact values, not free-form model output.

`aiExtractData` declares its complete output contract and accepts no free-form JSON Schema. This example from a generated managed automation extracts event data and creates a linked Spaces event. If the model cannot supply a valid title or time range, structured validation or the `ready` guard stops the create step:

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

The generic field types are `text`, `number`, `boolean`, `date_time`, and `enum`. Optional fields can be absent. The output rejects undeclared fields. The guided editor for incoming mail supplies these automatically: the fixed event field contract, an explicit IANA time zone, the time the message arrived, and the guard against invented data.

An optional `model` selects an enabled profile for one action. Otherwise, Mail uses the platform workflow model, then the background model, then the platform default. Each newly created AI task uses one unit of the `maxAiCalls` budget. By default, this budget is 10 per run.

AI tasks survive worker restarts. Cancelling the Mail run stops running inference where possible and discards late output. A dry run cannot predict AI output. It reports the missing value and does not continue with an invented classification or draft.

Mail stores prompts, inputs, and outputs with the durable task. Include only the message fields that the decision needs. Keep generated replies as drafts when a person needs to review them. Add `scheduleDraftSend` only when sending without review is approved on purpose.

A workflow triggered by `messageReceived` cannot use `scheduleDraftSend` at all. Replies to incoming mail must go through `automaticReply` and its loop protection.

To keep a rolling conversation summary, give `aiGenerateText` both the current summary and the new message. Then pass its normal text output to `setConversationSummary`:

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

The summary has its own optimistic revision. If a person edits it while AI is still running, the delayed workflow action fails and does not overwrite the newer human edit.

## Allocate a conversation reference {icon="book-2"}

Set up and turn on the reference format of the mailbox in **Automations → Workflows**, or directly in the editor of a **Reference acknowledgement**:

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

You can repeat the action safely. It does not allocate a second reference for the same conversation. When `saveAs` is present, later steps in the same scope can use:

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

The sender must be verified and allowed for automatic replies. Mail suppresses loops, bulk and list mail, delivery status messages, repeated responses to one message, and recipients still inside repeat protection.

`schedule` is explicit. Use `{ mode: always }` for a reply that is always active, or `mode: windows` with `timeZone`, `activeRanges`, `weeklyWindows`, and `exceptions`.

:::reference
- **Limits:** A schedule with windows accepts at most 32 active ranges, 64 weekly windows, 366 exceptions, and 32 windows inside one exception.
- **Weekdays:** `weekday` uses ISO numbers from `1` for Monday to `7` for Sunday.
- **Times:** Times are local `HH:mm` values in the configured IANA timezone. Windows cannot overlap or cross midnight. `24:00` is allowed only as an end.
- **Ranges:** An empty `activeRanges` list repeats weekly without a date limit. Each range uses an inclusive `from` date and an inclusive `to` date or `null`.
- **Exceptions:** A date exception overrides the normal weekly windows. `closed: true` turns off the whole date. `closed: false` uses only the listed exception windows.
:::

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

Values created in a `case` stay inside that case. When a later step would need a value from a branch, use terminal actions inside the branches.

## Understand versions and activation {icon="layout-grid"}

Each saved version has an effect budget. `0` disables an effect category except for `maxTargets`, which must be at least 1.

| Budget | Default | Maximum |
| --- | ---: | ---: |
| `maxTargets` | 1,000 | 50,000 |
| `maxMoves`, `maxCopies`, `maxSends`, `maxDrafts`, `maxNotifications` | 1,000 | 50,000 |
| `maxFlagChanges`, `maxKeywordChanges`, `maxCollaborationChanges` | 2,000 | 100,000 |
| `maxAiCalls` | 10 | 1,000 |

The budget belongs to the unchangeable version and limits one run. The runtime counts the matching category immediately before it starts an effect. It fails the run instead of exceeding the limit. Idempotent retries reuse the same effect and do not create another one.

- **Create workflow** stores version 1 but leaves it inactive.
- **Save version** creates another immutable version. It never edits an older version.
- **Activate** registers the selected current version's triggers.
- **Update available** means the current saved version differs from the active version.
- **Deactivate** stops future automatic trigger materialization. Existing run history remains.

Changing an accessible folder or sender does not change a saved version. Mail evaluates the reference pattern of the mailbox when it allocates a number. Existing reference values stay unchanged. The schedule is part of the YAML itself. To change the response timing, save a new workflow version and activate it explicitly.

## Validate and inspect runs {icon="layout-list"}

**Validate** checks the source and the catalog bindings but does not run steps. Mail workflows start only from their active `messageReceived` or `schedule` triggers. There is no separate path for manual runs or backfills.

To read and validate workflows, you need **View** access to the mailbox. To create versions, change metadata, activate, and deactivate, you need **Manage** access. Only Cloud administrators can inspect runs across all apps, cancel them, and resolve uncertain effects.

Every action checks the mailbox access that the workflow version pinned. If the person who activated it later loses personal access, an already accepted run continues. Deactivation or replacement prevents new runs. To stop unfinished effects in an accepted run, request cancellation. Provider commands also pin the kernel execution generation, so a worker that lost its lease cannot reach the mail provider.

Cloud administrators inspect the run history in **Admin → Observability → Workflows**. The shared view shows runs, step results, effects, source events, failures, and items that need attention across all apps. The matching CLI commands are:

```bash
cld admin workflows runs --app mail
cld admin workflows show <run-id>
cld admin workflows effects --app mail
cld admin workflows events --app mail
```

`cld admin workflows cancel <run-id> --yes` prevents later effects but does not undo completed work. Resolve an uncertain external result only after you have checked it at the provider. Then record that decision with `cld admin workflows resolve`.

For setup tasks and operational consequences, see [Automate responses and mailbox work](/app/mail/help/mail-automation).
