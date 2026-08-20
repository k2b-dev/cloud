# Mail

Use `cld mail` to configure Cloud mailboxes and operate mirrored provider mail through the same permission-checked APIs as the Mail app.

## Phishing protection

Read a message with its current explainable security assessment or report a suspicious incoming message:

```bash
cld mail message get <message-id> --mailbox <mailbox>
cld mail message report-phishing <message-id> --mailbox <mailbox> --yes
```

The report contains identifiers and security evidence, not a copied message body. Repeated reports update the same report.

Platform administrators can manage the same redacted report inbox and exact rules as **Administration > Mail > Security**:

```bash
cld mail admin security reports --status new
cld mail admin security report resolve <report-id> --status in_review --note "Checking with the sender"
cld mail admin security report resolve <report-id> --status confirmed

cld mail admin security rule list
cld mail admin security rule add suspicious.example --disposition deny --target sender_domain --note "Confirmed campaign"
cld mail admin security rule set <rule-id> --enabled off
cld mail admin security rule delete <rule-id> --yes

cld mail admin security identity list
cld mail admin security identity add "Squarespace" --domain squarespace.com --domain squarespace-mail.com
cld mail admin security identity delete <identity-id> --yes

cld mail admin security authentication show
cld mail admin security authentication set --server mx.example.org
```

Domain rules include subdomains. Trust rules support sender addresses and sender domains only. They suppress heuristic warnings only when a trusted receiving mail server also reports successful sender authentication. An explicit block always wins.

Start here for mailbox setup, search, and collaboration. Continue with:

- [Mail compose and drafts](mail-compose.md) for templates, signatures, shared drafts, attachments, immediate or scheduled delivery, and durable send commands.
- [Mail automation](mail-automation.md) for managed automatic replies, conversation references, workflow YAML, immutable versions, and central run operations.
- [Mail operations](mail-operations.md) for provider credential lifecycle, folder discovery, repairs, operator actions, storage observability, and provider-backed message changes.

## Safety

- Run `cld mail help` and confirm that the Mail module is available before changing a mailbox.
- Use `--json` when a later command needs an id, revision, token, or cursor.
- Pass provider credentials with `--secret-stdin` or `--secret-file`. Credentials are write-only and are never returned by the API.
- Read a message and its folder ids before changing provider state, moving, copying, or deleting it.
- Public Mail resource ids are case-sensitive, exactly six ASCII letters or digits, and must be passed through unchanged. This applies to mailboxes, folders, conversations, messages, attachments, drafts and draft attachments, sender identities, tags, comments, reminders, scheduled deliveries, saved views, compose templates, incoming automations, and automatic replies. Legacy UUID resource ids are rejected; an exact mailbox name remains valid where a command documents `<mailbox-id-or-name>`.
- Treat technical command, provider, workflow, operation, cursor, and token ids as opaque. Do not derive or shorten them.
- `sync`, `rediscover`, `repair`, sends, and provider mutations create durable commands. A successful request proves that work was accepted, not that every remote effect has finished. Use the corresponding wait or status command.
- Do not delete remote messages, revoke credentials, revoke access, cancel another user's work, or delete mailbox resources without an explicit request.

Commands use the mailbox selected by `cld mail use` unless `--mailbox` or a mailbox argument is provided. Prefer an explicit mailbox in unattended scripts.

## Select and configure a mailbox

List accessible mailboxes, inspect one, create a mailbox, and select a default:

```bash
cld --json mail list
cld --json mail mailbox get <mailbox-id-or-name>
cld --json mail create "Support"
cld mail use <mailbox-id>
cld --json mail current
```

Update user-visible settings and the search backend:

```bash
cld mail configure \
  --mailbox <mailbox-id> \
  --name "Support" \
  --description "Shared customer support mailbox" \
  --search-backend auto
```

Mailbox admins can delegate guided automatic-reply management to writers without granting access to providers, identity configuration, reference settings, or YAML workflows:

```bash
cld mail configure --mailbox <mailbox-id> --automatic-replies writers
cld mail configure --mailbox <mailbox-id> --automatic-replies admins
```

Pause or resume provider synchronization explicitly:

```bash
cld mail configure --mailbox <mailbox-id> --sync disabled
cld mail configure --mailbox <mailbox-id> --sync enabled
```

Mailbox deletion is reversible. It retains the Cloud mirror and never deletes provider mail. A restored mailbox remains paused until an admin verifies diagnostics and explicitly enables synchronization again.

