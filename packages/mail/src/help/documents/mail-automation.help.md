---
id: mail-automation
title: Automate responses and mailbox work
icon: ti ti-automation
description: Configure automatic replies, incoming-mail processing, and safe workflow activation.
order: 60
---

Open **Mailbox tools > Automations**. The full-width overview shows what is active and opens the exact setup you select. **Automatic replies** and **Incoming mail** cover common tasks. Mailbox admins also see **Activity** and **Workflows** under Advanced.

## Choose the right automation tool {icon="route"}

| Need | Use |
| --- | --- |
| Send an out-of-office or receipt acknowledgement | **Automatic replies** |
| Route, mark, label, assign, classify, or draft from incoming mail | One guided flow under **Incoming mail** |
| Give conversations permanent human-facing IDs | A reference acknowledgement or custom **Workflow** |
| Combine tasks beyond the guided editors or intentionally automate delivery | An advanced **Workflow** |

The tools can work together, but creating one does not activate another. Reference-number settings define the format; a workflow still decides when to allocate a number. Saving a workflow does not activate it.

## Build an incoming automation {icon="mailbox"}

Mailbox admins create one guided flow under **Automations > Incoming mail** or start it directly from a message's organization menu. Choose **All incoming mail** when no condition is needed, or combine up to eight sender, domain, subject, body-text, or attachment-presence conditions and choose whether all or any condition must match.

Add steps in the order they should run. A flow can freely mix:

- **Mail action** to move, mark, add a local tag, assign, or change conversation status.
- **AI generate text** to produce bounded text for later steps.
- **AI classify** to produce exactly one configured category.
- **AI classify many** to produce up to the configured maximum of matching categories.
- **Link Spaces item** to attach the conversation to an existing writable task or event.
- **AI extract event + create Spaces event** to select a destination, extract validated event fields, and create one linked event.
- **Create reply draft**, **Add internal comment**, or **Set conversation summary** with custom text or an earlier text output.
- **If output matches** to run normal Mail or AI steps in a Then or Else branch.

Reply drafts and internal comments are normal Mail steps and do not require AI. Add either step directly, then choose **Custom text** or a compatible earlier workflow output as its text source. AI results remain normal workflow outputs. **Use output** and **Add condition** are shortcuts that add ordinary following steps; they do not hide extra behavior inside the AI block. Then and Else branches can again contain Mail actions, AI steps, output consumers, or conditions.

The editor disables or omits additions that would exceed the flow, branch, nesting, or AI-call limits. A step that produces output cannot be removed while a later step still uses that output. Renaming an AI classification choice updates conditions that use it; remove or change those conditions before deleting an in-use choice.

### Know the guided definition contract

The guided editor and the CLI use the same strict definition. Unknown fields are rejected. A definition has `name`, `enabled`, `scope`, and `steps`; its name accepts 1–120 characters, and a new definition defaults `enabled` to `false`.

- `scope.mode: all` needs no conditions. `scope.mode: matching` requires `conditions.mode: all|any` and 1–8 unique condition items. Fields are `sender_address`, `sender_domain`, `subject`, `body_text`, and `attachment_presence`. Sender address and domain use `operator: is`; subject and body accept `is`, `contains`, `starts_with`, or `ends_with`; attachment presence uses `is` with a boolean `value`. Address values accept 1–320 characters, domains 1–253, and subject or body values 1–1,000.
- Every step has a unique UUID in `id`. Step kinds are `mail_action`, `ai_generate_text`, `ai_classify`, `ai_classify_many`, `ai_extract_event`, `link_space_item`, `create_space_event`, `create_reply_draft`, `add_comment`, `set_summary`, and `if`.
- A `mail_action` is `junk`, `trash`, `mark_read`, `add_keyword`, `move_to_folder`, `add_local_tag`, `assign_user`, or `set_status`. Catalog-backed actions use `folderId`, `tagId`, or `userId`; status is `needs_action`, `waiting`, or `done`. The guided editor recommends local tags and no longer offers `add_keyword` for new steps. Existing definitions containing it remain editable, and CLI or advanced workflow callers can still use it for provider interoperability; a keyword accepts 1–100 characters and must use valid provider-keyword syntax.
- `ai_generate_text.instructions` accepts 1–4,000 characters and `maxOutputChars` is 200–10,000. `ai_classify` and `ai_classify_many` accept 2–10 choices with case-insensitively unique names; a choice name accepts 1–80 characters and its description 1–500. `ai_classify_many.maxChoices` is from 1 to the number of choices.
- `ai_extract_event` accepts 1–4,000 characters of instructions and an explicit IANA `timeZone`. Its structured output contains `ready`, title, optional description and location, start, end, and all-day state. Missing or ambiguous title or times set `ready: false`; the following event step then stops instead of inventing an event.
- `link_space_item.itemId` identifies one existing writable task or event. `create_space_event` requires a writable `spaceId`, open `columnId`, and either explicit event data or an earlier `ai_extract_event` output through `sourceStepId`. The guided editor shows these IDs read-only; use **Change item** or **Change destination** to select another currently writable target. Explicit event data uses `title`, optional `description` and `location`, ISO `startsAt` and `endsAt`, and `allDay`. The created event includes a stable reference back to the Mail conversation.
- `create_reply_draft`, `add_comment`, and `set_summary` use `body: { kind: custom, value: ... }` with 1–50,000 characters or `body: { kind: step_output, sourceStepId: ... }` for an earlier text-producing AI step. A multi-choice result is not a text source. Reply drafts additionally require a catalog `senderIdentityId`.
- An `if` condition references an earlier AI `sourceStepId`. Use `equals` for generated text or one classification and `includes` for multi-classification; `value` accepts 1–500 characters and must name a declared choice for classification. Both `then` and `else` contain at most 12 steps.
- A definition contains 1–20 top-level steps, at most 40 steps across branches, at most 4 branch levels, and at most 10 AI calls. One reachable path can contain only one provider-message action, assignment, status change, and summary replacement, and cannot add the same local tag twice.

