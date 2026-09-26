# Mail compose and drafts

Read this reference when creating templates, editing shared drafts, handling attachments, or sending and scheduling mail. Start with [Mail CLI](mail.md) for mailbox setup, permissions, search, and collaboration.

## Compose templates and previews

Mail compose templates are either `signature` or `snippet` and either private to the current user or shared at mailbox scope. List, create, update, and archive them:

```bash
cld --json mail compose template list
cld --json mail compose template create \
  --kind snippet \
  --scope mailbox \
  --name "Meeting details" \
  --shortcut meeting \
  --body-file meeting.md
cld --json mail compose template update \
  <template-id> \
  --revision <revision> \
  --body-file meeting.md
cld mail compose template archive <template-id> --revision <revision> --yes
```

Template bodies use Markdown and Liquid. Presets are application behavior, not persisted template kinds.

Compose rendering needs the same editable draft context as the Mail composer. Store it as JSON so recipients, sending identity, subject, format, and body remain explicit:

```json
{
  "senderIdentityId": "<identity-id>",
  "to": [{ "name": null, "address": "recipient@example.com" }],
  "cc": [],
  "bcc": [],
  "subject": "Example",
  "body": "Hello",
  "format": "markdown"
}
```

Render one snippet, query rendered slash-command suggestions, or preview final HTML and plaintext:

```bash
cld --json mail compose snippet render <template-id> --draft-file draft.json
cld --json mail compose suggestions meet --draft-file draft.json
cld --json mail compose preview --draft-file draft.json
```

Pass `--conversation <conversation-id>` when the compose context belongs to an existing conversation. `compose suggestions` accepts an empty query when its optional positional argument is omitted.

Set or clear a personal default signature for an identity and manage the validated mailbox CSS:

```bash
cld --json mail compose signature list
cld --json mail compose signature default <identity-id> --scope private --template <template-id>
cld --json mail compose signature default <identity-id> --scope private
cld --json mail compose style get
cld --json mail compose style set --css-file mail.css
```

Mailbox administrators assign the mailbox default with `cld mail identity add --default-signature <template-id>` or `cld mail identity configure <identity-id> --default-signature <template-id>`. Clear it with `--clear-default-signature`. A personal default takes precedence.

The editable draft retains Liquid placeholders. Preview and delivery materialize the final identity-aware output. Defaults are inserted when a new draft is created; changing identity configuration later never rewrites an edited draft.

## Create and update shared drafts

Create or replace a revision-checked shared draft:

```bash
cld --json mail draft create \
  --identity <identity-id> \
  --to recipient@example.com \
  --subject "Draft subject" \
  --body-file body.md \
  --format markdown

cld --json mail draft update <draft-id> \
  --revision <current-revision> \
  --identity <identity-id> \
  --to recipient@example.com \
  --subject "Updated subject" \
  --body-file body.md \
  --format markdown
```

Use `--format plain` when the message must remain plaintext. Plain messages do not use the Markdown HTML rendering path.

List all active drafts, inspect one, or list only drafts attached to a conversation:

```bash
cld --json mail draft list
cld --json mail draft get <draft-id>
cld --json mail conversation drafts <conversation-id> --limit 20
```

Treat `draft get` as the authoritative state before a terminal edit. Another Mail tab or collaborator may have scheduled, sent, discarded, or revised the draft since the previous read. Draft writes remain revision-fenced and reject a draft that is no longer editable; fetch the current state instead of retrying stale content. The Mail browser UI receives realtime lifecycle updates, while the CLI deliberately re-reads durable state per command.

Draft intent is immutable. For a reply or forward, start from the conversation. Both commands use its latest message unless `--message` names another one, and the mailbox's verified default identity unless `--identity` names another one:

```bash
cld --json mail reply <conversation-id> --body-file body.md
cld --json mail reply <conversation-id> --all --message <message-id> --body-file body.md
cld --json mail forward <conversation-id> --to colleague@example.com --body "FYI"
```

`reply` takes the recipients from the source message and sets `Re:` on its subject. `forward` sets `Fwd:`, appends the original message below your text, and copies its attachments unless you pass `--no-attachments`. Both create a draft and print its ID; nothing is sent until you run `send`.

`draft create` covers new messages and every draft field:

```bash
cld --json mail draft create \
  --identity <identity-id> \
  --to recipient@example.com \
  --subject "Message subject" \
  --body-file body.md
```

Discarding a draft is explicit and revision-fenced:

```bash
cld mail draft discard <draft-id> --revision <current-revision> --yes
```

## Coordinate editors and recover conflicts

Draft leases are advisory coordination records exposed to both the Mail UI and CLI. Inspect or acquire a lease before a long interactive edit:

```bash
cld --json mail draft lease get <draft-id>
cld --json mail draft lease acquire <draft-id>
```

The acquire result includes a write-only lease token. Keep it out of logs. Extend and release only the lease represented by that token:

