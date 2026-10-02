# Mail operations

Read this reference for provider credential lifecycle, discovery, synchronization, repair, remote message changes, attachment delivery, and platform observability. Start with [Mail CLI](index.md) for normal mailbox setup and collaboration.

## Inspect mailbox health

Inspect aggregate backend state, including bindings, discovery generations, folder coverage, sync runs, hydration, commands, outbox, and search health:

```bash
cld --json mail status
cld --json mail mailbox wait --health active --timeout-seconds 300
```

`mailbox wait` stops early when the mailbox enters an incompatible failure health. A healthy command result does not replace checking the relevant durable command or sync run. `mail status` reports `degraded` with the failed count while any message hydration has failed, even when the provider transport itself is active.

Mailbox admins can inspect the redacted operator view:

```bash
cld --json mail operator status
```

Cloud super administrators can inspect all active mailboxes:

```bash
cld --json mail admin operations
```

These views intentionally omit provider secrets and message content.

## Recover mailbox access as a Cloud administrator

Cloud administrators can discover and inspect active mailboxes without first
having mailbox access. Use an id when a mailbox name is not unique:

```bash
cld --json mail admin mailbox list --query "Support" --limit 50
cld --json mail admin mailbox list --cursor <next-cursor> --limit 50
cld --json mail admin mailbox get <mailbox-id>
```

`admin mailbox list` accepts a limit from 1 to 100 and returns the server's
opaque next cursor in structured output. `admin mailbox get` returns one
redacted operations record. Neither command exposes provider secrets, messages,
attachments, or implicit mailbox-content access.

Inspect direct grants and resolve a user, group, or service account before
changing access:

```bash
cld --json mail admin mailbox access list <mailbox-id> --include-service-accounts
cld --json mail admin mailbox access search-principals "Support" --kind user,group,service_account
cld --json mail admin mailbox access grant <mailbox-id> --user person@example.com --permission admin
cld --json mail admin mailbox access set <mailbox-id> --group "Support Team" --permission write
cld --json mail admin mailbox access set <mailbox-id> --access-id <access-id> --permission admin
cld mail admin mailbox access revoke <mailbox-id> --access-id <access-id> --yes
```

Permissions are `read`, `write`, and `admin`. `grant` creates a new direct
entry and fails if that principal already has one. `set` is idempotent: with an
access id it updates that entry; with exactly one `--user`, `--group`, or
`--service-account` it resolves the principal and creates or updates the direct
grant. `revoke` requires `--yes` and removes only the selected direct entry;
inherited access can still remain. Add a replacement administrator before
removing the last mailbox administrator.

## Choose the contact directory

Mail uses the built-in Contacts app for recipient suggestions and participant
contacts unless a Cloud administrator chooses another app. These commands use
the same server validation as **Administration > Mail > Contact directory**:

```bash
cld --json mail admin contact-directory show
cld --json mail admin contact-directory candidates --app crm
cld mail admin contact-directory set --app crm --suggest customer.suggest --resolve customer.match --no-read --no-books --no-create --yes
cld mail admin contact-directory reset --yes
```

`show` returns the stored mapping, the app name, whether it equals the Contacts
defaults, and `issues` that currently disable Mail features. `candidates`
lists the app's capabilities that are compatible with each function (`suggest`,
`resolve`, `read`, `listWritableBooks`, `create`).

`set` requires `--app` and `--yes`. With the current app, unset functions keep
their capability. With a new app, they start from the same proposal as the
dialog: the Contacts default ID when compatible, otherwise the only compatible
capability. `--no-read`, `--no-books`, and `--no-create` leave a function
unmapped; `--books` and `--create` work only together. Mail stores nothing
when a mapping is incompatible: the command exits with status 1 and prints each
field's issue, or the `{message, code, issues}` error body under `--json`.
`reset` restores the Contacts defaults and is validated the same way.

## Discover, replace, and revoke providers

Discover likely settings and inspect write-only provider records:

```bash
cld --json mail provider discover support@example.com
cld --json mail provider list
cld --json mail provider limits
cld --json mail binding list
```