Mail generates canonical workflow YAML from the flow and shows it read-only in the editor. Steps run from top to bottom through the shared workflow runtime. If a later step fails, effects from earlier completed steps remain. Editing the flow publishes a new immutable workflow version; changing only the name or active state does not duplicate identical source. Destructive actions cannot target a mailbox identity, a configured internal domain, its subdomains, or an unsafe parent domain.

Text conditions support exact, contains, starts-with, and ends-with matching. Regular expressions are intentionally unavailable until Mail can enforce a bounded RE2-compatible matcher.

New incoming automations start inactive. A deterministic flow can preview and process existing matching messages with a resumable backfill. The durable cursor survives restarts, a failed message is retried without stopping unrelated workflow runs, and a repeated backfill skips messages already accepted for the same immutable version. The automation menu shows progress and lets you cancel or run it again.

Any flow containing an AI step processes only future messages. Mail matching conditions run before AI. The Safety section shows the maximum number of AI calls per matching message. AI can classify or write incorrectly, so keep category descriptions precise and review the first runs under **Activity**. A generated text output has no effect until a later step uses it. Reply automation only creates drafts for human review and never sends them.

Spaces steps run with a revocable delegation of the user who configured the automation. Mail stores its token encrypted and revokes it when the last Spaces step is removed or the automation is deleted. Every run still checks current Mail authority and current Spaces access. Linking is an upsert, and event creation uses a durable idempotency key, so retries do not create duplicate events. Revoking the delegated API key or removing Space access makes future runs fail closed.

Use `set_status: done` to complete a conversation. Use `needs_action` or `waiting` to reopen it explicitly. A verified new inbound message already moves a completed conversation back to Needs action, so a separate “unmark done on incoming mail” step is normally unnecessary.

For automation through `cld`, use `mail automation catalog` to discover valid IDs. `mail automation create` and `mail automation update` accept the complete guided definition as JSON or YAML through `--definition-file` or `--definition-stdin`, including `scope` and the ordered `steps` tree. This keeps CLI and UI behavior identical, including output references and nested conditions.

The platform workflow model is used automatically; Mail does not expose a separate model choice. Use advanced **Workflows** only when the guided building blocks do not cover the task.

## Configure an automatic reply {icon="send"}

:::steps
1. Ask a mailbox admin to verify an identity and enable **Automatic replies** for it under **Settings > Accounts & identities > Sending identities**.
2. Open **Automations > Automatic replies**.
3. Select **Add automatic reply**.
4. Choose **Out of office**, **Office-hours acknowledgement**, **Reference acknowledgement**, or **Custom automatic reply**.
5. Review the sender, subject, body, schedule, repeat protection, and behavior outside active times.
6. Use **Preview** for Markdown content.
7. Select **Save automatic reply**.
:::

Subjects and messages are Liquid templates. Use the copyable variables in the editor, for example `{{ inputs.message.subject }}` or, after assigning a reference, `{{ reference.value }}`. Invalid syntax and unavailable variables are rejected before the reply is saved.

Only one automatic reply can be enabled for a mailbox at a time. Disable the active configuration before enabling another one. By default only mailbox admins can change automatic replies. An admin can allow writers under **Settings > Access > Who can manage automatic replies?**

Mail does not reply to messages that are unsafe for automatic responses, including mailing-list mail, bulk mail, delivery-status notifications, messages from the mailbox itself, and messages that explicitly suppress automatic replies. A suppressed reply remains part of the activity and run history; it is not silently converted into a normal draft.

## Set dates and weekly hours {icon="point"}

Automatic replies and inline workflow response windows use the same time rules:

- **Time zone** controls how every date and time is evaluated.
- **Active date ranges** limit the schedule to an absence or campaign. With no range, weekly hours repeat indefinitely.
- **Weekly hours** list every weekday separately. A checked weekday card is enabled. Turn on **All day** for `00:00–24:00`, or add one or more non-overlapping windows for that day. A card marked **Disabled** never sends a response.
- **Date exceptions** close one date or replace that date's normal hours.
- **Do not reply** suppresses messages received outside an active window.
- **Reply at the next active time** retains the response until the next active window.