```bash
cld mail delete <mailbox-id> --yes
cld --json mail mailbox deleted list
cld --json mail mailbox deleted get <mailbox-id>
cld mail mailbox restore <mailbox-id> --yes
cld --json mail status --mailbox <mailbox-id>
cld mail rediscover --mailbox <mailbox-id> --wait
cld mail configure --mailbox <mailbox-id> --sync enabled
```

## Share a mailbox

Mailbox access uses the same direct permission model as the Mail settings UI:

- `read` can read mail and participate in collaboration, including internal comments.
- `write` can also change and send mail.
- `admin` can configure the mailbox, providers, access, references, and workflows.

Search users and groups before creating a grant:

```bash
cld --json mail access search-principals "Ada" --kind user,group
cld --json mail access list <mailbox-id>
```

Grant direct access, idempotently create or update it, or revoke one direct grant:

```bash
cld --json mail access grant <mailbox-id> --user ada@example.org --permission write
cld --json mail access set <mailbox-id> --group "Support Team" --permission read
cld --json mail access set <mailbox-id> --access-id <access-id> --permission admin
cld mail access revoke <mailbox-id> --access-id <access-id> --yes
```

Use exactly one of `--user`, `--group`, `--authenticated`, or `--access-id` where supported. `access grant` fails when a direct grant already exists; `access set` is the agent-friendly idempotent command. Effective access can also come from group membership or authenticated-user access, so revoking one direct entry does not necessarily remove every effective permission.

## Connect a provider and identity

Store and verify a generic IMAP/SMTP connection. Supply the password through stdin; never place it in command arguments:

```bash
cld --json mail provider add \
  --name "Support provider" \
  --email support@example.com \
  --username support@example.com \
  --imap-host imap.example.com \
  --imap-port 993 \
  --imap-tls implicit \
  --smtp-host smtp.example.com \
  --smtp-port 587 \
  --smtp-tls starttls \
  --secret-stdin
```

Browser OAuth for configured Google and Microsoft providers starts in **Mail > Settings > Connections** because the callback is bound to an authenticated browser session and an HttpOnly nonce cookie. The CLI keeps manual credentials as the generic fallback. Use `provider discover` to see whether browser OAuth is available and `provider list` to inspect state without exposing tokens.

Inspect the provider limits cached during verification, or refresh them
explicitly:

```bash
cld --json mail provider limits
cld --json mail provider limits refresh <connection-id>
```

The SMTP value applies to the complete encoded message, not only to its raw
attachments. Servers that do not advertise limits are reported as
`unsupported` or `unavailable`; Mail does not substitute a guessed value.

Attach the returned mailbox-owned connection, wait for discovery, and inspect the folders:

```bash
cld --json mail binding attach <connection-id>
cld --json mail binding list
cld --json mail mailbox wait --health active --timeout-seconds 300
cld --json mail folders
```

For a normal mailbox, create and verify the provider address as the default identity in one idempotent step. Verification submits a real message to the provider address:

```bash
cld --json mail identity setup-default <binding-id> --label "Support mailbox" --name "Support"
cld --json mail identity list
```

Pass `--provider-saves-sent` only when the provider stores SMTP submissions in Sent itself. Otherwise Cloud resolves the configured Sent role and appends the sent copy through IMAP.

Use the manual identity lifecycle only for aliases, delegated senders, or other advanced cases:

```bash
cld --json mail identity add \
  --label "Support desk" \
  --address support@example.com \
  --name "Support" \
  --default-cc archive@example.com \
  --default-bcc compliance@example.com \
  --format markdown \
  --priority normal \
  --delivery-receipt off \
  --read-receipt off \
  --default-signature <template-id> \
  --default
cld --json mail identity verify <identity-id> <binding-id> --recipient support@example.com
cld --json mail identity configure \
  <identity-id> \
  --label "University support" \
  --reply-to helpdesk@example.com \
  --default-cc teamlead@example.com
cld --json mail identity configure <identity-id> --vcard-file ./support.vcf
cld --json mail identity list
cld --json mail identity disable <identity-id> --yes
```

The identity label is internal. Recipients see the display name and From address. Multiple identities may use the same From address while keeping separate Reply-to, default Cc/Bcc, format, priority, receipt requests, contact card, signature, transport, folder mappings, and verification. Recipient defaults apply only when a person creates a draft; workflows and automatic replies keep their recipients explicit. `--clear-vcard`, `--clear-default-bcc`, and the other `--clear-*` flags remove optional defaults.

