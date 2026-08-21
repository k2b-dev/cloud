# Mail automation

Read this reference when configuring managed automatic replies, conversation references, or Mail workflow YAML. Start with [Mail CLI](mail.md) for mailbox setup, permissions, search, and collaboration.

## Choose the right automation surface

| Need | Use |
| --- | --- |
| Out-of-office or receipt acknowledgement | `automatic-reply ...` |
| Guided sender, content, or attachment routing plus Mail and AI actions | `automation ...` |
| Permanent human-facing conversation ids | `reference ...` plus `ensureConversationReference` |
| Conditional routing, tagging, assignment, drafts, sends, or notifications | `workflow ...` |

Managed automatic replies are convenience configurations backed by the same guarded response behavior as workflows. Presets exist only in the Mail application; the persisted configuration and CLI input use one stable schema.

Mailbox admins control whether writers may manage automatic replies:

```bash
cld mail configure --automatic-replies writers
cld mail configure --automatic-replies admins
```

This delegation does not grant access to identity configuration, references, or arbitrary YAML workflows.

## Manage automatic replies

List current configurations:

```bash
cld --json mail automatic-reply list
```

Create a configuration from JSON or YAML:

```yaml
name: Out of office
enabled: true
senderIdentityId: Ident1
subject: "Re: Your message"
body: |
  Thank you for your message. I am away until 2026-08-03.
format: markdown
ensureReference: false
minimumIntervalHours: 96
inactiveBehavior: skip
schedule:
  mode: windows
  timeZone: Europe/Berlin
  activeRanges:
    - from: 2026-07-20
      to: 2026-08-03
  weeklyWindows:
    - weekday: 1
      start: "00:00"
      end: "24:00"
    - weekday: 2
      start: "00:00"
      end: "24:00"
    - weekday: 3
      start: "00:00"
      end: "24:00"
    - weekday: 4
      start: "00:00"
      end: "24:00"
    - weekday: 5
      start: "00:00"
      end: "24:00"
    - weekday: 6
      start: "00:00"
      end: "24:00"
    - weekday: 7
      start: "00:00"
      end: "24:00"
  exceptions: []
```

```bash
cld --json mail automatic-reply create --configuration-file out-of-office.yml
```

Use `--configuration-stdin` instead of `--configuration-file` when another tool produces the document. Do not pass multiline configuration inline.

Replace a configuration at its expected revision:

```bash
cld --json mail automatic-reply update \
  <configuration-id> \
  --revision <current-revision> \
  --configuration-file out-of-office.yml
```

The complete configuration is replaced; omitted optional fields receive their create defaults. `name` accepts 1–80 characters, `subject` at most 998 characters, and `body` at most 2 MiB. `format` accepts `plain` or `markdown`. The defaults are enabled, Markdown, no reference allocation, a 24-hour sender interval, and `skip` outside active times. `senderIdentityId` must identify a verified automation-enabled identity.

Only one managed automatic reply may be enabled for a mailbox at a time. Set `enabled: false` on the current configuration before enabling another one. The selected identity must be verified and automation-enabled.

Schedule rules are evaluated in `timeZone`:

- `activeRanges` contains at most 32 inclusive date ranges. `to: null` has no end.
- `weeklyWindows` contains at most 64 entries using ISO weekdays from 1 for Monday to 7 for Sunday.
- `24:00` is allowed only as an end. Windows cannot cross midnight.
- `exceptions` contains at most 366 entries and at most 32 windows per entry. Each item has `date`, `closed`, and `windows`: `closed: true` closes the date, while `closed: false` replaces that date's normal windows with the supplied list.
- `inactiveBehavior: skip` suppresses a response outside active time.
- `inactiveBehavior: defer` retains it until the next active window.
- `minimumIntervalHours` limits repeated replies to the same sender. `0` disables this interval, but protocol loop and same-message duplicate guards remain active.

Mail also suppresses unsafe automatic responses such as bulk mail, mailing-list mail, delivery-status notifications, self-mail, and messages that request no automatic reply.

## Manage incoming automations

Incoming automations are guided managed workflows. One definition can match all incoming mail or a set of conditions, then mix direct Mail actions with AI steps and branches:

```bash
cld --json mail automation catalog
cld --json mail automation list
cld --json mail automation create --definition-file automation.yaml
cld --json mail automation get <automation-id>
cld --json mail automation update <automation-id> --revision <revision> --definition-file automation.yaml
cld mail automation delete <automation-id> --revision <revision> --yes
```

