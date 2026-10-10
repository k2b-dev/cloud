---
id: mail-automation
title: Automate responses and mailbox work
icon: ti ti-automation
description: Configure automatic replies, incoming-mail processing, and safe workflow activation.
order: 60
---

Open **Mailbox tools → Automations**. The full-width overview shows what is active and opens the exact setup that you choose. **Automatic replies** and **Incoming mail** cover common tasks. With **Manage** access, you also see **Activity** and **Workflows** under Advanced.

## Choose the right automation tool {icon="route"}

| Need | Use |
| --- | --- |
| Send an out-of-office notice or a receipt acknowledgement | **Automatic replies** |
| Route, mark, label, assign, classify, or draft from incoming mail | One guided flow under **Incoming mail** |
| Give conversations permanent IDs for people | A reference acknowledgement or a custom **Workflow** |
| Combine tasks beyond the guided editors, or automate delivery on purpose | An advanced **Workflow** |

The tools can work together, but creating one does not activate another. Reference-number settings define the format; a workflow still decides when to allocate a number. Saving a workflow does not activate it.

## Build an incoming automation {icon="mailbox"}

With **Manage** access, you create one guided flow under **Automations → Incoming mail**. You can also start it directly from the organization menu of a message.

- Choose **All incoming mail** when you need no condition.
- Or combine up to eight conditions on sender, domain, subject, body text, or attachment presence. Choose whether all or any condition must match.

An incoming automation runs once per received message. Mail that the provider delivers straight to Trash or Junk, such as spam that its filter caught, does not start incoming automations or automatic replies. Someone can move the message to another folder in a different email client, for example back to the Inbox after the automation moved it away. The automation then does not run again.

Add steps in the order in which they run. A flow can freely mix:

- **Mail action** to move, mark, add a local tag, assign, or change the conversation status.
- **AI generate text** to produce limited text for later steps.
- **AI classify** to produce exactly one configured category.
- **AI classify many** to produce matching categories, up to the configured maximum.
- **Link Spaces item** to attach the conversation to an existing task or event where the automation has **Edit** access.
- **AI extract event + create Spaces event** to choose a destination, extract checked event fields, and create one linked event.
- **Create reply draft**, **Add internal comment**, or **Set conversation summary** with custom text or an earlier text output.
- **If output matches** to run normal Mail or AI steps in a Then or Else branch.

Reply drafts and internal comments are normal Mail steps and do not require AI. Add either step directly. Then choose **Custom text** or a matching earlier workflow output as its text source.

AI results remain normal workflow outputs. **Use output** and **Add condition** are shortcuts that add ordinary following steps. They do not hide extra behavior inside the AI block. Then and Else branches can again contain Mail actions, AI steps, steps that use outputs, or conditions.

The editor turns off or leaves out additions that would exceed the limits for the flow, branches, nesting, or AI calls. You cannot remove a step that produces output while a later step still uses that output. When you rename an AI classification choice, Mail updates the conditions that use it. Before you delete a choice in use, remove or change those conditions.

### Know the guided definition contract

The guided editor and the CLI use the same strict definition. Mail rejects unknown fields. A definition has `name`, `enabled`, `scope`, and `steps`. Its name accepts 1–120 characters. A new definition sets `enabled` to `false` by default.