An identity normally uses the mailbox SMTP connection. Configure a separate verified SMTP server only when that identity must submit through another account:

```bash
cld --json mail identity transport set <identity-id> \
  --host smtp.example.com \
  --port 587 \
  --tls starttls \
  --username support@example.com \
  --secret-stdin
cld --json mail identity transport remove <identity-id> --yes
```

Credentials are encrypted and never returned by the API or CLI. The command reads the current transport revision and fails on a concurrent change instead of overwriting it. A queued send remains pinned to the verified transport revision it selected.

Read [Mail operations](mail-operations.md) before replacing or revoking credentials, repairing projections, or changing remote folders.

## Read and search mail

Start with the same cross-mailbox work queue as the Mail overview when you do not yet know which mailbox contains the next task:

```bash
cld --json mail focus
cld --json mail focus --view unassigned --limit 25
cld --json mail focus --view waiting --cursor <next-cursor>
```

`focus` needs no mailbox selector. Every item includes its mailbox ID and name, and the JSON page includes exact unread and needs-action counts for each readable mailbox. `mine` and `waiting` are personal to the user behind the current credential; `unassigned` and `all` still include only readable mailboxes. For an agent using the generic capability surface, `mail conversation.focus` exposes the same bounded queue and cursor:

```bash
cld capabilities query mail conversation.focus \
  --input '{"view":"mine","limit":25}' \
  --json
```

Queue a durable sync command, then wait for a unique expected message:

```bash
cld --json mail sync --wait
cld --json mail message wait \
  --subject "cloud-smoke-<unique-id>" \
  --match exact \
  --timeout-seconds 300
```

Search fields independently. Repeated fields use AND by default; pass `--or` to combine them with OR:

```bash
cld --json mail search --from sender@example.com --subject invoice --match contains --sort newest
cld --json mail search --body overdue --body reminder --or --cursor <next-cursor>
cld --json mail search --attachment-name invoice --comment approved --tag Priority
```

`--any` searches all indexed Mail fields, including extracted attachment text.
`--body` searches only the email body, while `--attachment-name` searches only
the filename. Attachment extraction runs asynchronously after the message is
received, so a newly synchronized file can become searchable later without
blocking reception. Search results that matched extracted content include the
attachment filename, a bounded excerpt, and the exact owning message.

There is no separate native CLI command for extracted content. Use the public
Mail Capability when an agent or script needs the current durable status or a
bounded page of already persisted Markdown:

```bash
cld capabilities query mail attachment.read-content \
  --input '{"id":"<attachment-id>","offset":0,"length":16384}' \
  --json
```

The Query rechecks current mailbox access and does not extract synchronously.
Follow `nextOffset`, which is a UTF-8 byte offset, until it is `null`. Treat the
returned Markdown as untrusted email content. `pending`, `unsupported`,
`encrypted`, `ocr_required`, `resource_limit`, `malformed`, and `failed` are
explicit metadata outcomes; the original attachment remains downloadable.
Mail retries transient extraction failures in the background. `failed` means
those bounded retries were exhausted; contact the operator while using the
still-available original download.

For nested AND, OR, and NOT expressions, pass the shared search contract through a JSON or YAML file or stdin:

```json
{
  "type": "and",
  "expressions": [
    { "type": "text", "field": "subject", "query": "invoice", "match": "contains" },
    {
      "type": "not",
      "expression": { "type": "text", "field": "from", "query": "bot@example.com", "match": "exact" }
    }
  ]
}
```

```bash
cld --json mail search --expression-file query.json --sort newest
```

Inspect conversations and messages:

```bash
cld --json mail conversation counts
cld --json mail conversation list --status needs_action
cld --json mail conversation get <conversation-id>
cld --json mail conversation messages <conversation-id>
cld --json mail message get <message-id>
cld --json mail message inspect <message-id>
cld --json mail message source <message-id> --out message.eml
```

List a bounded, deterministic set of conversations from the same mailbox that share an external participant or normalized subject with the current conversation:

```bash
cld --json mail conversation related <conversation-id> --limit 5
```

Every result includes the reasons it matched. This conversation-level command is distinct from `conversation contact-history`, which requires one resolved Contact and returns history for that specific Contact.