`automation.yaml` is the complete definition. Updates must explicitly retain or change `enabled`:

```yaml
name: Triage incoming mail
enabled: false
scope:
  mode: all
steps:
  - id: 00000000-0000-4000-8000-000000000001
    kind: ai_classify
    instructions: Choose the single best category.
    choices:
      - name: Important
        description: Needs personal attention.
      - name: Routine
        description: Can be handled as routine mail.
  - id: 00000000-0000-4000-8000-000000000002
    kind: if
    condition:
      sourceStepId: 00000000-0000-4000-8000-000000000001
      operator: equals
      value: Important
    then:
      - id: 00000000-0000-4000-8000-000000000003
        kind: mail_action
        action: { kind: set_status, status: needs_action }
    else: []
```

Use `mode: matching` with a condition set for sender, domain, subject, body, or attachment filters. Direct actions can move mail, mark it read, add a keyword or local tag, assign a user, set collaboration status, link an existing Spaces item, create a linked Spaces event, add an internal comment, create a reply draft, or replace the conversation summary. AI steps can generate text, classify, select multiple labels, or extract validated event data. Guided text generation receives the new message and the existing summary as structured input. `automation catalog` returns mailbox-scoped folder, tag, user, and sender-identity ids. Use `cld spaces list`, `cld spaces search`, and `cld spaces show` to discover Space, kanban, task, and event ids.

The incoming-automation file is strict: unknown fields are rejected. `name` accepts 1–120 characters and new definitions default to `enabled: false` when the field is omitted.

- `scope.mode: all` needs no conditions. `scope.mode: matching` requires `conditions.mode: all|any` and 1–8 unique condition items.
- Condition fields are `sender_address`, `sender_domain`, `subject`, `body_text`, and `attachment_presence`. Sender address and domain use only `operator: is`; subject and body accept `is`, `contains`, `starts_with`, or `ends_with`; attachment presence uses `is` with a boolean `value`. Address values accept 1–320 characters, domains 1–253, and subject or body values 1–1,000.
- Step kinds are `mail_action`, `ai_generate_text`, `ai_classify`, `ai_classify_many`, `ai_extract_event`, `link_space_item`, `create_space_event`, `create_reply_draft`, `add_comment`, `set_summary`, and `if`. Every step has a unique UUID in `id`.
- Direct `mail_action` values are `junk`, `trash`, `mark_read`, `add_keyword`, `move_to_folder`, `add_local_tag`, `assign_user`, and `set_status`. Catalog-backed actions use `folderId`, `tagId`, or `userId`; status accepts `needs_action`, `waiting`, or `done`. `add_keyword.keyword` accepts 1–100 characters and must use valid provider-keyword syntax.
- `ai_generate_text` takes `instructions` of 1–4,000 characters and `maxOutputChars` of 200–10,000. Classification takes 2–10 choices with case-insensitively unique names; a choice `name` accepts 1–80 characters and its `description` 1–500. `ai_classify_many.maxChoices` is from 1 to the number of choices.
- `ai_extract_event` takes 1–4,000 characters of `instructions` and an explicit IANA `timeZone`. It returns strict event data with a `ready` guard. `create_space_event` accepts either that earlier `sourceStepId` or explicit `title`, ISO `startsAt`, ISO `endsAt`, optional `description` and `location`, and `allDay`; AI ambiguity stops creation. `link_space_item` takes one writable Spaces `itemId`, while destinations use `spaceId` and `columnId`.
- A text consumer uses `body: { kind: custom, value: ... }` with 1–50,000 characters or `body: { kind: step_output, sourceStepId: ... }`. Only an earlier text-producing AI step is valid, and a multi-choice result is not a text source. `create_reply_draft` additionally requires a catalog `senderIdentityId`.
- An `if` condition references an earlier AI `sourceStepId`: use `equals` for generated text or single classification and `includes` for multi-classification. Its `value` accepts 1–500 characters and must name a declared choice for classification. Both `then` and `else` are step arrays of at most 12 items.
- A definition starts with 1–20 top-level steps, contains at most 40 steps across branches, has at most 4 branch levels, and makes at most 10 AI calls. One reachable path may contain only one provider message action, one assignment, one status change, and one summary replacement; it cannot add the same local tag twice.

