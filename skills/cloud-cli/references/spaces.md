# Spaces CLI

## What Spaces is

Spaces is a shared-work app for tasks, events, lists, assignees, comments, and lightweight planning in one work area.

Use `cld spaces` to organize work in spaces, manage items, add comments, and inspect calendar conflicts. It requires access to the selected space.

## Select a space

```bash
cld spaces list --json
cld spaces use "Roadmap"
cld spaces current
cld spaces get --json
```

Spaces, items, columns, tags, comments, and wormholes use immutable six-character IDs in CLI output, APIs, links, and calendar exports. Internal database UUIDs are not accepted as resource references.

Most item commands accept a space short ID or exact name first, or `--space <short-id-or-exact-name>`. Item commands likewise accept an item short ID or exact title. Persist the returned `id` in automation; names and titles are convenient selectors but can become ambiguous. Set a default space when a series of commands works on the same space.

## Work with items

```bash
cld spaces items "Roadmap" --status active --query "release" --json
cld spaces item "Roadmap" "Publish release notes" --json
cld spaces add-item "Roadmap" "Publish release notes" --column "To do" --deadline 2026-07-20 --estimate-minutes 90
cld spaces update-item "Roadmap" "Publish release notes" --priority high --estimate-minutes 60
cld spaces update-item "Roadmap" "Publish release notes" --clear-estimate
cld spaces done "Roadmap" "Publish release notes"
```

Use `cld spaces get <space> --json` to see the available columns and tags before creating or moving an item. Repeat `--tag` or `--assignee` to select several values. Pass long descriptions through `--file` or `--stdin`.

## Attach images to tasks

```bash
cld spaces attachments "Roadmap" "Fix mobile dialog" --json
cld spaces add-attachment "Roadmap" "Fix mobile dialog" --file ./bug.png
cld spaces download-attachment "Roadmap" "Fix mobile dialog" File01 --output ./bug.webp
cld spaces delete-attachment "Roadmap" "Fix mobile dialog" File01 --yes
```

`cld spaces item ... --json` includes the task's attachment metadata. CLI uploads use the selected file as-is and therefore remain subject to the 10 MB stored-file limit. Attachment preview and download links returned by `spaces.item.read` require the same current read access as the task; they are not public links.

## Manage task dependencies

```bash
cld spaces blockers "Roadmap" "Publish release notes" --json
cld spaces blocks "Roadmap" "Approve release" --json
cld spaces block "Roadmap" "Publish release notes" "Approve release"
cld spaces unblock "Roadmap" "Publish release notes" "Approve release"
```

`block` reads as “the first task is blocked by the second task.” Both tasks must belong to the same Space, and dependencies cannot form a cycle. `done` fails while a task still has an active blocker; complete or remove every active blocker first.

## Comments and calendar

```bash
cld spaces comments "Roadmap" "Publish release notes" --json
cld spaces comment "Roadmap" "Publish release notes" --content "Draft is ready for review."
cld spaces calendar --space "Roadmap" --from 2026-07-01 --to 2026-07-31 --json
cld spaces overlap --space "Roadmap" --from 2026-07-20T10:00:00Z --to 2026-07-20T11:00:00Z --json
```

`overlap` checks a proposed time range. Use `--exclude-item <id>` when checking a time change for an existing item.

## Send event invitations through Mail

Spaces generates iCalendar REQUEST, update, and CANCEL payloads from the canonical event. Event URLs and UIDs use the immutable Space and item short IDs. Mail only supplies an authorized verified sender and an editable delivery draft; Mail mailbox, identity, draft, and idempotency IDs remain UUIDs.

```bash
cld --json spaces invitation context "Roadmap" "Launch review"
cld --json spaces invitation draft "Roadmap" "Launch review" \
  --mailbox <mailbox-id> \
  --to alex@example.org \
  --to sam@example.org \
  --idempotency-key 5d3a802d-d9e1-46e4-9779-4823c55c6c04
cld --json spaces invitation draft "Roadmap" "Launch review" \
  --mailbox <mailbox-id> \
  --to alex@example.org \
  --cancel \
  --idempotency-key b534fe9e-60db-4b23-a35c-5844ab984ec4
cld --json spaces mail event-source "Roadmap" <mailbox-id> <message-id>
```

`invitation context` includes the latest draft failure for operator diagnosis. Reuse the same idempotency key only when retrying the same request. Relevant event changes receive a newer sequence when you explicitly create the next update draft.

## Access

```bash
cld spaces access list "Roadmap" --json
cld spaces access search-principals "Editors" --kind group --json
cld spaces access grant "Roadmap" --group "Editors" --permission write
cld spaces access set "Roadmap" --user ada.lovelace --permission admin
```

`access set` updates an existing direct grant or creates it. Read `cld spaces access revoke --help` before removing access; revocation requires `--yes`.

## Complete command catalogue

Run `cld spaces <command> --help` for flags and argument order.

| Area | Commands |
| --- | --- |
| Spaces | `list`, `use`, `current`, `get`, `create` |
| Items | `items`, `item`, `add-item`, `update-item`, `blockers`, `blocks`, `block`, `unblock`, `done`, `reopen` |
| Attachments | `attachments`, `add-attachment`, `download-attachment`, `delete-attachment` |
| Comments | `comments`, `comment` |
| Calendar | `calendar`, `overlap`, `invitation context`, `invitation draft`, `mail event-source` |
| Access | `access list`, `access grant`, `access set`, `access revoke`, `access search-principals` |