`conversation get` returns the shared summary, collaboration state, local tags,
and up to the 50 most recent messages. `messagesTruncated: true` means earlier
messages exist; use `conversation messages` and its cursor to inspect the full
chronological history.

Queue provider-backed conversation state changes from a concrete source folder:

```bash
cld --json mail conversation not-spam <conversation-id> --source <junk-folder-id> --wait
cld --json mail conversation keyword add <conversation-id> FollowUp --source <folder-id> --wait
cld --json mail conversation keyword remove <conversation-id> FollowUp --source <folder-id> --wait
```

Provider keywords are distinct from Cloud-local tags. The command reports a clear provider error if the selected IMAP folder does not permit custom keywords.

`search`, `conversation list`, activities, saved views, scheduled sends, and deleted-mailbox listings are cursor-paginated. Preserve and pass the returned cursor rather than reconstructing it.

Create a reviewable independent draft from an existing message, or prepare a resend of an outbound message:

```bash
cld --json mail message edit-as-new <message-id> --idempotency-key edit-message-42
cld --json mail message resend <message-id> --idempotency-key resend-message-42
```

Both copy eligible attachments by default and never send immediately. Inspect the returned draft before delivery.

Remote images stay blocked unless the user allows their sender or domain. Manage only the signed-in user's mailbox preference:

```bash
cld --json mail remote-content list
cld --json mail remote-content allow-sender sender@example.com
cld --json mail remote-content allow-domain example.com
cld mail remote-content remove <rule-id> --yes
```

## Work with Spaces calendar invitations

Mail detects iCalendar attachments, while Spaces remains the owner of events and invitation state. Inspect writable destinations and the optional mailbox default without importing anything:

```bash
cld --json mail calendar destinations --mailbox <mailbox-id>
cld mail calendar default --mailbox <mailbox-id> --space <space-id>
cld mail calendar default --mailbox <mailbox-id> --clear
```

Preview and explicitly import one message invitation. `calendar import` updates the linked event only for a newer sequence and is safe to repeat:

```bash
cld --json mail calendar preview <message-id> --mailbox <mailbox-id>
cld --json mail calendar import <message-id> --mailbox <mailbox-id> --space <space-id>
```

Prepare an editable response draft only after the invitation is linked in Spaces. Supply a stable retry key in unattended work so a retry cannot create a second draft:

```bash
cld --json mail calendar respond <message-id> \
  --mailbox <mailbox-id> \
  --status accepted \
  --idempotency-key 57f87971-ef19-4e2f-ad25-4263fa94808a
```

The command creates a Mail draft; it does not claim that the organizer was notified. Review and send that draft through the normal compose or draft commands.

## Manage mailing lists

List mailing lists detected from standard message headers, then inspect one canonical List-ID:

```bash
cld --json mail subscription list --mailbox <mailbox-id>
cld --json mail subscription get news.example.org --mailbox <mailbox-id>
```

`subscription unsubscribe` sends a request only when the list advertises RFC 8058 one-click unsubscribe. Web and email unsubscribe methods are returned for a person or agent to open explicitly; the CLI does not visit them automatically.

```bash
cld --json mail subscription unsubscribe news.example.org \
  --mailbox <mailbox-id> \
  --yes
```

After an unsubscribe request, archive or trash up to 500 synchronized messages from the same List-ID through the normal durable provider command pipeline:

```bash
cld --json mail subscription dispose news.example.org \
  --mailbox <mailbox-id> \
  --destination archive \
  --yes
```

If `truncated` is true, wait for the queued commands to finish and repeat the command. Unsubscribing does not delete existing mail, and moving existing messages does not unsubscribe.

## Collaborate on conversations

Inspect assignable users and update durable collaboration state with optimistic revisions:

```bash
cld --json mail conversation users
cld --json mail conversation collaboration <conversation-id>
cld --json mail conversation update \
  <conversation-id> \
  --revision <revision> \
  --assignee <user-id> \
  --done
cld --json mail conversation activity <conversation-id>
```

People can mark a conversation with `--done` or clear Done with `--reopen`. Mail derives `needs_action` and `waiting` from verified mail flow: incoming mail needs action, while a confirmed human reply waits for someone else. Automatic or ambiguous mail does not invent a next step. Done and reopen clear an active snooze, so change completion and snooze in separate commands.

Resolve permission-scoped Contacts from server-derived conversation participants:

