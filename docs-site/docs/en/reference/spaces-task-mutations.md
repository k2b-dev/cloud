---
title: Retry and concurrent Spaces task writes
navTitle: Spaces task writes
section: Reference
order: 1260
description: Change assignees and titles safely and retry task creation without duplicates.
tags: [spaces, api, cli, concurrency]
updated: 2026-11-07
---

# Retry and concurrent Spaces task writes

All routes below use public Space, column and item IDs. They require current
Space write access. The typed Spaces browser client exposes the same request
and response fields.

## Change individual assignees

Send `PATCH /api/spaces/:spaceId/items/:itemId` with
`{"addAssigneeIds":["<account-uuid>"],"removeAssigneeIds":[]}`. Additions and
removals apply to the current list under the item's write lock. Independent
concurrent changes are kept. Adding someone already assigned or removing
someone absent has no further effect. Assignees must have access to the Space;
a task has at most 100 assignees.

Use either these deltas or `assigneeIds`, the existing whole-list replacement.
Mixing them or adding and removing the same ID returns 400. Removing a claim
holder keeps the existing claim-ID and takeover checks. The response is the
updated item.

CLI: `cld spaces set Item01 --add-assignee me --remove-assignee <account>`.
Both flags are repeatable. `assign`, `--assignee` and `--clear-assignees` keep
their explicit replacement behavior. The `spaces.task.update` capability uses
`addAssigneeIds` and `removeAssigneeIds` too.

## Check the title you edited

Send `PATCH /api/spaces/:spaceId/items/:itemId` with
`{"title":"Next","expectedTitle":"Original"}`. The server compares the exact
previous title under the write lock. A mismatch returns HTTP 409 with
`code: "TITLE_CONFLICT"` and applies none of the request's changes. Read the
current item, keep the person's draft and let them review the current title
before retrying. A successful response is the updated item.

`expectedTitle` remains optional in the REST API for existing integrations.
The web editor sends it. A `spaces.task.update` title edit requires it so an
approval remains tied to the title the caller read.

CLI: `cld spaces set Item01 --title "Next" --expected-title "Original"`.
When the flag is omitted, the CLI uses the title it resolves before writing.

## Retry creation after an uncertain response

Send `POST /api/spaces/:spaceId/items` with the usual create fields plus
`requestKey`, a nonempty string of at most 200 characters. Generate one key per
logical create and retain it with the unchanged request until the result is
confirmed. The server stores the receipt in the same transaction as the task,
activity and outbox. Concurrent or later retries by the same actor return the
first item response for **24 hours**, including its original values. Reading
the item afterwards returns its current values. The same key from a different
actor identifies a separate create.

A changed request with the same key returns HTTP 409 and
`code: "IDEMPOTENCY_CONFLICT"`. If the created item was deleted or moved out of
the Space, the replay returns HTTP 409 and `code: "CREATE_RESULT_GONE"`.
Replays require current Space write access. After 24 hours the key may create
a new item; expired receipts are purged by an hourly maintenance job in bounded batches.
Unkeyed REST requests retain their existing behavior and may duplicate on retry.

CLI: `cld spaces add "Roadmap:Write notes" --request-key <stable-key>`.
Without that flag, each CLI invocation generates a new key. Web create forms
keep the key for a retry of unchanged input. The `spaces.task.create` Action
uses the invocation's required idempotency key; repeat the same key and input.

## Use Actions from background work

`spaces.task.create`, `spaces.event.create`, `spaces.task.update`,
`spaces.item.reference.add`, `spaces.comment.create`, and `spaces.item.tags.set`
declare an explicit `silent: "shared"` policy.
Background callers still need current write access to the target Space and an
authorized mandate. The policy grants no access. Interactive callers can
remember approval for that Space, or for the item when adding comments.

Plain task and event creation, linking an existing Cloud resource, adding a
comment, and replacing item tags can run under that policy. Comments keep their
required idempotency key and are authored by the calling person or eligible
service account. Comment editing and deletion keep their existing policies.
Creation with a template always asks because the template
can supply additional fields. Creation with assignees and any task update that
supplies an assignee replacement, addition, or removal always ask because they
affect other people. Those calls cannot run unattended, even with a remembered
Space approval. Template changes and deletion keep their existing approval
requirements. Task title updates still require `expectedTitle`.

Reviews are available in English and German and retain the complete proposed
fields, including long descriptions, in the review's content view.

## React to Spaces events

Spaces declares `comment.created`, `item.updated`, and `item.due` alongside
`item.created` and `item.completed`. Every event has a Space as its place and
only public resource references. `item.updated` adds a bounded `changed` list
(`assignees`, `due`, `status`); the event contains no field values or content.
Read the current item or comment through its permission-aware capability.

No-op writes emit no update. Changing assignees through `task.update`, including
add/remove deltas, uses the same event path as API and CLI writes. The existing
`involves_people` review still requires confirmation for these calls.

Due events fire once per task and due value, with a global limit of four per
minute. All-day deadlines use midnight in `app.timezone`. See
[Built-in resource events](/en/docs/platform/app-events#built-in-resource-events)
for eligibility, retries, overdue tasks, and delivery authorization.