Automations apply to incoming mail only; Cloud rejects a mailbox's own active identities. Destructive flows must restrict every possible match to an external sender or domain and reject configured internal domains, subdomains, and unsafe parent domains. `automation get` exposes the exact generated workflow YAML.

Preview sender-scoped work before changing existing messages:

```bash
cld --json mail sender preview --match sender --value news@example.com
cld --json mail automation backfill start <automation-id> --revision <revision> --yes
cld --json mail automation backfill status <automation-id> <operation-id>
cld --json mail automation backfill cancel <automation-id> <operation-id> --yes
```

A non-AI automation backfill walks every candidate message with a durable cursor and emits targeted events into the same workflow runtime used for new mail. `start` returns an `operationId`; use it with `status` or `cancel`. AI flows intentionally process only future mail. Cancel an active backfill before editing, disabling, or deleting its automation. Mutations require the revision shown by `automation get`; they refuse stale state instead of silently adopting the latest revision.

Spaces actions use an encrypted, revocable delegation created for the configuring user. Current Mail and Spaces permissions are rechecked when a run executes. Event creation is idempotent across retries. Removing all Spaces steps or deleting the automation revokes the delegation. Use `set_status: done` to complete a conversation; `needs_action` or `waiting` reopens it, while a verified new inbound message already reopens a completed conversation automatically.

## Configure conversation references

A mailbox has one optional reference-number configuration. Set its permanent format before a workflow allocates references:

```bash
cld --json mail reference config set \
  --pattern 'SUP-{{ year }}-{{ sequence | pad_start: 6 }}' \
  --enable \
  --include-in-reply-subjects

cld --json mail reference config show
```

The pattern uses Liquid and must output exactly one identity value: `short_id`, `uuid`, `uuid_v7`, `ulid`, or `sequence`. Date values `year`, `month`, `month_name`, and `day` may appear alongside it. Use `{{ sequence | pad_start: 6 }}` to pad a sequence. The default is `REF-{{ short_id }}`. Changing the pattern affects only future allocations; existing references remain immutable and searchable.

Allocation is idempotent for each conversation:

```bash
cld --json mail reference ensure <conversation-id> --idempotency-key support-import-42
cld --json mail reference list <conversation-id>
cld --json mail reference find SUP-2026-000042
```

Use `--disable` to stop new allocations without removing existing values. Use `--exclude-from-reply-subjects` when new human and automatic replies should keep their original subject. A workflow controls when allocation happens; the mailbox configuration controls only the sequence and reply-subject behavior.

## Write canonical workflow YAML

Mail workflows use the shared Cloud workflow language: strict YAML with top-level `inputs`, optional automatic `triggers`, and `steps`. Workflow metadata is not part of the YAML. Mail lifecycle records store name, description, priority, activation state, immutable version ids, and effect budgets.

The shared AI action `aiExtractData` takes `input`, `prompt`, 1–40 declared `fields`, optional `model`, and `saveAs`. Field `type` is `text`, `number`, `boolean`, `date_time`, or `enum`; fields may set `required`, text may set `maxLength`, and enum fields require `choices`. Managed incoming automations also compile their Spaces steps to `linkSpaceItem` with `conversation` and `item`, or `createSpaceEvent` with `conversation`, `space`, `column`, and an `event` value. These Spaces actions depend on the managed automation's encrypted delegation and are not available to unrelated hand-written Mail workflows.

The source accepts 1–200,000 characters, at most 20 inputs, 500 steps, 20 nested step levels, 500 conditions, and 20 nested condition levels. Input and variable names start with a letter or underscore and then contain only letters, numbers, and underscores. Input `required` defaults to `false`. `steps` must be non-empty. Unknown root keys, action names, properties, and value paths are validation errors.

This workflow runs for each newly imported inbound message, adds one provider keyword, and updates its conversation:

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
      all:
        - contains:
            - "${{ inputs.message.subject }}"
            - invoice
        - not:
            equals:
              - "${{ inputs.conversation.workStatus }}"
              - done
    then:
      - addKeyword:
          message: inputs.message
          keyword: Finance
      - setConversationStatus:
          conversation: inputs.conversation
          status: waiting