:::reference
- **Scope:** `scope.mode: all` needs no conditions. `scope.mode: matching` requires a `conditions` object with `mode: all|any` and an `items` list of 1–8 unique conditions, for example `conditions: { mode: all, items: [{ field: sender_address, operator: is, value: user@example.com }] }`.
- **Condition fields:** `sender_address`, `sender_domain`, `subject`, `body_text`, and `attachment_presence`. Sender address and domain use `operator: is`. Subject and body accept `is`, `contains`, `starts_with`, or `ends_with`. Attachment presence uses `is` with a boolean `value`.
- **Condition values:** Addresses accept 1–320 characters, domains 1–253, and subject or body values 1–1,000.
- **Steps:** Every step has a unique UUID in `id`. Step kinds are `mail_action`, `ai_generate_text`, `ai_classify`, `ai_classify_many`, `ai_extract_event`, `link_space_item`, `create_space_event`, `create_reply_draft`, `add_comment`, `set_summary`, and `if`.
- **Mail actions:** A `mail_action` is `junk`, `trash`, `mark_read`, `add_keyword`, `move_to_folder`, `add_local_tag`, `assign_user`, or `set_status`. Actions from the catalog use `folderId`, `tagId`, or `userId`. `move_to_folder.folderId` and `add_local_tag.tagId` also accept an exact folder or tag name, and Mail saves it as the ID. A name that several folders or tags share needs the ID. The status is `needs_action`, `waiting`, or `done`.
- **Keywords:** The guided editor recommends local tags and no longer offers `add_keyword` for new steps. You can still edit existing definitions that contain it. CLI and advanced workflow callers can still use it for compatibility with the provider. A keyword accepts 1–100 characters and must use valid provider keyword syntax.
- **AI text and classification:** `ai_generate_text.instructions` accepts 1–4,000 characters, and `maxOutputChars` is 200–10,000. `ai_classify` and `ai_classify_many` accept 2–10 choices with names that are unique regardless of case. A choice name accepts 1–80 characters and its description 1–500. `ai_classify_many.maxChoices` is from 1 to the number of choices.
- **Event extraction:** `ai_extract_event` accepts 1–4,000 characters of instructions and an explicit IANA `timeZone`. Its structured output contains `ready`, the title, an optional description and location, start, end, and the all-day state. A missing or unclear title or time sets `ready: false`. The following event step then stops and does not invent an event.
- **Spaces steps:** `link_space_item.itemId` identifies one existing task or event with **Edit** access. `create_space_event` requires a `spaceId` with **Edit** access, an open `columnId`, and either explicit event data or an earlier `ai_extract_event` output through `sourceStepId`. The guided editor shows these IDs read-only. Use **Change item** or **Change destination** to choose another target with current **Edit** access.
- **Event data:** Explicit event data uses `title`, optional `description` and `location`, ISO `startsAt` and `endsAt`, and `allDay`. The created event includes a stable reference back to the Mail conversation.
- **Text steps:** `create_reply_draft`, `add_comment`, and `set_summary` use `body: { kind: custom, value: ... }` with 1–50,000 characters, or `body: { kind: step_output, sourceStepId: ... }` for an earlier AI step that produces text. A multi-choice result is not a text source. Reply drafts also require a `senderIdentityId` from the catalog.
- **Conditions:** An `if` condition refers to an earlier AI `sourceStepId`. Use `equals` for generated text or one classification. Use `includes` for a multi-classification. `value` accepts 1–500 characters and must name a declared choice for a classification. Both `then` and `else` contain at most 12 steps.
- **Size:** A definition contains 1–20 top-level steps, at most 40 steps across branches, at most 4 branch levels, and at most 10 AI calls.
- **One path:** One reachable path can contain only one provider message action, one assignment, one status change, and one summary replacement. It cannot add the same local tag twice. Consecutive `if` steps are on the same path, because both can match. Put actions that exclude each other in the `then` and `else` branches of one `if`. `set_status` is a local status change, not a provider message action, so it can share a path with `mark_read`.
:::

Mail generates canonical workflow YAML from the flow and shows it read-only in the editor. Steps run from top to bottom through the shared workflow runtime.

- **Several matching automations:** The oldest automation decides where the message goes. A later automation skips its move, trash, or junk step instead of failing. Its other steps still run.
- **Failed step:** If a later step fails, the effects of earlier completed steps stay.
- **Versions:** Editing the flow publishes a new unchangeable workflow version. Changing only the name or the active state does not duplicate identical source.
- **Protected targets:** Destructive actions cannot target an identity of the mailbox, a configured internal domain, its subdomains, or an unsafe parent domain.

Text conditions support exact, contains, starts-with, and ends-with matching. Regular expressions are unavailable on purpose until Mail can enforce a limited RE2-compatible matcher.

New incoming automations start inactive. A flow without AI steps can preview and process existing matching messages with a resumable backfill:

- One backfill hands at most 100 messages to the automation. If more messages match, it ends as **Limit reached** and shows how many are left. Run it again to continue with the next messages.
- A backfill survives restarts. Mail retries a failed message without stopping unrelated workflow runs.
- A repeated backfill skips messages already accepted for the same unchangeable version.
- **Completed** means that Mail handed every matching message to the automation. The actions themselves then run in the workflow runtime and appear under **Activity**.
- Progress counts only grow while a backfill runs. The automation menu shows the progress and lets you cancel the backfill or run it again.

