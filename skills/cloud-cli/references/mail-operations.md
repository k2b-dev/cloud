# Mail operations

Read this reference for provider credential lifecycle, discovery, synchronization, repair, remote message changes, attachment delivery, and platform observability. Start with [Mail CLI](mail.md) for normal mailbox setup and collaboration.

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

Queue a whole-mailbox sync or one canonical folder:

```bash
cld --json mail sync --wait --timeout-seconds 300
cld --json mail sync folder <folder-id> --wait --timeout-seconds 300
```

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

Use rebuild actions only after diagnostics show the corresponding projection is incomplete. `reconcile`, `retry`, and `cancel` require the target durable command id.

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

The Mail UI calls the standard `\Flagged` state **Flag**. The CLI uses `star` and `unstar` for the same state. Both commands change only that flag and preserve unrelated provider flags.

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

Apply the same action to every current message placement of a conversation in one source folder. Archive, Trash, and Junk resolve through effective folder roles:

```bash
cld --json mail conversation read <conversation-id> --source <folder-id> --wait
cld --json mail conversation unread <conversation-id> --source <folder-id> --wait
cld --json mail conversation star <conversation-id> --source <folder-id> --wait
cld --json mail conversation unstar <conversation-id> --source <folder-id> --wait
cld --json mail conversation archive <conversation-id> --source <folder-id> --wait
cld --json mail conversation trash <conversation-id> --source <folder-id> --wait
cld --json mail conversation junk <conversation-id> --source <folder-id> --wait
cld --json mail conversation move \
  <conversation-id> \
  <destination-folder-id> \
  --source <folder-id> \
  --wait
```

The source folder is required because one conversation may have placements in multiple provider folders.

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
4. Read the message and its conversation, then reply B to A with `--conversation`, `--intent reply`, and `--source-message`.
5. Queue A sync and verify that the reply appears in the same conversation.
6. Create a uniquely named provider folder, hide and show it in Cloud navigation, unsubscribe, resubscribe, rename, and delete it after confirming it is empty.
7. Test additive read, star, and keyword state and a role-based conversation move using discovered folder ids.
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