`provider limits` shows the last mailbox quota reported through IMAP and the
maximum outgoing message size advertised through SMTP. Refresh one connection
when the cached observation is outdated:

```bash
cld --json mail provider limits refresh <connection-id>
```

These limits are optional provider capabilities. `unsupported` means the server
does not advertise the capability; `unavailable` means Mail could not obtain a
reliable value. Mail never invents a limit and does not block delivery from an
unknown or outdated observation.

Replace an existing credential atomically through stdin or a file:

```bash
cld --json mail provider replace <connection-id> \
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

Replacement requires every affected binding to be verified again:

```bash
cld --json mail binding verify <binding-id> --wait --timeout-seconds 300
```

Revoking a provider credential destroys the secret and revokes its bindings. It does not delete provider mail or mirrored Cloud data:

```bash
cld mail provider revoke <connection-id> --yes
```

Do not revoke credentials merely to pause synchronization. Use `cld mail configure --sync disabled`.

## Rediscover and synchronize

Rediscover namespaces, subscriptions, special-use roles, and effective folder rights for every active binding or one binding:

```bash
cld --json mail rediscover --wait --timeout-seconds 300
cld --json mail rediscover --binding <binding-id> --wait --timeout-seconds 300
```

Each attempt to rediscover or verify one binding, including provider verification, has five minutes to finish. The limit starts when a worker begins that binding, and a whole-mailbox rediscovery checks its bindings one after another, so a `--wait` of 300 seconds can expire first while the command keeps running. Mail cancels a longer attempt and releases the remote mailbox, so rediscovery of other mailboxes continues. An `active` or `degraded` binding becomes `degraded`, and `cld --json mail binding list` shows `Provider rediscovery did not finish within 300 seconds and was cancelled` as its `lastError`; a `pending` binding stays `pending`. The `mail rediscover` or `mail binding verify` command fails with the same message, and `mail operator status` lists it with the error code `PROVIDER_REDISCOVERY_TIMEOUT`. Background rediscovery retries the binding with backoff; the next successful attempt makes it active again. Repeated timeouts indicate a provider that accepts connections but does not complete verification or folder discovery. Discovery also checks the rights of each selectable folder with its own request, so an account with very many folders on a slow server can reach the limit on every attempt.

Queue a whole-mailbox sync or one canonical folder:

```bash
cld --json mail sync --wait --timeout-seconds 300
cld --json mail sync folder <folder-id> --wait --timeout-seconds 300
```

`--wait` waits until the request is handled, not until the provider sync finishes. A queued request prints `queued`; under `--json`, `result.queued` is `true` for a folder and `result.queuedFolders` counts the folders of a mailbox. `mail status` shows when a sync last completed (`sync.lastAt` under `--json`). When the mailbox cannot synchronize yet, the command still ends `confirmed` but queues nothing: it prints `not queued` with the reason, and `--json` sets `result.queued` to `false` or `result.queuedFolders` to `0` together with `result.reason`, for example `Mailbox transport is paused` or `Mailbox transport is unavailable: Provider credentials changed; verify the remote resource again`. Resume synchronization, reconnect the account, or verify the binding again before you retry.

A sync imports message envelopes; Mail fetches the bodies afterwards, newest first, in batches of up to 20 messages from one folder. Mailboxes take turns: a mailbox with missing bodies holds one place in the shared body queue and returns to its end after each batch. A large first synchronization in one mailbox therefore delays new mail in another mailbox by at most one batch, not by its whole backlog. The mailbox's own provider work comes first, as described below. A batch that fails at the provider, for example on a lost connection, is not retried on its own; the mailbox's next sync that imports mail, or the scheduler within a minute, queues it again.

Mail does one provider operation at a time per provider mailbox. When several wait, folder syncs and folder rediscovery go first, then commands such as moves and flag changes, sends, and draft saves, and then background work: body downloads, draft imports, and sync batches that only continue importing older mail or recheck the folder's existing messages. A folder sync that still has new mail or flag changes to fetch stays a folder sync. A waiting operation keeps its place in line and lets work of a higher priority that starts waiting after it go first for at most 30 seconds per step, 60 seconds for background work behind folder syncs; then it is next. An operation that finishes and asks again lines up anew, so a command backlog or a long first synchronization cannot keep the provider to itself. Bodies that an automation waits for rank with commands. Waiting operations try again within five seconds; one that comes back late, for example because its queue is busy, is passed over until it is back and keeps its place. New mail therefore arrives with the next folder sync even while a bulk move of hundreds of messages is still running, and the move continues after the sync. A sync you queue by hand, or that the schedule or a new-mail notification queues, ranks as a folder sync, also for a folder that is still importing older mail: it joins that import, whose next batch checks for new mail first.

Commands of one mailbox run one at a time, in the order they were created; a command that waits for a retry lets the next ones go first. Each Mail process runs the commands of up to four mailboxes at the same time, so a long backlog in one mailbox does not hold back another mailbox's commands. Sends have their own queue.

Each body has a retry budget of five attempts. A body whose fetch failed waits until the mailbox has no other missing bodies and is then retried about once a minute. When the provider answers a fetch without the message source, Mail uses one attempt and queues a reconciliation of the message's folder, which removes the message if the provider deleted it. A message that the provider keeps listing without a source uses up its budget and fails with the error code `MESSAGE_SOURCE_MISSING` instead of holding back the mailbox's other bodies.

A failed sync whose binding and credentials stay valid, such as a provider connection timeout, makes the mailbox `degraded` with the provider's message as its reason. Background sync and IMAP push keep running for that mailbox, and the next sync that completes, including one you queue, makes it active again without waiting for rediscovery. Authentication failures do not take this path: Mail rechecks the binding through rediscovery, and the account may need to be reconnected.

IMAP push keeps one IDLE connection per binding and holds NATS leases for it with a 60-second lifetime, renewed every 20 seconds. When NATS does not answer a renewal, for example during a short broker stall, Mail retries with backoff and keeps the connection open. It logs `IMAP push lease renewal recovered` once a renewal succeeds again. If no renewal succeeds within 50 seconds of the last one, or NATS answers that the lease could not be extended, for example because another process holds it, Mail closes the connection and logs `IMAP push listener stopped unexpectedly` with the code `IMAP_PUSH_LEASE_LOST`. The listener then restarts within about 15 seconds. A listener that is reconnecting during such a stall cannot take its leases and stops with `IMAP_PUSH_FAILED` and a NATS timeout in `error`; it restarts the same way. The log entry names the lease (`leader`, `permit`, or a scope such as `permit:mailbox`), the `reason` (`rejected` or `expired`), the time since the last successful renewal in `sinceLastExtensionMs`, and the last error. Other failures use the provider's code, or `IMAP_PUSH_FAILED` together with the provider's original code in `originalCode` and its message in `error`. A slow database delays only the listener's health record, not its lease renewals. New mail is not lost while a listener restarts: background sync still picks it up.

Use `--idempotency-key` when an external script may retry the same maintenance request.

## Repair projections

Rebuild a folder only after a confirmed `UIDVALIDITY` or remote identity change. The command retains message content but invalidates stale remote placements before resynchronizing:

```bash
cld --json mail repair folder <folder-id> --yes --wait --timeout-seconds 300
```

Retry messages whose body or attachment hydration exhausted its normal retry budget:

```bash
cld --json mail repair hydration --wait --timeout-seconds 300
```

Maintenance commands require mailbox `admin`. A folder repair is not a routine refresh; use normal sync for ordinary new mail.

## Run explicit operator actions

`operator run` exposes bounded durable actions without bypassing normal permission or idempotency checks:

```bash
cld --json mail operator run sync --wait
cld --json mail operator run rediscover --binding <binding-id> --wait
cld --json mail operator run hydrate --wait
cld --json mail operator run rebuild-search --wait
cld --json mail operator run rebuild-threads --wait
cld --json mail operator run sync-folder --folder <folder-id> --wait
cld --json mail operator run rebuild-folder --folder <folder-id> --wait
cld --json mail operator run reconcile --command <command-id> --wait
cld --json mail operator run retry --command <command-id> --wait
cld --json mail operator run cancel --command <command-id> --wait
```

Use rebuild actions only after diagnostics show the corresponding projection is incomplete. `rebuild-threads` also removes copies of Mail's own drafts that an earlier synchronization imported as messages, for example from Gmail's All Mail. `reconcile`, `retry`, and `cancel` require the target durable command id.

## Observe storage

Cloud super administrators can inspect the last completed storage snapshot and queue a fresh reconciliation:

```bash
cld --json mail admin storage show
cld --json mail admin storage reconcile
```

Reconciliation runs asynchronously. `storage show` continues returning the previous completed snapshot until the new one finishes. The report separates mirrored messages, draft attachments, shared-link bytes, physical relation size, and physical blob size.

## Manage provider folders

Create, subscribe, rename, and safely delete empty provider folders. Every provider command is durable and rediscovery updates the canonical projection before confirmation:

```bash
cld --json mail folder create "Cloud Review" --wait
cld --json mail folder create "2026" --parent <folder-id> --wait
cld --json mail folder create "Provider only" --hide-in-sidebar --no-subscribe --wait
cld --json mail folder unsubscribe <folder-id> --wait
cld --json mail folder subscribe <folder-id> --wait
cld --json mail folder rename <folder-id> "Cloud Reviewed" --wait
cld --json mail folder delete <folder-id> --yes --wait
```

Cloud sidebar visibility is a local mailbox setting. It does not subscribe, unsubscribe, delete, or stop synchronizing the provider folder:

```bash
cld --json mail folder hide <folder-id>
cld --json mail folder show <folder-id>
```

Use `cld --json mail folders` to inspect the canonical hierarchy, discovery state, provider subscription, and sidebar state. Shared or other-user folders remain part of this connected account. Commands fail closed when the current provider rights do not permit a requested create, rename, or delete.

For providers with missing or ambiguous special-use metadata, map a semantic role without renaming the provider folder:

```bash
cld --json mail folder role set archive <folder-id>
cld --json mail folder role clear archive
```

Supported roles are `sent`, `drafts`, `trash`, `archive`, and `junk`. Role changes affect how later Mail operations resolve semantic destinations.

Gmail has no `\Archive` folder. When a Gmail mailbox has no archive folder and no mapping, conversation archive moves the messages out of the source folder to `[Gmail]/All Mail` (`\All`), which removes that Gmail label, such as Inbox. A mapped archive folder always takes precedence. Other providers still fail with `No archive folder is configured` until you map one.

## Change one remote message

Use the public message `id` and source `folderId` from `message get` or `conversation messages`. The API resolves that exact active provider placement inside the mailbox; provider placement UUIDs are never public selectors. Additive commands preserve unrelated concurrent state:

```bash
cld --json mail message read <message-id> --folder <folder-id> --wait
cld --json mail message unread <message-id> --folder <folder-id> --wait
cld --json mail message star <message-id> --folder <folder-id> --wait
cld --json mail message unstar <message-id> --folder <folder-id> --wait
cld --json mail message keyword add \
  <message-id> \
  CloudReviewed \
  --folder <folder-id> \
  --wait