```

`messageReceived` is emitted once for a stable inbound message imported by live incremental sync. Historical backfill does not emit it. Activation grants the active version mailbox-owned automation authority. Deactivation stops new automatic runs without changing existing versions or runs.

Every active Mail workflow needs a `messageReceived` or `schedule` trigger. An empty `triggers: {}` is invalid.

The language also accepts a five-field cron schedule and an optional IANA timezone:

```yaml
triggers:
  schedule:
    cron: "0 8 * * *"
    timezone: Europe/Berlin
    with: {}

steps:
  - succeed:
      message: Scheduled check completed
```

Activation reconciles schedules into the shared scheduler. Every delivered slot has a deterministic key and revalidates the active workflow version before creating a run. Duplicate delivery reuses the same logical run. Slots missed while the scheduler process is offline are skipped rather than backfilled.

## Use inputs and conditions

Mail exposes two input types:

- `mailMessage`: `id`, `conversationId`, `subject`, `sender`, `recipients`, `body`, `bodyText`, `bodyHtml`, `attachments`, `hasAttachments`, `folderId`, `flags`, `keywords`, `direction`, `internalDate`, and `receivedAt`.
- Mail resource fields in workflow inputs and outputs use stable six-character Mail IDs; provider references and database UUIDs are not part of that workflow vocabulary.
- `mailConversation`: `id`, `subject`, `summary`, `summaryRevision`, `assigneeUserId`, `workStatus`, and `latestMessageAt`.

Use `${{ inputs.<name> }}` for a whole input and `${{ inputs.<name>.<field> }}` for a field. `${{ now() }}` resolves from the run clock. `context.mailboxId` is also available.

Conditions are recursive and contain exactly one operator:

- `equals` and `notEquals` compare two values.
- `textEquals`, `contains`, `startsWith`, and `endsWith` compare two normalized, case-insensitive text values.
- `includes` tests exact membership in an array such as an `aiClassifyMany` result.
- `exists` accepts one reference such as `inputs.conversation.assigneeUserId`.
- `all` and `any` contain one or more conditions; `not` contains one condition.

Steps may use `if`/`then`/`else` and `switch`/`cases`/`default`. The shared parser understands `forEach`, but the Mail binder rejects it because each Mail event starts one durable workflow run.

## Use the complete action vocabulary

| Action | Required configuration | Effect |
| --- | --- | --- |
| `addKeyword` | `message`, `keyword` | Add a portable provider keyword |
| `removeKeyword` | `message`, `keyword` | Remove a portable provider keyword |
| `moveMessage` | `message`, accessible folder name or id in `folder` | Move through the durable provider journal |
| `copyMessage` | `message`, accessible folder name or id in `folder` | Copy through the durable provider journal |
| `archiveMessage` | `message` | Move to the configured Archive role |
| `trashMessage` | `message` | Move to the configured Trash role |
| `junkMessage` | `message` | Move to the configured Junk role |
| `addFlag` | `message`, `seen`, `answered`, `flagged`, or `draft` in `flag` | Add one standard provider flag |
| `removeFlag` | `message`, `seen`, `answered`, `flagged`, or `draft` in `flag` | Remove one standard provider flag |
| `assignConversation` | `conversation`, assignable user name, id, expression, or `null` in `user` | Change assignment transactionally |
| `setConversationStatus` | `conversation`, `needs_action`, `waiting`, or `done` in `status` | Change work state transactionally |
| `setConversationSummary` | `conversation`, `summary` | Replace the editable conversation summary transactionally |
| `ensureConversationReference` | `conversation`; optional identifier in `saveAs` | Allocate or return the immutable reference |
| `addLocalTag` | `conversation`, mailbox-local tag name or id in `tag` | Add a Cloud-local tag |
| `removeLocalTag` | `conversation`, mailbox-local tag name or id in `tag` | Remove a Cloud-local tag |
| `addComment` | `conversation`, `body` | Add an internal comment |
| `createDraft` | sender, recipients, subject, body, and identifier in `saveAs`; optional cc, bcc, format | Create a normal-delivery draft |
| `createReplyDraft` | `message`, `conversation`, sender, body, and identifier in `saveAs`; optional format | Create a reviewable reply draft in the source conversation |
| `scheduleDraftSend` | draft value reference in `draft`, ISO timestamp in `scheduledAt` | Schedule a created draft |
| `notifyUser` | mailbox reader in `user`, `title`, `body` | Send an internal notification |
| `automaticReply` | `message`, `conversation`, sender, subject, body, `schedule`; optional format, inactive behavior, and repeat interval | Queue a guarded automatic response |
| `aiGenerateText` | `prompt`, identifier in `saveAs`; optional `input`, `model`, `maxOutputChars` | Return bounded `core.text` without a Mail effect |
| `aiClassify` | `input`, `prompt`, 2–50 `choices`, identifier in `saveAs`; optional `model` | Return exactly one declared choice as `core.text` |
| `aiClassifyMany` | `input`, `prompt`, 2–50 `choices`, identifier in `saveAs`; optional `minChoices`, `maxChoices`, `model` | Return a unique `core.textArray` subset |
| `setVariable` | identifier in `name`, expression or literal in `value` | Store a pure scoped value |
| `succeed` | operator-facing `message` | Stop successfully |
| `fail` | operator-facing `message` | Stop with failure |

Literal folder, tag, sender, and user names are bound to accessible stable ids when a version is created. Unknown, inaccessible, or ambiguous names fail validation.

`createDraft` and `createReplyDraft` default `format` to `markdown`; subject text is limited to 998 characters and body text to 2 MiB. `aiGenerateText.maxOutputChars` defaults to 4,000 and accepts 1–20,000. AI prompts accept 1–20,000 characters, model profile ids and identifiers accept at most 120 characters, and classification choices accept 1–200 characters each. `aiClassifyMany.minChoices` defaults to `0`; `maxChoices` defaults to the number of declared choices. Every selected variable name must be a valid identifier and is visible only to later steps in the same scope.

Reference a value stored by `setVariable` or an action result as `${{ <name> }}` in later steps in the same scope. Mail validation reserves `inputs` and `trigger`.

Reference allocation can expose its result:

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
  - ensureConversationReference:
      conversation: inputs.conversation
      saveAs: reference
  - automaticReply:
      message: inputs.message
      conversation: inputs.conversation
      sender: Support
      subject: "Re: {{ inputs.message.subject }}"
      body: "Thank you. Your reference is {{ reference.value }}."
      format: markdown
      schedule: { mode: always }
```