A flow with an AI step processes only future messages. Mail checks the matching conditions before AI runs. The Safety section shows the maximum number of AI calls per matching message.

:::warning AI can classify or write incorrectly
Keep category descriptions precise and review the first runs under **Activity**.
:::

A generated text output has no effect until a later step uses it. Reply automation only creates drafts for human review and never sends them.

Spaces steps run with a delegation of the user who set up the automation, and that user can revoke it. Mail stores its token encrypted. It revokes the token when someone removes the last Spaces step or deletes the automation. Every run still checks the current Mail access and the current Spaces access. Linking updates an existing link or creates one, and event creation uses a durable idempotency key, so retries create no duplicate events. If someone revokes the delegated API key or removes the Space access, future runs fail instead of acting without that access.

Use `set_status: done` to complete a conversation. Use `needs_action` or `waiting` to open it again explicitly. A verified new incoming message already moves a completed conversation back to Needs action. A separate step that unmarks Done on incoming mail is therefore normally not needed.

For automation through `cld`, use `mail automation catalog` to find valid IDs. `mail automation create` and `mail automation update` accept the complete guided definition as JSON or YAML through `--definition-file` or `--definition-stdin`, including `scope` and the ordered `steps` tree. The CLI and the interface therefore behave the same, including output references and nested conditions. For an invalid definition, Mail names each affected field by its path, such as `scope.conditions.items`, with the reason.

Mail uses the platform workflow model automatically and offers no separate model choice. Use advanced **Workflows** only when the guided building blocks do not cover the task.

## Configure an automatic reply {icon="send"}

:::steps
1. Ask someone with **Manage** access to verify an identity and turn on **Automatic replies** for it. They do this in **Settings → Accounts & identities → Sending identities**.
2. Open **Automations → Automatic replies**.
3. Choose **Add automatic reply**.
4. Choose **Out of office**, **Office-hours acknowledgement**, **Reference acknowledgement**, or **Custom automatic reply**.
5. Review the sender, subject, body, schedule, repeat protection, and behavior outside active times.
6. Use **Preview** for Markdown content.
7. Choose **Save automatic reply**.
:::

Subjects and messages are Liquid templates. Use the variables that you can copy in the editor, for example `{{ inputs.message.subject }}`. After a reference is assigned, `{{ reference.value }}` is also available. Mail rejects invalid syntax and unavailable variables before it saves the reply.

Only one automatic reply can be on for a mailbox at a time. Turn off the active configuration before you turn on another one. By default, only people with **Manage** access can change automatic replies. They can allow people with **Edit** access in **Settings → Access → Automatic reply management access**.

Mail does not reply to messages that are unsafe for automatic responses. These include mailing-list mail, bulk mail, delivery status notifications, messages from the mailbox itself, and messages that explicitly suppress automatic replies. A suppressed reply stays part of the activity and run history. Mail does not silently turn it into a normal draft.

## Set dates and weekly hours {icon="point"}

Automatic replies and inline response windows in workflows use the same time rules:

- **Time zone** sets how Mail evaluates every date and time.
- **Active date ranges** limit the schedule to an absence or campaign. Without a range, weekly hours repeat without end.
- **Weekly hours** list every weekday separately. A checked weekday card is on. Turn on **All day** for `00:00–24:00`, or add one or more windows that do not overlap for that day. A card marked **Disabled** never sends a response.
- **Date exceptions** close one date or replace the normal hours of that date.
- **Do not reply** suppresses messages received outside an active window.
- **Reply at the next active time** keeps the response until the next active window.

An exception wins over the normal weekly hours. Times cannot cross midnight. Create one window before midnight and another one on the next day.

## Understand repeat protection {icon="shield-lock"}

**Repeat protection** is the minimum time before the same sender can receive another automatic reply from this mailbox.

- The **Out of office** preset uses 96 hours, or 4 days. A sender who writes several times during one absence therefore does not receive the same notice every day.
- **Office-hours acknowledgement** and **Custom automatic reply** use 24 hours.
- The shortest interval is 1 hour.
- Mail also replies to any incoming message at most once. It sends at most 100 automatic replies per hour for the whole mailbox. Mail suppresses anything beyond that and shows it in the activity history.