cld --json mail message keyword remove \
  <message-id> \
  CloudReviewed \
  --folder <folder-id> \
  --wait
```

The Mail UI calls the standard `\Flagged` state **Flag**. The message commands use `star` and `unstar` for that state, and the conversation commands use `flag` and `unflag`. All of them change only that flag and preserve unrelated provider flags.

`message flags` remains available as a low-level exact replacement for diagnostics. It replaces the complete provider flag set, so prefer additive commands for normal operation:

```bash
cld --json mail message flags \
  <message-id> \
  --folder <folder-id> \
  --flag "\\Seen" \
  --flag "\\Flagged"
```

Copy or move one remote placement:

```bash
cld --json mail message copy \
  <message-id> \
  --source <folder-id> \
  --destination <folder-id>
cld --json mail message move \
  <message-id> \
  --source <folder-id> \
  --destination <folder-id>
```

Remote deletion uses the provider's safe UID operation and requires confirmation:

```bash
cld mail message delete <message-id> --folder <folder-id> --yes
```

## Change a conversation in one folder

The everyday commands `archive`, `rm`, `mv`, `read`, `unread`, `flag`, and `unflag` in [Mail CLI](mail.md#triage-conversations) change every current message placement of a conversation in one source folder, the Inbox unless `--in` names another. Junk and provider keywords use the same model:

```bash
cld --json mail conversation junk <conversation-id> --wait
cld --json mail conversation not-spam <conversation-id> --wait
cld --json mail conversation keyword add <conversation-id> --keyword FollowUp --in "Support:Projekte / 2025" --wait
cld --json mail conversation keyword remove <conversation-id> --keyword FollowUp --wait
```

`conversation not-spam` acts on the Junk folder unless `--in` names another. Archive, Trash, Junk, and Inbox resolve through effective folder roles. The source folder matters because one conversation may have placements in several provider folders.

## Download attachments and create public links

Download a complete mirrored attachment or an explicit byte range:

```bash
cld --json mail attachment download <message-id> <attachment-id> --out attachment.bin
cld --json mail attachment download \
  <message-id> \
  <attachment-id> \
  --offset 0 \
  --length 1048576 \
  --out first-megabyte.bin