The reference result contains `id`, `value`, `created`, `conversationId`, and `conversationRevision`.

An automatic reply may carry its response window inline:

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
      body: "We received your message."
      format: markdown
      minimumIntervalHours: 24
      inactiveBehavior: defer
      schedule:
        mode: windows
        timeZone: Europe/Berlin
        activeRanges: []
        weeklyWindows:
          - weekday: 1
            start: "09:00"
            end: "17:00"
        exceptions: []
```

`automaticReply` requires every workflow trigger to be `messageReceived`. Reusable response-schedule records are not part of the current model; schedule configuration lives in the immutable YAML version.

## Validate, save, and activate

Keep YAML in a file so the exact source can be reviewed and versioned:

```bash
cld mail workflow validate --source-file route-mail.yml

cld --json mail workflow create \
  --name "Route invoices" \
  --description "Tag new invoices for the finance team" \
  --priority 100 \
  --max-targets 500 \
  --max-moves 0 \
  --max-copies 0 \
  --max-sends 0 \
  --max-drafts 0 \
  --max-flag-changes 500 \
  --max-notifications 0 \
  --max-keyword-changes 500 \
  --max-collaboration-changes 500 \
  --max-ai-calls 10 \
  --source-file route-mail.yml
```

Use `--source-stdin` instead of `--source-file` when another command produces exact YAML. Names accept 1–160 characters, descriptions at most 2,000 characters, and priority is an integer from -1,000 to 1,000 with a default of 100. Lower priority numbers run first when several Mail workflows accept the same event.

Creation stores one immutable version but does not activate it:

```bash
cld --json mail workflow list
cld --json mail workflow get <workflow-id>
cld mail workflow export <workflow-id> > route-mail.yml
cld --json mail workflow version list <workflow-id>
cld --json mail workflow version get <workflow-id> <version-id>
cld --json mail workflow activate <workflow-id> --version-id <version-id>
```

Changing YAML creates another immutable version. It does not mutate the active version or historical runs:

```bash
cld --json mail workflow version create \
  <workflow-id> \
  --source-file route-mail.yml \
  --max-targets 500 \
  --max-moves 500