Choose a shorter interval only when repeated acknowledgements help the recipient. The value applies to the whole mailbox for that automatic reply. It is not a delay before the first response.

For a YAML workflow, define these rules directly under `automaticReply.schedule`. The schedule is part of the unchangeable workflow version. When you review and activate that version, you also review and activate its timing. See [Build Mail workflows](/app/mail/help/mail-workflows#send-a-guarded-automatic-reply) for the complete YAML shape.

## Create conversation references {icon="square-plus"}

A conversation reference is a permanent identifier for one conversation in the mailbox, such as `REF-K7M3-P9QX-2F4N`. People can quote, search, and audit one conversation with it, even when the subject changes.

:::steps
1. Open **Automations → Automatic replies** and choose **Reference acknowledgement**. For custom YAML, open **Workflows** instead.
2. If no reference format exists, set it up in the same reply editor. You can also use the reference panel on the Workflows page.
3. Enter a Liquid pattern with exactly one identifier output. The default that protects privacy is `REF-{{ short_id }}`.
4. Check the explanation of each placeholder and the preview in the editor.
5. Save the format. You stay in the reply and keep what you already entered.
6. Finish the automatic reply, or add `ensureConversationReference` to your custom workflow.
:::

Supported pattern parts:

- `{{ short_id }}` inserts a short, readable random ID. It does not reveal volume or allocation time.
- `{{ uuid }}` inserts an opaque random UUID.
- `{{ uuid_v7 }}` inserts a sortable UUID that reveals its allocation time.
- `{{ ulid }}` inserts a compact sortable ID that reveals its allocation time.
- `{{ sequence }}` inserts the mailbox's next number and therefore reveals order and approximate volume.
- `{{ sequence | pad_start: 6 }}` pads the counter to six digits. The width can be from 1 to 120.
- `{{ year }}`, `{{ month }}`, `{{ month_name }}`, and `{{ day }}` insert parts of the UTC allocation date.
- Letters, numbers, spaces, `.`, `_`, `-`, and `/` work as literal separators.

Use exactly one of the five identifier outputs. Date parts are optional and do not make a reference unique.

- **Same result on repeat:** Running the same action again returns the conversation's existing reference and allocates no new one.
- **Merges:** References stay attached as aliases after conversations are merged.
- **Turning allocation off:** Mail allocates no new references but does not change existing values.

The **Reference acknowledgement** preset assigns the reference before sending and inserts `{{ reference.value }}` into the message. Custom YAML offers the same result binding. Once a conversation has a reference, new reply subjects use `Re: [REF-K7M3-P9QX-2F4N] Original subject` by default. Mail still threads replies through the standard `Message-ID`, `In-Reply-To`, and `References` headers.

## Save and activate a workflow safely {icon="route"}

:::steps
1. Open **Automations → Workflows** and choose **New workflow**.
2. Enter the name, description, priority, and YAML, and set the limits under **Effect budget**.
3. Choose **Validate** and fix every diagnostic on its line.
4. Choose **Create workflow** or **Save version**.
5. Review the new version under **Versions**.
6. Choose **Activate** or **Activate current version**.
7. Check the first matching run under **Automations → Activity**. Platform operators can also use **Admin → Observability → Workflows**.
:::

Saving never activates a version. An active version keeps running until someone with **Manage** access explicitly activates the newer one. **Update available** means that the saved current version and the active version differ.

Effect budgets are hard upper limits for moves, sends, keyword changes, collaboration changes, and AI calls during one run. A run stops before it applies an effect that would exceed its budget. AI output stays data until a later Mail action uses it. Classification, tagging, assignment, drafting, and sending therefore stay steps that you can review separately.

## Observe and stop workflow runs {icon="activity"}

With **Manage** access, you use **Automations → Activity** for the automatic replies, incoming automations, custom workflows, and resumable backfills of the mailbox. The table shows the automation type, state, duration, time, and a short failure or result message. Cloud administrators keep the detail view across all apps under **Admin → Observability → Workflows**.

Choose **Cancel** when no further effects may start. Cancelling does not reverse mail moves, sends, or collaboration changes that already completed. A run that needs attention waits until a Cloud administrator records whether an uncertain external effect completed. Turning off a Mail workflow stops new trigger matches. It does not change completed history.

For the complete YAML vocabulary and checked examples, see [Mail workflow YAML reference](/app/mail/help/mail-workflows).