```

Create a revocable public link for a mirrored message attachment or draft attachment. Passwords are accepted only from stdin or a file:

```bash
cld --json mail attachment link create \
  <message-id> \
  <attachment-id> \
  --source message \
  --expires-at <ISO-timestamp> \
  --max-downloads 10
cld --json mail attachment link create \
  <draft-id> \
  <attachment-id> \
  --source draft \
  --password-stdin
cld --json mail attachment link list
cld mail attachment link revoke <link-id> --yes
```

Public links expose only the selected attachment and remain independent from mailbox access. Revoke links that should no longer work.

## Two-account smoke test

Use a unique marker for every run and keep both mailbox ids explicit:

1. Configure and verify mailbox A and mailbox B.
2. Send A to B with `--undo 0 --wait` and the marker in the exact subject.
3. Queue B sync and use `message wait` for the marker.
4. Read the message and its conversation with `show` and `cat`, then reply B to A with `reply <conversation-id>` and `send <draft-id> --undo 0 --wait`.
5. Queue A sync and verify that the reply appears in the same conversation.
6. Create a uniquely named provider folder, hide and show it in Cloud navigation, unsubscribe, resubscribe, rename, and delete it after confirming it is empty.
7. Test additive `read`, `flag`, and keyword state, and a role-based `archive`, using discovered folder paths.
8. Send a known attachment, download it from the receiving mailbox, and compare its bytes with the source.
9. Test Undo Send with a second marker and `command cancel`.

Do not automatically delete provider mail after the run. The marker keeps test messages easy to inspect or remove later with explicit approval.

## Command map

| Area | Commands |
| --- | --- |
| Health | `status`, `mailbox wait`, `operator status`, `admin operations` |
| Access recovery | `admin mailbox list|get`, `admin mailbox access list|search-principals|grant|set|revoke` |
| Providers | `provider discover|list|add|replace|revoke`, `binding list|attach|verify`, `identity list|add|setup-default|configure|verify|disable`, `identity transport set|remove` |
| Maintenance | `sync`, `sync folder`, `rediscover`, `repair folder|hydration`, `operator run` |
| Storage | `admin storage show|reconcile` |
| Folders | `folders`, `folder create|rename|delete|subscribe|unsubscribe|show|hide`, `folder role set|clear` |
| Message state | `message flags|read|unread|star|unstar`, `message keyword add|remove`, `message copy|move|delete` |
| Conversation provider actions | `conversation read|unread|star|unstar|archive|trash|junk|move` |
| Attachments | `attachment download`, `attachment link create|list|revoke` |
