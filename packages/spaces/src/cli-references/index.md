# Spaces CLI

## What Spaces is

Spaces is a shared-work app for tasks, events, workflow columns, assignees, comments, and lightweight planning in one work area.

Use `cld spaces` to list and change work, track agent handoffs, manage task dependencies, and check calendar conflicts. Every command needs access to the space it touches.

## Contents

- [Address spaces and items](#address-spaces-and-items)
- [List and read work](#list-and-read-work)
- [Add and change items](#add-and-change-items)
- [Track implementation work and handoffs](#track-implementation-work-and-handoffs)
- [Dependencies](#dependencies)
- [Comments, checklists, references, links, and attachments](#comments-checklists-references-links-and-attachments)
- [Calendar and invitations](#calendar-and-invitations)
- [Access](#access)
- [Command reference](#command-reference)
- [JSON contracts](#json-contracts)

## Address spaces and items

Spaces, items, columns, tags, comments, and attachments have immutable six-character IDs. Internal database UUIDs are not accepted as resource references.

An item argument accepts exactly two forms:

| Form | Example | Resolution |
| --- | --- | --- |
| Item ID | `Item01` | Always unique across spaces |
| `<space>:<title>` | `"Roadmap":"Publish release notes"` | Space by ID or exact name, then the item with exactly this title |

A space argument is a space ID or exact name. `show` takes `<space>:` (empty title) for the space itself.

- Titles are matched exactly and case-sensitively, never by prefix or search.
- When a space name or item title matches several resources, the command fails with every candidate as `path (id)`. Nothing is guessed; retry with one of the IDs.
- A space name that contains `:` cannot be written as an address; use its ID.
- Occurrence overrides of a recurring event share the series title and are addressed by ID only.
- There is no default space. Keep a repository's Space ID in its `AGENTS.md` and pass it in every address, for example `Space1:"Fix login"`.

Persist returned `id` values in automation; titles change and can collide.

## List and read work

```bash
cld spaces ls --json
cld spaces ls "Roadmap" --json
cld spaces ls "Roadmap" --mine --due-before 2026-10-01 --json
cld spaces ls Space1 --ready --unassigned --sort priority --ascending --json
cld spaces show "Roadmap": --json
cld spaces show "Roadmap":"Publish release notes" --json
cld spaces show Item01 --context --json
```

`ls` without an argument lists your spaces (`--q` filters by name or description). With a space it lists items, `--status active` by default:

| Flag | Selects |
| --- | --- |
| `--status active\|completed\|all` | Completion state |
| `--type all\|task\|event` | Item type |
| `--mine`, `--unassigned`, `--assignee <user-id>` | Assignment; `--mine` needs a user-backed actor |
| `--ready`, `--blocked` | Open tasks without, or with, active blockers |
| `--due overdue\|today\|week\|none` | Deadline window in the application timezone |
| `--due-before <iso\|YYYY-MM-DD>` | Deadline strictly before this instant; a date means its start (UTC) |
| `--inactive` | Open tasks without activity for 30 days |
| `--priority`, `--column`, `--tag` | Repeatable; columns and tags by ID or exact name |
| `--q <text>` | Search in title, description, location, and URL |
| `--sort`, `--ascending`, `--page`, `--per-page` | Order and paging (`--per-page` ≤ 100) |

`--ready` means open and unblocked; it is not a claim. `show <space>:` returns columns and tags with their IDs. `show <item> --context` adds work state, checklist, blockers, a page of dependent tasks, references, links, and a page of comments; follow `comments.hasNext` and `blocks.hasNext` with `--page` and `--per-page`, or read further pages through `comments list` and `deps`. Pages are fresh reads, not a frozen snapshot.

## Add and change items

```bash
cld spaces add "Roadmap":"Publish release notes" --deadline 2026-10-20 --estimate-minutes 90 --assignee me
cld spaces add "Roadmap":"Launch review" --starts-at 2026-10-20T10:00:00Z --ends-at 2026-10-20T11:00:00Z
cld spaces set "Roadmap":"Publish release notes" --priority high --from notes.md
cld spaces set Item01 --clear-tags --clear-assignees --clear-estimate
cld spaces mv Item01 "In progress"
cld spaces done Item01
cld spaces reopen Item01
cld spaces assign Item01 me
cld spaces assign Item01 ada.lovelace
cld spaces assign Item01 none
cld spaces due Item01 2026-10-20
cld spaces due Item01 none
cld spaces rm Item01 --yes
cld spaces create "Hiring" --description "Open roles"
```

- `add` creates a task; `--starts-at` and `--ends-at` make it an event. Without `--column` it lands in the space's first column.
- `set` changes only the fields you pass. `--description <text>` or `--from <file|->` replaces the description (5,000 characters at most). Repeat `--tag` and `--assignee` to set several; they replace the current selection. `--clear-*` cannot be combined with new values.
- Users are `me`, a user ID, or a username with access to the space. `assign` replaces all assignees with one person, or none.
- Dates accept ISO datetimes or `YYYY-MM-DD`. A date-only deadline or end means the end of that day (UTC); a start means its beginning.
- `mv` moves an item to another column of its own space. Moving between spaces is done with wormholes in the web interface.
- `done` fails while the task has an active blocker. `rm` needs `--yes`.

## Track implementation work and handoffs

Use flat tasks and blockers to describe work, and keep the repository's Space ID in its `AGENTS.md`.

```bash
cld spaces ls Space1 --ready --unassigned --sort priority --ascending --json
cld spaces show Item01 --context --json
cld spaces claim Item01 --claim-id <worker-uuid> --json
cld spaces progress Item01 --claim-id <worker-uuid> --from handoff.md
cld spaces done Item01 --claim-id <worker-uuid> --from result.md --commit a1b2c3d
cld spaces work Item01 --json
cld spaces activity Item01 --json
```

Generate a fresh UUID for each worker's claim and keep it for progress, completion, and release. Retrying the same claim with the same identity and ID returns that claim; a different claim gets a conflict, even under the same user. Claims do not expire and do not prevent ordinary collaborative edits. Only open, unblocked tasks can be claimed. Release a claim before transferring the task or completing it from the web interface; completion with the correct claim clears it.

Use `release <item> --claim-id <id>` when stopping work. An administrator can recover an abandoned claim with `--force`, using the exact ID returned by `work`; a changed claim is rejected. Claims coordinate work; they are not credentials.

`progress` saves the latest full handoff note (`--content` or `--from`). `done --result` or `--from` saves a completion result atomically with completion; `--commit` records a 7–64 digit hexadecimal SHA and needs a result. Include what changed, decisions, remaining work, and verification evidence. Notes are limited to 5,000 characters. A failed result write cannot leave the task done, and reopening keeps the last result. Earlier notes stay in `activity`; follow `nextCursor` with `--cursor`. Service accounts can record progress, results, and claims under their own identity; comments need a user-backed actor.

## Dependencies

```bash
cld spaces deps "Roadmap":"Publish release notes" --json
cld spaces deps "Roadmap":"Publish release notes" --add "Roadmap":"Approve release"
cld spaces deps Item01 --rm Block1
```

`deps <item>` shows both directions: `blockers` must be done first, `blocks` are tasks waiting for this one. `--add <item>` makes the given task a blocker of `<item>`; `--rm <item>` removes it. Both tasks must belong to the same space, and dependencies cannot form a cycle. The output after a change is the updated view.

## Comments, checklists, references, links, and attachments

```bash
cld spaces comments list Item01 --json
cld spaces comments add Item01 --content "Draft is ready for review."
cld spaces comments update Item01 Cmt001 --from comment.md
cld spaces comments delete Item01 Cmt001 --yes
cld spaces checklist list Item01 --json
cld spaces checklist add Item01 "Run focused tests"
cld spaces checklist add Item01 "Read the issue" --completed
cld spaces checklist update Item01 Check1 --completed
cld spaces checklist update Item01 Check1 --reopen --label "Run all tests"
cld spaces checklist delete Item01 Check1 --yes
cld spaces references list Item01 --json
cld spaces references add Item01 --type notebooks.note --id Note01 --label "Design"
cld spaces references delete Item01 --type notebooks.note --id Note01 --yes
cld spaces links ls Item01 --json
cld spaces links add Item01 https://github.com/k2b-dev/cloud/issues/263
cld spaces links add Item01 https://example.org/spec --label "Spec"
cld spaces links rm Item01 https://example.org/spec --yes
cld spaces attachments list Item01 --json
cld spaces attachments add Item01 ./bug.png
cld spaces attachments download Item01 broken-dialog.webp --out ./bug.webp
cld spaces attachments delete Item01 File01 --yes
```

An item's links are its Cloud references plus external URLs. `references` manages Cloud resources by type and ID; `links` manages external `http(s)` URLs (at most 20 per item, 512 characters each) and `links ls` returns both groups. A GitHub issue or pull request URL carries a `preview` with `repo`, `number`, `type`, `title`, and `state` (`open`, `closed`, `merged`) once the server has fetched it; the preview is display-only, cached briefly, and `null` when it is not yet known, the repository is private without a Space token, or the link is not a GitHub issue. Link a task to its issue instead of restating the issue in the description. A Space administrator stores a GitHub token for private repositories in the Space settings; the CLI does not manage it.

Comments can be edited and deleted by their author for a short time. Attachments are task images; `attachments add` uploads the file as-is, subject to the 10 MB stored-file limit. An attachment is named by ID or file name; a file name used twice fails with both IDs. Preview and download links returned by `spaces.item.read` need the same read access as the task; they are not public links.

## Calendar and invitations

```bash
cld spaces calendar 2026-10-01 2026-10-31 --json
cld spaces calendar 2026-10-01 2026-10-31 --space "Roadmap" --json
cld spaces overlap 2026-10-20T10:00:00Z 2026-10-20T11:00:00Z --exclude Item01 --json
cld --json spaces invitation context "Roadmap":"Launch review"
cld --json spaces invitation draft "Roadmap":"Launch review" \
  --mailbox <mailbox-id> --identity <identity-id> \
  --to alex@example.org --to sam@example.org \
  --idempotency-key 5d3a802d-d9e1-46e4-9779-4823c55c6c04
cld --json spaces invitation draft Item01 --mailbox <mailbox-id> --identity <identity-id> \
  --to alex@example.org --cancel --idempotency-key b534fe9e-60db-4b23-a35c-5844ab984ec4
```

`calendar` and `overlap` take a start and an end; a date-only end includes that whole day. `overlap` checks a proposed time range; `--exclude <item>` ignores the item being moved.

Spaces generates iCalendar REQUEST, update, and CANCEL payloads from the canonical event. Mail only supplies an authorized verified sender and an editable delivery draft; Mail mailbox, identity, and idempotency IDs stay UUIDs. `invitation context` includes the latest draft failure. Reuse an idempotency key only to retry the same request.

## Access

```bash
cld spaces access list "Roadmap" --json
cld spaces access search-principals "Editors" --kind group --json
cld spaces access grant "Roadmap" --group "Editors" --permission write
cld spaces access set "Roadmap" --user ada.lovelace --permission admin
cld spaces access revoke "Roadmap" --user ada.lovelace --yes
```

`access set` updates an existing direct grant or creates it. Revocation needs `--yes`.

## Command reference

Run `cld spaces <command> --help` for every flag.

| Area | Commands |
| --- | --- |
| Browse | `ls [space]`, `show <item\|space:>` |
| Spaces | `create <name>` |
| Items | `add <space:title>`, `set <item>`, `mv <item> <column>`, `rm <item>` |
| Quick actions | `done`, `reopen`, `assign <item> <user\|me\|none>`, `due <item> <date\|none>` |
| Dependencies | `deps <item> [--add <item>] [--rm <item>]` |
| Agent work | `work`, `claim`, `release`, `progress`, `activity`, `show --context` |
| Comments | `comments list`, `add`, `update`, `delete` |
| Attachments | `attachments list`, `add`, `download`, `delete` |
| Checklists | `checklist list`, `add`, `update`, `delete` |
| References | `references list`, `add`, `delete` |
| Links | `links ls`, `add <item> <url>`, `rm <item> <url>` |
| Calendar | `calendar <start> <end>`, `overlap <start> <end>`, `invitation context`, `invitation draft` |
| Access | `access list`, `grant`, `set`, `revoke`, `search-principals` |

Every command takes `--json` (and `--jsonl` for lists), destructive commands need `--yes`, and long text comes from `--from <file|->`. A command exits `0` only when it did everything it was asked to do.

## JSON contracts

| Command | `--json` output |
| --- | --- |
| `ls` | Array of spaces `{ id, name, description, color, createdAt, updatedAt, … }` |
| `ls <space>` | `{ items, total, page, pageSize, totalPages }` with full items |
| `show <space>:` | Space with `columns` and `tags` |
| `show <item>` | Item; tasks add `attachments` |
| `show <item> --context` | Item plus `attachments`, `work`, `checklist`, `blockers`, `blocks` (page), `references`, `links`, `comments` (page) |
| `add`, `set`, `mv`, `done`, `reopen`, `assign`, `due` | The resulting item |
| `rm` | `{ deleted: { id, spaceId, title } }` |
| `deps` | `{ item: { id, title }, blockers, blocks }`; `blocks` is a page `{ items, page, perPage, total, hasNext }` |
| `comments list` | Page `{ items, page, perPage, total, hasNext }` |
| `comments add`, `comments update` | The comment |
| `comments delete` | `{ deleted: { id, itemId } }` |
| `links ls` | `{ references, links }`; a link is `{ url, label, createdAt, preview }` |
| `links add` | The link with `preview: null` |
| `links rm` | `{ deleted: boolean }` |
| `attachments list` | Array of attachments `{ id, filename, mimeType, sizeBytes, kind, createdAt }` |
| `attachments download` | `{ attachment, out }` |
| `attachments delete` | `{ deleted: attachment }` |
| `work`, `claim`, `release`, `progress` | Work state `{ claim, progress, result }` |
| `calendar`, `overlap` | Arrays of calendar or overlap entries |

An item has `id`, `spaceId`, `columnId`, `title`, `description`, `startsAt`, `endsAt`, `deadline`, `estimatedDurationMinutes`, `priority`, `completedAt`, `activeBlockerCount`, `assignees`, `tags`, and timestamps. Errors print `{"error":{"message","status","exitCode"}}` with `--json`; an ambiguous address is status `409`.
