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

## Track implementation work and handoffs

Use flat tasks and blockers to describe the work. Keep a stable Space ID in the
repository's `AGENTS.md` and pass `--space <id>` explicitly when switching
between repositories. `spaces use` changes the default for the whole CLI
profile, not just the current checkout.

```bash
cld spaces items --space Space1 --ready --assigned-to unassigned --sort priority --ascending --json
cld spaces item --space Space1 Item01 --context --json
cld spaces claim --space Space1 Item01 --claim-id <worker-uuid> --json
cld spaces progress --space Space1 Item01 --claim-id <worker-uuid> --file handoff.md
cld spaces done --space Space1 Item01 --claim-id <worker-uuid> --file result.md --commit a1b2c3d
cld spaces work --space Space1 Item01 --json
```

Generate a fresh UUID for each worker's claim, and retain it for progress,
completion, and release. Retrying the same claim with the same identity and ID
returns that claim. A different claim gets a conflict, even under the same
user. Claims do not expire and do not prevent ordinary collaborative edits.
Only open, unblocked tasks can be claimed. Release a claim before transferring
the task or completing it from the web interface. Completion with the correct
claim clears it automatically.

Use `spaces release ... --claim-id <id>` when stopping work. An administrator
can recover an abandoned claim with `--force`, using the exact ID returned by
`spaces work`; a changed claim is rejected. Claims are coordination identifiers,
not credentials. Authorization still requires current resource access.

`progress` saves the latest full handoff note. `done --result`, `--file` or
`--stdin` saves a completion result atomically with completion; an optional
`--commit` records a 7–64 digit hexadecimal SHA and requires a result. Include
what changed, decisions, remaining work and verification evidence. Notes are
limited to 5,000 characters. A failed result write cannot leave the task done.
Reopening preserves the last result. Previous progress and completion notes
remain in `spaces activity ... --json`; follow `nextCursor` with `--cursor`.
Service accounts can use progress, results, and claims under their own identity;
comments continue to require a user-backed actor.

`item --context` includes the full description, work state, attachments,
checklist, resource references, blockers, and pages of comments and dependent
tasks. Follow `comments.hasNext` and `blocks.hasNext`; read further pages through
`spaces comments` and `spaces blocks` with `--page` and `--page-size`. These page
commands return objects containing `items`, `page`, `perPage`, `total` and
`hasNext`, including in JSON/JSONL. Each page is a fresh read, not a frozen
snapshot; avoid replacing a description from an earlier read after another
worker has edited it.

`items --ready` means open tasks without active blockers; it is not a claim or
promise that another worker has not taken the task. `--blocked` selects open
blocked tasks. Additional filters are `--assigned-to`, `--assignee`, `--priority`,
`--column`, `--tag`, `--deadline` and `--activity`. `--assigned-to me` requires a
user-backed actor. Lists support `--sort`, `--ascending`, `--page` and
`--page-size`. Use `update-item --clear-tags` or `--clear-assignees` to remove
all selections; these cannot be combined with replacement values.

```bash
cld spaces checklist list --space Space1 Item01 --json
cld spaces checklist add --space Space1 Item01 --label "Run focused tests"
cld spaces checklist update --space Space1 Item01 Check1 --completed
cld spaces checklist update --space Space1 Item01 Check1 --reopen
cld spaces checklist delete --space Space1 Item01 Check1 --yes
cld spaces references list --space Space1 Item01 --json
cld spaces references add --space Space1 Item01 --type notebooks.note --id Note01 --label "Design"
cld spaces references remove --space Space1 Item01 --type notebooks.note --id Note01 --yes
```

Capabilities expose the same work state through `task.work.read`, `task.claim`,
`task.release`, `task.progress` and the extended `task.set-completed` input.
Read the work result after completion when you need the persisted evidence;
completion retains its existing task response. No hierarchy is introduced.

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
| Agent work | `work`, `claim`, `release`, `progress`, `activity`, `item --context` |
| Checklists | `checklist list`, `checklist add`, `checklist update`, `checklist delete` |
| References | `references list`, `references add`, `references remove` |
| Calendar | `calendar`, `overlap`, `invitation context`, `invitation draft`, `mail event-source` |
| Access | `access list`, `access grant`, `access set`, `access revoke`, `access search-principals` |