```bash
cld --json mail conversation context <conversation-id>
cld --json mail conversation contact-history <conversation-id> <book-id-or-system> <contact-id>
```

Create and manage Cloud-local tags independently from provider keywords:

```bash
cld --json mail tag create "Priority"
cld --json mail tag list
cld --json mail tag rename <tag-id> "Urgent" --revision <tag-revision>
cld --json mail conversation tag set <conversation-id> --revision <conversation-revision> --tag <tag-id>
cld --json mail conversation tag add \
  --conversation <conversation-id> \
  --conversation <second-conversation-id> \
  --tag <tag-id>
cld --json mail conversation tag list <conversation-id>
cld --json mail tag delete <tag-id> --revision <tag-revision> --yes
```

`conversation tag set` replaces the complete tag set for one revision-fenced conversation. `conversation tag add` is an idempotent additive bulk operation for up to 50 conversations and 50 tags; existing assignments remain unchanged.

List, add, edit, or tombstone internal Markdown comments:

```bash
cld --json mail comment list <conversation-id>
cld --json mail comment add <conversation-id> --body-file note.md --message <message-id>
cld --json mail comment edit <conversation-id> <comment-id> --revision <revision> --body-file note.md
cld --json mail comment delete <conversation-id> <comment-id> --revision <revision> --yes
```

Personal reminders are revisioned. Omit `--revision` only when creating the first reminder:

```bash
cld --json mail reminder get <conversation-id>
cld --json mail reminder set <conversation-id> --due <ISO-timestamp>
cld --json mail reminder set <conversation-id> --due <ISO-timestamp> --revision <revision>
cld --json mail reminder cancel <conversation-id> --revision <revision>
```

## Save filtered views

Saved-view filters use the same bounded collaboration filter contract as the Mail app. Pass JSON or YAML through a file or stdin:

```bash
cld --json mail saved-view create "My action queue" --scope private --filter-file filter.yml
cld --json mail saved-view list
cld --json mail saved-view get <view-id>
cld --json mail saved-view conversations <view-id>
cld --json mail saved-view update <view-id> --revision <revision> --name "Priority queue"
cld --json mail saved-view delete <view-id> --revision <revision> --yes
```

## Repair conversation membership

Thread repair is revisioned, audited, and requires confirmation:

```bash
cld --json mail conversation split \
  <conversation-id> \
  --revision <revision> \
  --message <message-id> \
  --yes

cld --json mail conversation merge \
  <target-id> \
  <source-id> \
  --target-revision <revision> \
  --source-revision <revision> \
  --yes

cld --json mail conversation reassign-message \
  <source-conversation-id> \
  <message-id> \
  <target-conversation-id> \
  --source-revision <revision> \
  --target-revision <revision> \
  --reason "Incorrect thread" \
  --yes
```

Use `split` when selected messages should form a new pinned conversation, `merge` when complete conversations belong together, and `reassign-message` when one message belongs in an existing target conversation.

## Command map

Use `cld mail <group> help` for all flags. The durable day-to-day surface is:

| Area | Commands |
| --- | --- |
| Mailboxes | `list`, `create`, `use`, `current`, `mailbox get`, `mailbox deleted list|get`, `mailbox restore`, `mailbox wait`, `configure`, `delete` |
| Access | `access list|search-principals|grant|set|revoke` |
| Discovery | `provider discover|list`, `binding list|attach`, `identity list|add|setup-default|configure|verify|disable`, `folders`, `status` |
| Read and search | `focus`, `search`, `message get|wait|inspect|source|edit-as-new|resend`, `conversation list|get|messages|counts`, `remote-content list|allow-sender|allow-domain|remove` |
| Collaboration | `conversation collaboration|update|users|activity|context|related|contact-history`, `tag ...`, `conversation tag ...`, `comment list|add|edit|delete`, `reminder get|set|cancel` |
| Views and repair | `saved-view list|get|create|update|delete|conversations`, `conversation split|merge|reassign-message` |

Provider-backed read, unread, flag, folder, attachment, and maintenance commands are documented in [Mail operations](mail-operations.md). Compose, draft, scheduling, and command-journal operations are documented in [Mail compose and drafts](mail-compose.md).

Live presence and cursor-based WebSocket invalidation are browser transport concerns rather than durable CLI operations. Shared draft leases, recovery copies, and resumable uploads are durable CLI capabilities and are documented in [Mail compose and drafts](mail-compose.md).