```bash
cld --json mail draft lease heartbeat <draft-id> --token <lease-token>
cld --json mail draft lease release <draft-id> --token <lease-token>
```

Use `--takeover` only after the current editor is known to be stale or the user explicitly chooses to replace the lease. A lease does not replace draft revision checks; every write still uses the expected current revision.

When concurrent edits produce a recovery copy, inspect it and restore it against the current draft revision:

```bash
cld --json mail draft recovery list <draft-id>
cld --json mail draft recovery restore \
  <draft-id> \
  <recovery-id> \
  --revision <current-revision>
```

Restoring creates a new current draft revision. It does not silently overwrite a concurrently changed revision.

## Manage draft attachments

Stream a local file into the draft at its current revision. Every completed attachment change increments the draft revision:

```bash
cld --json mail draft attachment add \
  <draft-id> \
  ./invoice.pdf \
  --revision <current-revision>
```

The command uses the resumable attachment protocol. If an upload is interrupted, list its durable upload record and resume with the returned upload id:

```bash
cld --json mail draft attachment upload list <draft-id>
cld --json mail draft attachment add \
  <draft-id> \
  ./invoice.pdf \
  --revision <current-revision> \
  --upload <upload-id>
```

Cancel an abandoned upload only with explicit confirmation:

```bash
cld mail draft attachment upload cancel <draft-id> <upload-id> --yes
```

Download or remove a completed draft attachment:

```bash
cld --json mail draft attachment download <draft-id> <attachment-id> --out invoice.pdf
cld --json mail draft attachment remove \
  <draft-id> \
  <attachment-id> \
  --revision <current-revision>
```

## Send a draft

`send` sends an existing draft at its current revision. Create the draft with `reply`, `forward`, or `draft create`, add files with `draft attachment add`, then send it and wait for the durable command to succeed:

```bash
cld --json mail draft create \
  --identity <identity-id> \
  --to recipient@example.com \
  --subject "Message subject" \
  --body-file body.md \
  --format markdown \
  --priority high \
  --delivery-receipt on \
  --read-receipt off
cld --json mail draft attachment add <draft-id> ./invoice.pdf --revision <current-revision>
cld --json mail send <draft-id> \
  --undo 0 \
  --idempotency-key support-message-42 \
  --wait \
  --timeout-seconds 180
```

Use a stable `--idempotency-key` whenever automation may retry the same send. Reusing a key with different content fails instead of sending a different message under the same operation.

`send` runs the same safety review as the Mail composer. When it reports warnings, read them and pass `--approve-safety` to approve exactly those warnings.

Priority and receipt flags are frozen into the draft and outbox snapshot. Delivery receipts require DSN support from the selected SMTP transport. Read receipts are only requests; recipients may ignore them. Received reports appear in conversation activity and should be treated as reported outcomes, not proof of human attention.

Replies and forwards created with `reply` and `forward` carry their source message, so Mail adds the correct `In-Reply-To` and `References` headers.

The default Undo Send window is 10 seconds. Set `--undo 0` for immediate submission. To exercise Undo Send, queue with an undo window and cancel the returned command before submission starts:

```bash
cld --json mail send <draft-id> --undo 60
cld --json mail command cancel <command-id>
```

## Schedule and cancel delivery

Schedule a send with an ISO timestamp that includes its UTC offset:

```bash
cld --json mail send <draft-id> --schedule 2026-10-01T08:00:00+02:00 --undo 0
```

Scheduled delivery is observable independently from the command journal:

```bash
cld --json mail scheduled list --limit 50
```

Canceling restores the message as a draft by default. Use `--discard` only when the user explicitly wants to delete that draft:

```bash
cld --json mail scheduled cancel <scheduled-send-id> --yes
cld --json mail scheduled cancel <scheduled-send-id> --discard --yes
```

After successful delivery, the item leaves the scheduled list and becomes normal sent mail.

## Inspect durable send commands

Inspect, wait for, or cancel command-journal entries:

```bash
cld --json mail command list
cld --json mail command get <command-id>
cld --json mail command wait <command-id> --timeout-seconds 180
cld --json mail command cancel <command-id>
```

Cancellation succeeds only while the command is still cancelable. Ambiguous provider outcomes become `needs_attention` rather than being blindly repeated.

## Command map

| Area | Commands |
| --- | --- |
| Templates | `compose template list|create|update|archive`, `compose snippet render`, `compose suggestions`, `compose preview` |
| Signatures and CSS | `compose signature list|default`, `compose style get|set` |
| Drafts | `draft list|get|create|update|discard`, `conversation drafts` |
| Coordination | `draft lease get|acquire|heartbeat|release`, `draft recovery list|restore` |
| Draft attachments | `draft attachment add|remove|download`, `draft attachment upload list|cancel` |
| Delivery | `send`, `scheduled list|cancel`, `command list|get|wait|cancel` |
