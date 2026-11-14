---
title: Assistant chat workspace storage
navTitle: Chat workspace storage
section: Operations
order: 955
description: Migration, ownership, validation and conflict handling for saved Assistant chat tabs.
tags: [assistant, upgrades, chat]
updated: 2026-11-14
---

# Assistant chat workspace storage

Assistant's tabs API stores open tabs, their Panes arrangement and the front
tab for each chat and person in Postgres. A client can restore the saved state
on another device. This backend contract does not change the chat interface by
itself.

The normal Assistant setup creates `assistant.chat_workspaces` idempotently.
Run that setup before serving the new tabs routes. Include the table in database
backups; deleting the conversation or person removes their workspace through
foreign-key cascades. No additional service or configuration is required.

`GET /api/assistant/workspace/conversations/:conversationId/tabs` returns
`{ state, revision }`. The path uses the chat's short ID. Both GET and PUT
require a user-backed access subject and return 404 for another person's chat.
An unsaved workspace returns `{ tabs: [], layout: null, front: null }` with
revision `0`.

PUT to the same path with `{ state, revision }`. Success returns
`{ conflict: false, revision }`; stale writes return
`{ conflict: true, state, revision }` with the current server snapshot. Reconcile
that snapshot before retrying. Empty tabs delete the row and reset revision to
`0`; a later save starts at `1` again. Revisions compare existing rows, so they
do not identify workspace generations across deletion and recreation.

The contract in `packages/assistant/src/chat-workspace.ts` accepts at most 24
tabs and 32 KiB of serialized UTF-8 state. Each tab has a unique short `id`, a
unique opaque `key`, a title and optional pinning. Layouts pass the public
`parsePanesLayout` validator and contain every tab ID exactly once. Use IDs
starting with a letter and containing letters, digits, underscores or hyphens
to satisfy the current Panes validator. A null layout leaves arrangement to
the client; `front` is null or an open tab ID.

The browser client exposes `assistantApi.getChatTabs` and
`assistantApi.saveChatTabs`. Save after debounced workspace changes. This API
does not run on the per-message or per-keystroke path.