cld --json mail workflow activate <workflow-id> --version-id <new-version-id>
cld --json mail workflow deactivate <workflow-id> --version-id <active-version-id>
```

A new version receives the effect budgets passed to that command; it does not inherit omitted values from the previous version. Activation and deactivation require the expected current or active version id, so a concurrent edit fails instead of activating the wrong source.

Update metadata without creating a source version:

```bash
cld --json mail workflow update <workflow-id> --name "Route urgent invoices" --priority 50
```

Export writes only exact YAML bytes in text mode, making shell redirection safe. Pass `--version-id` to export historical source. Restore history by creating a new inactive immutable version; the historical row is never changed:

```bash
cld mail workflow export <workflow-id> --version-id <historical-version-id> > historical.yml
cld --json mail workflow version restore \
  <workflow-id> \
  <historical-version-id> \
  --current-version-id <current-version-id>
```

## Observe and control runs

Mail uses the shared Cloud workflow kernel. Cloud administrators inspect every app's runs through the central operations commands:

```bash
cld admin workflows health --json
cld admin workflows runs --app mail --json
cld admin workflows show <run-id> --json
cld admin workflows effects --app mail --json
cld admin workflows events --app mail --json
```

Request cooperative cancellation when no further effects should start:

```bash
cld admin workflows cancel <run-id> --yes
```

Cancellation does not undo completed effects. If an external effect has an uncertain outcome, inspect it with `workflows effects` and record the verified outcome with `cld admin workflows resolve`. Read [Administration](admin.md) for the exact filters, states, and resolution command.

## Understand budgets, permissions, and recovery

Every saved version carries limits for targets, moves, copies, sends, drafts, flag changes, notifications, keyword changes, collaboration changes, and AI calls. Defaults are 1,000 for targets, moves, copies, sends, drafts, and notifications; 2,000 for flag, keyword, and collaboration changes; and 10 for AI calls.

The accepted maximum is 50,000 for targets, moves, copies, sends, drafts, and notifications; 100,000 for flag, keyword, and collaboration changes; and 1,000 for AI calls. `maxTargets` must be at least 1; every other budget may be `0` to forbid that effect.

Creating versions and activating or deactivating workflows requires mailbox `admin`; validation and inspection require `read`. Central run inspection and control requires Cloud administrator access.

Runs use the active version's mailbox-owned authority, so removing the activating administrator's later personal access does not silently disable approved automation. Deactivation or replacement prevents new runs. Runs already accepted retain their pinned version and authority; cancel them centrally to stop unfinished work.

Provider actions create idempotent Mail commands. A step may wait for a command or message hydration. Durable outcomes survive retries; lease generations fence stale workers; dependency completion wakes waiting runs. Ambiguous provider outcomes become `needs_attention` rather than being blindly repeated.

## Call the workflow API directly

Prefer the CLI unless another HTTP client must integrate directly. Mail workflow routes are under `/api/mail/mailboxes/{mailboxId}`. Use `cld api-docs operations mail` for the live OpenAPI contract.

Create a workflow with an explicit effect budget:

```bash
jq -n --rawfile source route-mail.yml '{
  name: "Route invoices",
  description: "Move new invoices into the team folder",
  priority: 100,
  source: $source,
  effectBudget: {
    maxTargets: 500,
    maxMoves: 500,
    maxCopies: 0,
    maxSends: 0,
    maxDrafts: 0,
    maxFlagChanges: 500,
    maxNotifications: 0,
    maxKeywordChanges: 500,
    maxCollaborationChanges: 500,
    maxAiCalls: 10
  }
}' > create-workflow.json

curl -fsS -X POST \
  "$CLOUD_URL/api/mail/mailboxes/$MAILBOX_ID/workflows" \
  -H "Authorization: Bearer $CLD_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary @create-workflow.json
```

The Mail API manages definitions and activations only. Runtime observability and control use the shared Admin workflow API published by the Cloud core application; discover it with `cld api-docs operations cloud` or use `cld admin workflows`.

## Command map

| Area | Commands |
| --- | --- |
| Automatic replies | `automatic-reply list|create|update` |
| Incoming automations | `automation catalog|list|get|create|update|delete`, `automation backfill start|status|cancel` |
| References | `reference config show|set`, `reference list|ensure|find` |
| Workflow lifecycle | `workflow list|get|validate|create|update|export|activate|deactivate`, `workflow version list|get|create|restore` |
| Runtime operations | `cld admin workflows health|runs|show|cancel|effects|resolve|events` |