An exception wins over normal weekly hours. Times cannot cross midnight; create one window before midnight and another on the following day.

## Understand repeat protection {icon="shield-lock"}

**Repeat protection** is the minimum time before the same sender may receive another automatic reply from this mailbox.

- The **Out of office** preset uses 96 hours, or 4 days. This prevents a sender who writes several times during one absence from receiving the same notice every day.
- **Office-hours acknowledgement** and **Custom automatic reply** use 24 hours.
- `0` disables the sender interval, but Mail still prevents duplicate replies to the same incoming message and keeps its protocol-level loop guards.

Choose a shorter interval only when repeated acknowledgements are useful to the recipient. The value is mailbox-wide for that automatic reply, not a delay before the first response.

For a YAML workflow, define these rules directly under `automaticReply.schedule`. The schedule is part of the immutable workflow version, so reviewing and activating that version also reviews and activates its timing. See [Build Mail workflows](/app/mail/help/mail-workflows#send-a-guarded-automatic-reply) for the complete YAML shape.

## Create conversation references {icon="square-plus"}

A conversation reference is a permanent mailbox-scoped identifier such as `REF-K7M3-P9QX-2F4N`. It helps people quote, search, and audit one conversation even if subjects change.

:::steps
1. Open **Automations > Automatic replies** and choose **Reference acknowledgement**, or open **Workflows** for custom YAML.
2. If no reference format exists, configure it directly in the same reply editor or from the reference panel on the Workflows page.
3. Enter a Liquid pattern with exactly one identifier output. The privacy-safe default is `REF-{{ short_id }}`. The editor explains every placeholder and shows a preview.
4. Save the format without leaving or losing the reply you already entered.
5. Finish the automatic reply, or add `ensureConversationReference` to your custom workflow.
:::

Supported pattern parts:

- `{{ short_id }}` inserts a short, readable random ID without exposing volume or allocation time.
- `{{ uuid }}` inserts an opaque random UUID.
- `{{ uuid_v7 }}` inserts a sortable UUID that exposes its allocation time.
- `{{ ulid }}` inserts a compact sortable ID that exposes its allocation time.
- `{{ sequence }}` inserts the next mailbox-scoped number and therefore exposes order and approximate volume.
- `{{ sequence | pad_start: 6 }}` pads the counter to six digits. Width can be from 1 to 120.
- `{{ year }}`, `{{ month }}`, `{{ month_name }}`, and `{{ day }}` insert UTC allocation-date parts.
- Letters, numbers, spaces, `.`, `_`, `-`, and `/` can be used as literal separators.

Use exactly one of the five identifier outputs. Date parts are optional and do not make a reference unique. Allocation is idempotent: running the same action again returns the conversation's existing reference instead of allocating another one. References remain attached as aliases after conversation merges. Disabling allocation prevents new references but does not rewrite existing values.

The **Reference acknowledgement** preset assigns the reference before sending and inserts `{{ reference.value }}` into the message. The same result binding is available in custom YAML. Once a conversation has a reference, new reply subjects use `Re: [REF-K7M3-P9QX-2F4N] Original subject` by default. Mail still threads replies through standard `Message-ID`, `In-Reply-To`, and `References` headers.

## Save and activate a workflow safely {icon="route"}

:::steps
1. Open **Automations > Workflows** and select **New workflow**.
2. Enter its name, description, priority, YAML, and effect budgets.
3. Select **Validate** and fix every line-specific diagnostic.
4. Select **Create workflow** or **Save version**.
5. Review the new version under **Versions**.
6. Select **Activate** or **Activate current version**.
7. Verify the first matching execution under **Automations > Activity**. Platform operators can also use **Admin > Observability > Workflows**.
:::

Saving never activates a version. An already active version continues to run until an administrator explicitly activates the newer one. **Update available** means the saved current version and active version differ.

Effect budgets are hard upper bounds for moves, sends, keyword changes, collaboration changes, and AI calls during one execution. An execution stops before applying an effect that would exceed its budget. AI output remains data until a later Mail action uses it, so classification, tagging, assignment, drafting, and sending remain independently reviewable steps.

## Observe and stop workflow runs {icon="activity"}

Mailbox administrators use **Automations > Activity** for mailbox-scoped automatic replies, incoming automations, custom workflows, and resumable backfills. The table shows the automation type, state, duration, time, and a bounded failure or result message. Platform administrators retain the cross-application detail view under **Admin > Observability > Workflows**.

Select **Cancel** when no further effects should start. Cancellation does not reverse mail moves, sends, or collaboration changes that already completed. A run that needs attention waits for an administrator to record whether an uncertain external effect completed. Disabling a Mail workflow prevents new trigger matches; it does not rewrite completed history.

For the complete YAML vocabulary and validated examples, see [Mail workflow YAML reference](/app/mail/help/mail-workflows).
